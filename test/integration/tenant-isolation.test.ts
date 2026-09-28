import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, RouteOptions } from 'fastify'
import { db } from '@shared/db.js'
import { sessions, users } from '@modules/auth/auth.schema.js'
import { memberships } from '@modules/membership/membership.schema.js'
import { invites } from '@modules/invite/invite.schema.js'
import { classes } from '@modules/class/class.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { reports } from '@modules/report/report.schema.js'
import {
  createEvaluationJob,
  createMembership,
  createTestClass,
  createTestExam,
  createTestInvite,
  createTestSession,
  createTestUser,
  enrollStudent,
  linkExamToClass,
  seedTenantWithUsers,
} from '../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation, over HTTP (multi-tenancy audit F-8).
//
// Every other isolation test in this suite calls a service directly and hands
// it the tenant. That proves the service filters correctly, and proves nothing
// about the route: a deleted `tenantMiddleware`, a handler reading the global
// role (F-2), or a route that never resolved a tenant at all (F-3) are all
// invisible from there. These tests go through `buildApp()` and `app.inject()`,
// so the preHandler chain, the slug resolution and the handler wiring are the
// thing under test.
//
// Two layers:
//   1. Structural — every /tenant/* route carries authenticate → tenantMiddleware
//      → requireTenantRole, read off the real route table. Catches a new route
//      that forgets a guard without anyone writing a test for it.
//   2. Behavioural — the audit's attack matrix, one request per row.
// ─────────────────────────────────────────────────────────────────────────────

// Capture every route as Fastify registers it. `buildApp` owns the instance, so
// the hook is attached by wrapping the factory rather than by editing app.ts.
const routes = vi.hoisted(() => [] as RouteOptions[])

vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>()
  const factory = ((opts: Parameters<typeof mod.default>[0]) => {
    const app = mod.default(opts)
    app.addHook('onRoute', (route) => {
      routes.push(route)
    })
    return app
  }) as typeof mod.default
  return { ...mod, default: factory }
})

// The global ioredis mock in setup.ts has no connection state, so hand the rate
// limiter no Redis at all — it falls back to its in-memory store.
vi.mock('@shared/rate-limit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@shared/rate-limit.js')>()
  return { ...mod, getRateLimitRedis: () => undefined, waitForRateLimitRedis: async () => true }
})

// Bull Board rejects the mocked BullMQ queues outright, and it is not a tenant surface.
vi.mock('@config/bull-board.js', () => ({ registerBullBoard: async () => {} }))

let app: FastifyInstance

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

// ── Request helpers ─────────────────────────────────────────────────────────

/**
 * A real Better Auth session for `userId`, presented the way the ops panel and
 * mobile clients do: as a Bearer token. The bearer plugin turns it back into the
 * session cookie, so `authenticate` runs its normal lookup.
 */
async function signIn(userId: string): Promise<Record<string, string>> {
  const token = crypto.randomUUID().replace(/-/g, '')
  await db.insert(sessions).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return { authorization: `Bearer ${token}` }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

async function call(
  method: Method,
  url: string,
  opts: { as?: Record<string, string>; slug?: string; host?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { ...(opts.as ?? {}) }
  if (opts.slug) headers['x-tenant-slug'] = opts.slug
  if (opts.host) headers.host = opts.host
  return app.inject({
    method,
    url,
    headers,
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  })
}

// ── 1. Structural ───────────────────────────────────────────────────────────

/**
 * /tenant/* routes that deliberately do NOT resolve a tenant from the request.
 * Each needs a reason; an entry that no longer matches a route fails the suite,
 * so this list cannot quietly outlive the exemption it describes.
 */
const TENANT_PREFIX_EXEMPT: Record<string, string> = {
  // The join code names the tenant. useClassJoinCode re-checks that the student
  // holds a membership in the code's tenant before enrolling.
  'GET /tenant/classes/join/:code': 'tenant comes from the class join code',
  'POST /tenant/classes/join/:code': 'tenant comes from the class join code',
  // A preference belongs to a user, not a coaching; mirrored under /tenant so the
  // coaching UI can reach it with a student who has not joined one yet.
  'GET /tenant/notifications/preferences': 'user-scoped',
  'PATCH /tenant/notifications/preferences/:type': 'user-scoped',
}

function routeKeys(route: RouteOptions): string[] {
  const methods = Array.isArray(route.method) ? route.method : [route.method]
  return methods.filter((m) => m !== 'HEAD').map((m) => `${m} ${route.url}`)
}

function guardNames(route: RouteOptions): string[] {
  const chain = [route.onRequest, route.preValidation, route.preHandler].flat().filter(Boolean)
  return (chain as Array<{ name: string }>).map((fn) => fn.name)
}

/** `needles` appear in `haystack` in this order (not necessarily adjacent). */
function inOrder(haystack: string[], needles: string[]): boolean {
  let i = 0
  for (const name of haystack) if (name === needles[i]) i++
  return i === needles.length
}

describe('structural: every /tenant/* route resolves and authorises a tenant', () => {
  const REQUIRED = ['authenticate', 'tenantMiddleware', 'requireTenantRoleGuard']

  const tenantRoutes = () =>
    routes.filter((r) => r.url.startsWith('/tenant/') || r.url === '/tenant')

  it('sees the route table', () => {
    // Guards against the capture silently breaking and every assertion below
    // passing over an empty list.
    expect(tenantRoutes().length).toBeGreaterThan(50)
  })

  it('CRITICAL: authenticate → tenantMiddleware → requireTenantRole on each one', () => {
    const offenders = tenantRoutes()
      .flatMap((route) => routeKeys(route).map((key) => ({ key, guards: guardNames(route) })))
      .filter(({ key }) => !(key in TENANT_PREFIX_EXEMPT))
      .filter(({ guards }) => !inOrder(guards, REQUIRED))
      .map(({ key, guards }) => `${key}  [${guards.join(', ')}]`)

    expect(offenders).toEqual([])
  })

  it('every exemption still names a real route', () => {
    const registered = new Set(routes.flatMap(routeKeys))
    const stale = Object.keys(TENANT_PREFIX_EXEMPT).filter((key) => !registered.has(key))
    expect(stale).toEqual([])
  })

  it('exempt routes still authenticate', () => {
    const unauthenticated = routes
      .flatMap((route) => routeKeys(route).map((key) => ({ key, guards: guardNames(route) })))
      .filter(({ key }) => key in TENANT_PREFIX_EXEMPT)
      .filter(({ guards }) => !guards.includes('authenticate'))
      .map(({ key }) => key)

    expect(unauthenticated).toEqual([])
  })
})

// ── 2. Behavioural ──────────────────────────────────────────────────────────

describe('tenant resolution over HTTP', () => {
  it('401s without a session, before anything tenant-related runs', async () => {
    const a = await seedTenantWithUsers()
    const res = await call('GET', '/tenant/classes', { slug: a.tenant.slug })
    expect(res.statusCode).toBe(401)
  })

  it('400s when no tenant can be resolved', async () => {
    const a = await seedTenantWithUsers()
    const res = await call('GET', '/tenant/classes', { as: await signIn(a.owner.id) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('TENANT_REQUIRED')
  })

  it('404s for a slug that names no coaching', async () => {
    const a = await seedTenantWithUsers()
    const res = await call('GET', '/tenant/classes', {
      as: await signIn(a.owner.id),
      slug: 'no-such-coaching-anywhere',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('TENANT_NOT_FOUND')
  })
})

describe('A-user → A-resource (so the denials below are not vacuous)', () => {
  it('owner reads their own class and exam', async () => {
    const a = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: a.tenant.id, teacherId: a.teacher.id })
    const exam = await createTestExam({ tenantId: a.tenant.id, createdBy: a.teacher.id })
    const as = await signIn(a.owner.id)

    const classRes = await call('GET', `/tenant/classes/${cls.id}`, { as, slug: a.tenant.slug })
    expect(classRes.statusCode).toBe(200)
    expect(classRes.json().class.id).toBe(cls.id)

    const examRes = await call('GET', `/tenant/exams/${exam.id}`, { as, slug: a.tenant.slug })
    expect(examRes.statusCode).toBe(200)
    expect(examRes.json().exam.id).toBe(exam.id)
  })
})

describe('CRITICAL: A-user names tenant B (X-Tenant-Slug or subdomain)', () => {
  const ENDPOINTS = [
    '/tenant/classes',
    '/tenant/exams',
    '/tenant/members',
    '/tenant/invites',
    '/tenant/notifications',
  ]

  it.each(ENDPOINTS)('GET %s with X-Tenant-Slug: B → 403', async (url) => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const res = await call('GET', url, { as: await signIn(a.owner.id), slug: b.tenant.slug })
    expect(res.statusCode).toBe(403)
  })

  it('B subdomain as the Host → 403', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const res = await call('GET', '/tenant/classes', {
      as: await signIn(a.owner.id),
      host: `${b.tenant.slug}.lvh.me`,
    })
    expect(res.statusCode).toBe(403)
  })

  it('the subdomain wins over a forged header naming another coaching', async () => {
    // Host says B (not a member), header says A (a member). Resolution takes the
    // subdomain first, so the header cannot talk the request back into A.
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const res = await call('GET', '/tenant/classes', {
      as: await signIn(a.owner.id),
      host: `${b.tenant.slug}.lvh.me`,
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('CRITICAL: A-user on A, B-resource id in the URL', () => {
  it('class: read, roster, update, delete all 404 and B is untouched', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bClass = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id, name: 'B original' })
    await enrollStudent({ classId: bClass.id, studentId: b.student.id })
    const as = await signIn(a.owner.id)
    const slug = a.tenant.slug

    expect((await call('GET', `/tenant/classes/${bClass.id}`, { as, slug })).statusCode).toBe(404)
    expect((await call('GET', `/tenant/classes/${bClass.id}/students`, { as, slug })).statusCode).toBe(404)
    expect(
      (await call('PATCH', `/tenant/classes/${bClass.id}`, { as, slug, body: { name: 'hijacked' } })).statusCode,
    ).toBe(404)
    expect((await call('DELETE', `/tenant/classes/${bClass.id}`, { as, slug })).statusCode).toBe(404)

    const [after] = await db.select().from(classes).where(eq(classes.id, bClass.id))
    expect(after?.name).toBe('B original')
  })

  it('exam: read, update, delete all 404 and B is untouched', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({
      tenantId: b.tenant.id,
      createdBy: b.teacher.id,
      status: 'draft',
      title: 'B original',
    })
    const slug = a.tenant.slug

    // Reads: the owner. Writes are teacher-only, so the attacker is A's teacher.
    const owner = await signIn(a.owner.id)
    const teacher = await signIn(a.teacher.id)

    expect((await call('GET', `/tenant/exams/${bExam.id}`, { as: owner, slug })).statusCode).toBe(404)
    expect(
      (await call('PATCH', `/tenant/exams/${bExam.id}`, { as: teacher, slug, body: { title: 'hijacked' } })).statusCode,
    ).toBe(404)
    expect((await call('DELETE', `/tenant/exams/${bExam.id}`, { as: teacher, slug })).statusCode).toBe(404)

    const [after] = await db.select().from(exams).where(eq(exams.id, bExam.id))
    expect(after?.title).toBe('B original')
  })

  // F-9: /tenant/exams/:id's student branch (getExamForStudent) is reached via
  // canStudentAccess, which allows any authenticated student onto a public
  // exam with no tenant check of its own — before this closed, A's student
  // could read B's public exam through A's own /tenant/ prefix.
  it("a student can't reach B's public exam through A's /tenant/ prefix", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({
      tenantId: b.tenant.id,
      createdBy: b.teacher.id,
      status: 'live',
      visibility: 'public_free',
    })

    const res = await call('GET', `/tenant/exams/${bExam.id}`, {
      as: await signIn(a.student.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(404)
  })

  it('exam sessions and reports lists for a B exam → 404', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id })
    const as = await signIn(a.owner.id)
    const slug = a.tenant.slug

    expect((await call('GET', `/tenant/exams/${bExam.id}/sessions`, { as, slug })).statusCode).toBe(404)
    expect((await call('GET', `/tenant/exams/${bExam.id}/reports`, { as, slug })).statusCode).toBe(404)
  })

  it('report by id → 404', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id })
    const bSession = await createTestSession({ examId: bExam.id, studentId: b.student.id, tenantId: b.tenant.id })
    const [bReport] = await db
      .insert(reports)
      .values({
        sessionId: bSession.id,
        studentId: b.student.id,
        examId: bExam.id,
        tenantId: b.tenant.id,
        totalScore: 70,
        maxScore: 100,
        status: 'ready',
      })
      .returning()

    const res = await call('GET', `/tenant/reports/${bReport.id}`, {
      as: await signIn(a.owner.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(404)
  })

  it('evaluation job by id → 404', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id })
    const bSession = await createTestSession({ examId: bExam.id, studentId: b.student.id, tenantId: b.tenant.id })
    const bJob = await createEvaluationJob({ sessionId: bSession.id, tenantId: b.tenant.id })

    const res = await call('GET', `/tenant/evaluation/jobs/${bJob.id}`, {
      as: await signIn(a.owner.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(404)
  })

  it('revoking a B invite → 404 and it stays pending', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bInvite = await createTestInvite({ tenantId: b.tenant.id, invitedBy: b.owner.id, contact: 'x@test.local' })

    const res = await call('DELETE', `/tenant/invites/${bInvite.id}`, {
      as: await signIn(a.owner.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(404)

    const [after] = await db.select().from(invites).where(eq(invites.id, bInvite.id))
    expect(after?.status).toBe('pending')
  })

  it('removing a B member → 404 and the membership survives', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()

    const res = await call('DELETE', `/tenant/members/${b.teacher.id}`, {
      as: await signIn(a.owner.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(404)

    const rows = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, b.teacher.id), eq(memberships.tenantId, b.tenant.id)))
    expect(rows).toHaveLength(1)
  })
})

describe('CRITICAL: tenant-free student routes are owner-keyed', () => {
  it("A-student cannot read B-student's session", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bExam = await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id })
    const bSession = await createTestSession({
      examId: bExam.id,
      studentId: b.student.id,
      tenantId: b.tenant.id,
      status: 'in_progress',
    })

    const res = await call('GET', `/sessions/${bSession.id}`, { as: await signIn(a.student.id) })
    expect(res.statusCode).toBe(404)
  })
})

describe('invitations: the token carries the tenant, the host does not', () => {
  it('an A invite accepted on B’s subdomain joins A, never B', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const invitee = await createTestUser({ email: `invitee-${Date.now()}@test.local` })
    const invite = await createTestInvite({
      tenantId: a.tenant.id,
      invitedBy: a.owner.id,
      contact: invitee.email!,
    })

    const res = await call('POST', '/invites/accept', {
      as: await signIn(invitee.id),
      host: `${b.tenant.slug}.lvh.me`,
      slug: b.tenant.slug,
      body: { token: invite.token },
    })
    expect(res.statusCode).toBe(200)

    const held = await db.select().from(memberships).where(eq(memberships.userId, invitee.id))
    expect(held.map((m) => ({ tenantId: m.tenantId, role: m.role }))).toEqual([
      { tenantId: a.tenant.id, role: 'teacher' },
    ])
  })
})

describe('F-2 pin: global role never widens an in-tenant view', () => {
  // The owner of some other coaching joins A as a student. Their account role is
  // `coaching_owner`; their role in A is `student`, and only the latter counts.
  async function ownerElsewhereStudentInA() {
    const a = await seedTenantWithUsers()
    const elsewhere = await seedTenantWithUsers()
    await createMembership({ userId: elsewhere.owner.id, tenantId: a.tenant.id, role: 'student' })

    // Force-set the fixture's account role directly — real registerCoaching
    // never writes 'coaching_owner' here any more (multi-tenancy audit Core
    // retirement), so this simulates the state defense-in-depth must still
    // survive: nothing reads this column for a tenant authorization decision.
    await db.update(users).set({ accountRole: 'coaching_owner' }).where(eq(users.id, elsewhere.owner.id))
    const [account] = await db.select().from(users).where(eq(users.id, elsewhere.owner.id))
    expect(account.accountRole).toBe('coaching_owner') // precondition, or the test proves nothing

    return { a, intruder: elsewhere.owner }
  }

  it('GET /tenant/classes lists only their own classes', async () => {
    const { a, intruder } = await ownerElsewhereStudentInA()
    const mine = await createTestClass({ tenantId: a.tenant.id, teacherId: a.teacher.id })
    await createTestClass({ tenantId: a.tenant.id, teacherId: a.teacher.id }) // not enrolled
    await enrollStudent({ classId: mine.id, studentId: intruder.id })

    const res = await call('GET', '/tenant/classes', { as: await signIn(intruder.id), slug: a.tenant.slug })
    expect(res.statusCode).toBe(200)
    expect(res.json().classes.map((c: { id: string }) => c.id)).toEqual([mine.id])
  })

  it('GET /tenant/classes/:id/students hides classmates’ contact details', async () => {
    const { a, intruder } = await ownerElsewhereStudentInA()
    const cls = await createTestClass({ tenantId: a.tenant.id, teacherId: a.teacher.id })
    await enrollStudent({ classId: cls.id, studentId: intruder.id })
    const classmate = await createTestUser({ phoneNumber: `+9190000${Date.now() % 100000}` })
    await createMembership({ userId: classmate.id, tenantId: a.tenant.id, role: 'student' })
    await enrollStudent({ classId: cls.id, studentId: classmate.id })

    const res = await call('GET', `/tenant/classes/${cls.id}/students`, {
      as: await signIn(intruder.id),
      slug: a.tenant.slug,
    })
    expect(res.statusCode).toBe(200)
    const body = res.body
    expect(body).not.toContain(classmate.email!)
    expect(body).not.toContain(classmate.phoneNumber!)
  })

  it('GET /tenant/exams/:id/sessions and /reports are refused', async () => {
    const { a, intruder } = await ownerElsewhereStudentInA()
    const exam = await createTestExam({ tenantId: a.tenant.id, createdBy: a.teacher.id })
    const as = await signIn(intruder.id)

    expect((await call('GET', `/tenant/exams/${exam.id}/sessions`, { as, slug: a.tenant.slug })).statusCode).toBe(403)
    expect((await call('GET', `/tenant/exams/${exam.id}/reports`, { as, slug: a.tenant.slug })).statusCode).toBe(403)
  })
})

describe('F-3 pin: a session started over HTTP belongs to the exam’s tenant', () => {
  it('records exam.tenantId, ignoring the tenant the request names', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    // The student belongs to both coachings and calls from B's subdomain.
    await createMembership({ userId: a.student.id, tenantId: b.tenant.id, role: 'student' })

    const cls = await createTestClass({ tenantId: a.tenant.id, teacherId: a.teacher.id })
    await enrollStudent({ classId: cls.id, studentId: a.student.id })
    const exam = await createTestExam({ tenantId: a.tenant.id, createdBy: a.teacher.id })
    await linkExamToClass(exam.id, cls.id)

    const res = await call('POST', `/exams/${exam.id}/sessions/start`, {
      as: await signIn(a.student.id),
      host: `${b.tenant.slug}.lvh.me`,
      slug: b.tenant.slug,
    })
    expect(res.statusCode).toBe(201)

    const [row] = await db.select().from(examSessions).where(eq(examSessions.id, res.json().session.id))
    expect(row.tenantId).toBe(a.tenant.id)
  })
})
