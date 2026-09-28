import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { db } from '@shared/db.js'
import { sessions } from '@modules/auth/auth.schema.js'
import { classes, classTeachers } from '@modules/class/class.schema.js'
import {
  createMembership,
  createTestClass,
  createTestExam,
  createTestUser,
  enrollStudent,
  seedTenantWithUsers,
} from '../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// Owner runs classes; assigned teachers are read-only
// (docs/class-teacher-assignment-checklist.md).
//
// Over HTTP because the rule lives in the route guards: the service functions
// for class writes no longer check roles at all, so only `app.inject` proves a
// teacher can't reach them.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@shared/rate-limit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@shared/rate-limit.js')>()
  return { ...mod, getRateLimitRedis: () => undefined, waitForRateLimitRedis: async () => true }
})
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

async function signIn(userId: string): Promise<Record<string, string>> {
  const token = crypto.randomUUID().replace(/-/g, '')
  await db.insert(sessions).values({ userId, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
  return { authorization: `Bearer ${token}` }
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: { as: Record<string, string>; slug: string; body?: unknown },
) {
  return app.inject({
    method,
    url,
    headers: { ...opts.as, 'x-tenant-slug': opts.slug },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  })
}

describe('owner manages classes over HTTP', () => {
  it('creates a class with teachers, then replaces the list', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const t2 = await createTestUser()
    await createMembership({ userId: t2.id, tenantId: tenant.id, role: 'teacher' })
    const as = await signIn(owner.id)
    const slug = tenant.slug

    const created = await call('POST', '/tenant/classes', { as, slug, body: { name: 'Batch A', teacherIds: [teacher.id] } })
    expect(created.statusCode).toBe(201)
    const id = created.json().class.id
    expect(created.json().class.teachers.map((t: { id: string }) => t.id)).toEqual([teacher.id])

    const put = await call('PUT', `/tenant/classes/${id}/teachers`, { as, slug, body: { teacherIds: [teacher.id, t2.id] } })
    expect(put.statusCode).toBe(200)
    expect(put.json().class.teachers).toHaveLength(2)
  })
})

describe('CRITICAL: an assigned teacher is read-only', () => {
  it('can list and read the class and roster', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    const as = await signIn(teacher.id)
    const slug = tenant.slug

    const list = await call('GET', '/tenant/classes', { as, slug })
    expect(list.json().classes.map((c: { id: string }) => c.id)).toEqual([cls.id])
    expect((await call('GET', `/tenant/classes/${cls.id}`, { as, slug })).statusCode).toBe(200)
    expect((await call('GET', `/tenant/classes/${cls.id}/students`, { as, slug })).statusCode).toBe(200)
  })

  it('every write is 403 and nothing changes', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Original', autoApprove: false })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'pending' })
    const as = await signIn(teacher.id)
    const slug = tenant.slug
    const base = `/tenant/classes/${cls.id}`

    const attempts: Array<[Parameters<typeof call>[0], string, unknown?]> = [
      ['POST', '/tenant/classes', { name: 'Mine' }],
      ['PATCH', base, { name: 'hijacked' }],
      ['DELETE', base],
      ['PUT', `${base}/teachers`, { teacherIds: [] }],
      ['POST', `${base}/join-codes`, {}],
      ['GET', `${base}/join-codes`],
      ['DELETE', `${base}/join-codes/${crypto.randomUUID()}`],
      ['PATCH', `${base}/students/${student.id}`, { action: 'approve' }],
      ['DELETE', `${base}/students/${student.id}`],
    ]
    for (const [method, url, body] of attempts) {
      const res = await call(method, url, { as, slug, body })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }

    const [after] = await db.select().from(classes).where(eq(classes.id, cls.id))
    expect(after.name).toBe('Original')
    const assigned = await db.select().from(classTeachers).where(eq(classTeachers.classId, cls.id))
    expect(assigned.map((r) => r.teacherId)).toEqual([teacher.id])
  })
})

describe('CRITICAL: an unassigned teacher cannot see the class', () => {
  it('404s on read and roster; it is absent from their list', async () => {
    const { tenant } = await seedTenantWithUsers()
    const other = await createTestUser()
    await createMembership({ userId: other.id, tenantId: tenant.id, role: 'teacher' })
    const cls = await createTestClass({ tenantId: tenant.id })
    const as = await signIn(other.id)
    const slug = tenant.slug

    expect((await call('GET', `/tenant/classes/${cls.id}`, { as, slug })).statusCode).toBe(404)
    expect((await call('GET', `/tenant/classes/${cls.id}/students`, { as, slug })).statusCode).toBe(404)
    expect((await call('GET', '/tenant/classes', { as, slug })).json().classes).toEqual([])
  })

  it('cannot link their exam to a class they do not teach', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const notMine = await createTestClass({ tenantId: tenant.id })
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    const as = await signIn(teacher.id)
    const slug = tenant.slug

    const denied = await call('POST', `/tenant/exams/${exam.id}/classes`, { as, slug, body: { classId: notMine.id } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error).toBe('CLASS_NOT_ASSIGNED')

    const ok = await call('POST', `/tenant/exams/${exam.id}/classes`, { as, slug, body: { classId: mine.id } })
    expect(ok.statusCode).toBe(201)
  })
})
