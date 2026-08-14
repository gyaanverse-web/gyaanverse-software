import './dev-guard.js' // must be first — see the file
import '../src/config/env.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { assertLocalDatabase, overrodeProductionEnv } from './dev-guard.js'
import { db } from '../src/shared/db.js'
import { users, accounts } from '../src/modules/auth/auth.schema.js'
import { tenants } from '../src/modules/tenant/tenant.schema.js'
import { createTenant } from '../src/modules/tenant/tenant.service.js'
import { memberships } from '../src/modules/membership/membership.schema.js'
import { classes, classMembers } from '../src/modules/class/class.schema.js'
import {
  subjects, modules as modulesTable, chapters, sections, concepts, questionBank,
} from '../src/modules/question-bank/question-bank.schema.js'
import { exams, questions } from '../src/modules/exam/exam.schema.js'
import { examSessions, sessionAnswers } from '../src/modules/exam-session/exam-session.schema.js'
import { forceSubmitSession } from '../src/modules/exam-session/exam-session.service.js'
import { validateQuestionPayload } from '../src/modules/exam/exam.validators.js'

// ─────────────────────────────────────────────────────────────────────────────
// SEED STUDIO — a local dashboard for building a realistic tenant by hand.
//
//   npm run seed:studio            → http://localhost:4400
//   npm run seed:studio -- --port 5100
//   npm run seed:studio -- --allow-remote      (refuses a non-local DB without it)
//
// Everything the seed scripts do, driven by dropdowns instead of flags, and
// scoped to whichever coaching you pick:
//
//   1  Coaching     pick an existing tenant, or create one with its owner
//   2  Teacher      pick an existing teacher, or create one
//   3  Class        pick an existing class, or create one under that teacher
//   4  Students     create N students at once and enrol them in that class
//   5  Syllabus     import a content pack — a full subject → module → chapter →
//                   section → concept tree with active, verified bank questions,
//                   or add a single node anywhere in the tree
//   6  Attempts     make the class sit an exam: sessions, answers, submit, and
//                   hand the subjective ones to the AI evaluation pipeline
//
// Step 6 is the one that costs money. Every subjective answer is a real OCR
// call plus a real grading call against the engine in EVAL_ENGINE_URL, so the
// page shows the call count before you run it.
//
// WHAT THIS DELIBERATELY DOES NOT DO: author or schedule the exam. That is the
// teacher's job in the real UI, and doing it here would test this script's idea
// of an exam rather than the product's. Build the paper in the app from the
// questions step 5 imported, then come back to step 6 to sit it.
//
// Rows are written straight through drizzle, so plan limits and role checks are
// bypassed — that is the point of a seeder, and it is also why the local-DB
// guard in dev-guard.ts is not optional.
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const PACKS_DIR = join(here, 'seed-data', 'packs')
const SHEETS_DIR = process.env.SEED_STUDIO_SHEETS_DIR
  ? resolve(process.env.SEED_STUDIO_SHEETS_DIR)
  : resolve(here, '..', '..', 'AI_Engines', 'Data')

const argv = process.argv.slice(2)
function flag(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const PORT = Number(flag('--port') ?? 4400)
const DB_SUMMARY = assertLocalDatabase(argv.includes('--allow-remote'))

// ── Content packs ────────────────────────────────────────────────────────────

interface AnswerSheet { file: string; quality: 'correct' | 'partial' | 'wrong'; note?: string }
interface PackQuestion {
  ref: string
  type: string
  difficulty: 'easy' | 'medium' | 'hard'
  body: string
  marks?: number
  negativeMarks?: number
  rubric?: string
  sampleAnswer?: string
  explanation?: string
  tags?: string[]
  wordLimit?: number
  decimalPlaces?: number
  tolerance?: number
  blanks?: number
  assertion?: string
  reason?: string
  options?: Array<{ id: string; text: string }>
  match?: { left: Array<{ id: string; text: string }>; right: Array<{ id: string; text: string }> }
  answer?: unknown
  answerSheets?: AnswerSheet[]
}
interface PackConcept { name: string; description?: string; questions: PackQuestion[] }
interface PackSection { name: string; concepts: PackConcept[] }
interface PackChapter { name: string; sections: PackSection[] }
interface PackModule { name: string; chapters: PackChapter[] }
interface Pack {
  id: string
  label: string
  description?: string
  subject: { name: string; gradeLevel?: string; code?: string }
  modules: PackModule[]
}

function loadPacks(): Pack[] {
  if (!existsSync(PACKS_DIR)) return []
  return readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf8')) as Pack)
}

function countPackQuestions(pack: Pack): { total: number; subjective: number; matched: number } {
  let total = 0
  let subjective = 0
  let matched = 0
  for (const m of pack.modules)
    for (const c of m.chapters)
      for (const s of c.sections)
        for (const con of s.concepts)
          for (const q of con.questions) {
            total++
            if (q.type === 'subjective') subjective++
            if (q.answerSheets?.length) matched++
          }
  return { total, subjective, matched }
}

/**
 * Per-type payload + answerKey, matching scripts/seed-questions.ts so one
 * authoring convention covers both importers. `subjective` is the one that
 * differs: it carries a rubric as well as a sample answer, because a rubric is
 * what makes a step-graded numerical reviewable by a human afterwards.
 */
function buildPayloadAndAnswer(q: PackQuestion): { payload: unknown; answerKey: unknown } {
  switch (q.type) {
    case 'mcq_single':
      return { payload: { options: q.options ?? [] }, answerKey: { optionId: q.answer } }
    case 'mcq_multiple':
      return { payload: { options: q.options ?? [] }, answerKey: { optionIds: q.answer } }
    case 'integer':
      return { payload: {}, answerKey: { value: q.answer } }
    case 'numerical':
      return {
        payload: q.decimalPlaces != null ? { decimalPlaces: q.decimalPlaces } : {},
        answerKey: q.tolerance != null ? { value: q.answer, tolerance: q.tolerance } : { value: q.answer },
      }
    case 'subjective':
      return {
        payload: q.wordLimit != null ? { wordLimit: q.wordLimit } : {},
        answerKey: {
          ...(q.sampleAnswer ? { sampleAnswer: q.sampleAnswer } : {}),
          ...(q.rubric ? { rubric: q.rubric } : {}),
        },
      }
    case 'assertion_reason':
      return { payload: { assertion: q.assertion ?? '', reason: q.reason ?? '' }, answerKey: { option: q.answer } }
    case 'fill_blanks':
      return { payload: { blanks: q.blanks ?? 1 }, answerKey: { answers: q.answer } }
    case 'match':
      return {
        payload: { left: q.match?.left ?? [], right: q.match?.right ?? [] },
        answerKey: { pairs: q.answer },
      }
    default:
      throw new Error(`Unsupported question type: ${q.type}`)
  }
}

// ── Answer sheets ────────────────────────────────────────────────────────────
//
// Real handwritten pages. The engine base64-encodes anything that is not an
// http(s) or data URL, and buildOcrFriendlyUrl leaves non-Cloudinary strings
// alone, so an absolute local path runs the real pipeline with no upload.
//
// The catch that comes with it: the student results screen renders imageUrl as
// an <img src>, and a local path will not load in a browser. Fine for testing
// the evaluator, wrong for demoing the student UI — use Cloudinary URLs there.

function listAnswerSheets(): string[] {
  if (!existsSync(SHEETS_DIR)) return []
  return readdirSync(SHEETS_DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
}

function sheetPath(file: string): string {
  return join(SHEETS_DIR, file)
}

// ── Small helpers ────────────────────────────────────────────────────────────

class Bad extends Error {}

function req<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null || value === '') throw new Bad(`${field} is required`)
  return value
}

async function ensureUser(data: {
  email: string
  name: string
  role: string
  tenantId: string
  password: string
  resetPassword: boolean
}): Promise<{ id: string; status: 'created' | 'existed' | 'conflict'; note?: string }> {
  const email = data.email.trim().toLowerCase()
  const [existing] = await db
    .select({ id: users.id, tenantId: users.tenantId, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    if (existing.tenantId && existing.tenantId !== data.tenantId)
      return { id: existing.id, status: 'conflict', note: 'belongs to a different coaching' }

    if (!existing.tenantId) await db.update(users).set({ tenantId: data.tenantId }).where(eq(users.id, existing.id))
    if (data.resetPassword) await setPassword(existing.id, data.password)
    await ensureMembership(existing.id, data.tenantId, data.role)
    return { id: existing.id, status: 'existed', note: existing.role !== data.role ? `role is ${existing.role}` : undefined }
  }

  const id = crypto.randomUUID()
  await db.insert(users).values({
    id,
    email,
    name: data.name,
    emailVerified: true,
    isProfileComplete: true,
    role: data.role,
    signupIntent: data.role === 'coaching_owner' ? 'coaching_owner' : 'student',
    tenantId: data.tenantId,
  })
  await setPassword(id, data.password)
  await ensureMembership(id, data.tenantId, data.role)
  return { id, status: 'created' }
}

async function setPassword(userId: string, password: string): Promise<void> {
  const hashed = await hashPassword(password)
  const [cred] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .limit(1)
  if (cred) {
    await db.update(accounts).set({ password: hashed, updatedAt: new Date() }).where(eq(accounts.id, cred.id))
    return
  }
  await db.insert(accounts).values({
    id: crypto.randomUUID(),
    userId,
    accountId: userId,
    providerId: 'credential',
    password: hashed,
  })
}

async function ensureMembership(userId: string, tenantId: string, role: string): Promise<void> {
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (existing) return
  await db.insert(memberships).values({ id: crypto.randomUUID(), userId, tenantId, role })
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function listTenants() {
  return db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      plan: tenants.plan,
      ownerEmail: users.email,
    })
    .from(tenants)
    .leftJoin(users, eq(users.id, tenants.ownerId))
    .orderBy(asc(tenants.name))
}

/**
 * Counts are grouped aggregates joined up in JS, NOT correlated subqueries.
 *
 * Drizzle renders a column inside a raw `sql` template **unqualified**, so
 * `sql`… where ${questionBank.subjectId} = ${subjects.id}`` comes out as
 * `where "subject_id" = "id"` — and inside a subquery over question_bank both
 * names resolve to the inner table. It is valid SQL, it never errors, and it
 * quietly returns 0 for every row. A seeding dashboard reporting "0 questions"
 * right after importing 21 is worse than one that crashes.
 */
async function tenantDetail(tenantId: string) {
  const staff = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(users.email))

  const classRows = await db
    .select({
      id: classes.id,
      name: classes.name,
      grade: classes.grade,
      teacherId: classes.teacherId,
      teacherName: users.name,
    })
    .from(classes)
    .leftJoin(users, eq(users.id, classes.teacherId))
    .where(eq(classes.tenantId, tenantId))
    .orderBy(asc(classes.name))

  const memberCounts = await countBy(
    classRows.map((c) => c.id),
    (ids) =>
      db
        .select({ key: classMembers.classId, n: sql<number>`count(*)::int` })
        .from(classMembers)
        .where(and(inArray(classMembers.classId, ids), eq(classMembers.status, 'approved')))
        .groupBy(classMembers.classId),
  )

  const subjectRows = await db
    .select({ id: subjects.id, name: subjects.name, gradeLevel: subjects.gradeLevel })
    .from(subjects)
    .where(eq(subjects.tenantId, tenantId))
    .orderBy(asc(subjects.name))

  const bankCounts = new Map<string, { total: number; subjective: number }>()
  if (subjectRows.length) {
    const rows = await db
      .select({
        key: questionBank.subjectId,
        total: sql<number>`count(*)::int`,
        subjective: sql<number>`cast(count(*) filter (where ${questionBank.type} = 'subjective') as int)`,
      })
      .from(questionBank)
      .where(and(eq(questionBank.tenantId, tenantId), eq(questionBank.status, 'active')))
      .groupBy(questionBank.subjectId)
    for (const r of rows) bankCounts.set(r.key, { total: r.total, subjective: r.subjective })
  }

  const examRows = await db
    .select({
      id: exams.id,
      title: exams.title,
      status: exams.status,
      totalMarks: exams.totalMarks,
      scheduledAt: exams.scheduledAt,
      endsAt: exams.endsAt,
    })
    .from(exams)
    .where(eq(exams.tenantId, tenantId))
    .orderBy(asc(exams.title))

  const examIds = examRows.map((e) => e.id)
  const questionCounts = new Map<string, { total: number; subjective: number }>()
  if (examIds.length) {
    const rows = await db
      .select({
        key: questions.examId,
        total: sql<number>`count(*)::int`,
        subjective: sql<number>`cast(count(*) filter (where ${questions.type} = 'subjective') as int)`,
      })
      .from(questions)
      .where(inArray(questions.examId, examIds))
      .groupBy(questions.examId)
    for (const r of rows) questionCounts.set(r.key, { total: r.total, subjective: r.subjective })
  }
  const sessionCounts = await countBy(examIds, (ids) =>
    db
      .select({ key: examSessions.examId, n: sql<number>`count(*)::int` })
      .from(examSessions)
      .where(inArray(examSessions.examId, ids))
      .groupBy(examSessions.examId),
  )

  return {
    teachers: staff.filter((s) => s.role === 'teacher'),
    owners: staff.filter((s) => s.role === 'coaching_owner'),
    students: staff.filter((s) => s.role === 'student'),
    classes: classRows.map((c) => ({ ...c, members: memberCounts.get(c.id) ?? 0 })),
    subjects: subjectRows.map((s) => ({
      ...s,
      bankQuestions: bankCounts.get(s.id)?.total ?? 0,
      subjectiveQuestions: bankCounts.get(s.id)?.subjective ?? 0,
    })),
    exams: examRows.map((e) => ({
      ...e,
      questionCount: questionCounts.get(e.id)?.total ?? 0,
      subjectiveCount: questionCounts.get(e.id)?.subjective ?? 0,
      sessionCount: sessionCounts.get(e.id) ?? 0,
    })),
  }
}

async function countBy(
  ids: string[],
  query: (ids: string[]) => Promise<Array<{ key: string; n: number }>>,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await query(ids)
  return new Map(rows.map((r) => [r.key, r.n]))
}

async function classRoster(classId: string) {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(classMembers)
    .innerJoin(users, eq(users.id, classMembers.studentId))
    .where(and(eq(classMembers.classId, classId), eq(classMembers.status, 'approved')))
    .orderBy(asc(users.email))
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function createCoaching(b: Record<string, string>) {
  const name = req(b.name, 'Coaching name')
  const slug = req(b.slug, 'Slug').trim().toLowerCase()
  const ownerEmail = req(b.ownerEmail, 'Owner email').trim().toLowerCase()
  const password = req(b.password, 'Password')

  const [clash] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1)
  if (clash) throw new Bad(`A coaching with the slug '${slug}' already exists`)

  // The owner must exist before the tenant (tenants.owner_id is NOT NULL) and
  // the tenant must exist before the owner can point at it — so the user row is
  // written first with no tenant, then updated. Same order registerCoaching uses.
  const [existingOwner] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail)).limit(1)
  let ownerId: string
  if (existingOwner) {
    ownerId = existingOwner.id
    await setPassword(ownerId, password)
  } else {
    ownerId = crypto.randomUUID()
    await db.insert(users).values({
      id: ownerId,
      email: ownerEmail,
      name: b.ownerName?.trim() || `${name} Owner`,
      emailVerified: true,
      isProfileComplete: true,
      role: 'coaching_owner',
      signupIntent: 'coaching_owner',
    })
    await setPassword(ownerId, password)
  }

  const tenant = await createTenant({ slug, name, ownerId })
  await db.update(users).set({ tenantId: tenant.id, role: 'coaching_owner' }).where(eq(users.id, ownerId))
  await ensureMembership(ownerId, tenant.id, 'coaching_owner')

  return { tenantId: tenant.id, slug: tenant.slug, ownerEmail, message: `Coaching '${name}' created.` }
}

async function createTeacher(b: Record<string, string>) {
  const tenantId = req(b.tenantId, 'Coaching')
  const email = req(b.email, 'Email')
  const result = await ensureUser({
    email,
    name: b.name?.trim() || email.split('@')[0],
    role: 'teacher',
    tenantId,
    password: req(b.password, 'Password'),
    resetPassword: true,
  })
  if (result.status === 'conflict') throw new Bad(`${email} ${result.note}`)
  // An existing student being promoted keeps their sessions; only the role moves.
  await db.update(users).set({ role: 'teacher' }).where(eq(users.id, result.id))
  return { teacherId: result.id, message: `Teacher ${email} ${result.status === 'created' ? 'created' : 'updated'}.` }
}

async function createClass(b: Record<string, string>) {
  const tenantId = req(b.tenantId, 'Coaching')
  const teacherId = req(b.teacherId, 'Teacher')
  const name = req(b.name, 'Class name')

  const [clash] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), eq(classes.name, name)))
    .limit(1)
  if (clash) return { classId: clash.id, message: `Class '${name}' already existed — reusing it.` }

  const id = crypto.randomUUID()
  await db.insert(classes).values({
    id,
    tenantId,
    teacherId,
    name,
    grade: b.grade?.trim() || null,
    description: b.description?.trim() || null,
    autoApprove: true,
  })
  return { classId: id, message: `Class '${name}' created.` }
}

async function createStudents(b: Record<string, unknown>) {
  const tenantId = req(b.tenantId as string, 'Coaching')
  const classId = req(b.classId as string, 'Class')
  const count = Number(b.count ?? 10)
  const startIndex = Number(b.startIndex ?? 1)
  const pattern = String(b.emailPattern || 'st{n}@gmail.com')
  const password = req(b.password as string, 'Password')
  const namePrefix = String(b.namePrefix || 'Student')
  const resetPassword = b.resetPassword === true

  if (!Number.isInteger(count) || count < 1 || count > 200) throw new Bad('Count must be between 1 and 200')
  if (!pattern.includes('{n}')) throw new Bad("Email pattern must contain {n}, e.g. st{n}@gmail.com")

  const rows: Array<{ email: string; status: string; note?: string }> = []
  for (let i = startIndex; i < startIndex + count; i++) {
    const email = pattern.replace('{n}', String(i)).trim().toLowerCase()
    const result = await ensureUser({
      email,
      name: `${namePrefix} ${i}`,
      role: 'student',
      tenantId,
      password,
      resetPassword,
    })
    if (result.status === 'conflict') {
      rows.push({ email, status: 'skipped', note: result.note })
      continue
    }
    const enrolled = await ensureClassMember(classId, result.id)
    rows.push({
      email,
      status: result.status,
      note: [result.note, enrolled ? undefined : 'already enrolled'].filter(Boolean).join('; ') || undefined,
    })
  }

  const created = rows.filter((r) => r.status === 'created').length
  const existed = rows.filter((r) => r.status === 'existed').length
  const skipped = rows.filter((r) => r.status === 'skipped').length
  return {
    rows,
    message: `${created} created, ${existed} already existed, ${skipped} skipped.`,
  }
}

async function ensureClassMember(classId: string, studentId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: classMembers.id, status: classMembers.status })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
    .limit(1)
  if (existing) {
    if (existing.status !== 'approved')
      await db.update(classMembers).set({ status: 'approved' }).where(eq(classMembers.id, existing.id))
    return false
  }
  await db.insert(classMembers).values({ id: crypto.randomUUID(), classId, studentId, status: 'approved' })
  return true
}

// ── Hierarchy ────────────────────────────────────────────────────────────────

const LEVELS = ['subject', 'module', 'chapter', 'section', 'concept'] as const
type Level = (typeof LEVELS)[number]

async function listHierarchy(level: Level, tenantId: string, parentId: string | null) {
  switch (level) {
    case 'subject':
      return db
        .select({ id: subjects.id, name: subjects.name, extra: subjects.gradeLevel })
        .from(subjects)
        .where(and(eq(subjects.tenantId, tenantId), eq(subjects.status, 'active')))
        .orderBy(asc(subjects.name))
    case 'module':
      return db
        .select({ id: modulesTable.id, name: modulesTable.name, extra: sql<string | null>`null` })
        .from(modulesTable)
        .where(and(eq(modulesTable.subjectId, req(parentId, 'Subject')), eq(modulesTable.status, 'active')))
        .orderBy(asc(modulesTable.order), asc(modulesTable.name))
    case 'chapter':
      return db
        .select({ id: chapters.id, name: chapters.name, extra: sql<string | null>`null` })
        .from(chapters)
        .where(and(eq(chapters.moduleId, req(parentId, 'Module')), eq(chapters.status, 'active')))
        .orderBy(asc(chapters.order), asc(chapters.name))
    case 'section':
      return db
        .select({ id: sections.id, name: sections.name, extra: sql<string | null>`null` })
        .from(sections)
        .where(eq(sections.chapterId, req(parentId, 'Chapter')))
        .orderBy(asc(sections.order), asc(sections.name))
    case 'concept':
      return db
        .select({ id: concepts.id, name: concepts.name, extra: sql<string | null>`null` })
        .from(concepts)
        .where(eq(concepts.sectionId, req(parentId, 'Section')))
        .orderBy(asc(concepts.name))
  }
}

async function createHierarchyNode(b: Record<string, string>) {
  const tenantId = req(b.tenantId, 'Coaching')
  const level = req(b.level, 'Level') as Level
  const name = req(b.name, 'Name').trim()
  const parentId = b.parentId || null
  const id = crypto.randomUUID()

  switch (level) {
    case 'subject':
      await db.insert(subjects).values({ id, tenantId, name, gradeLevel: b.gradeLevel?.trim() || null })
      break
    case 'module':
      await db.insert(modulesTable).values({ id, tenantId, subjectId: req(parentId, 'Subject'), name })
      break
    case 'chapter':
      await db.insert(chapters).values({ id, tenantId, moduleId: req(parentId, 'Module'), name })
      break
    case 'section':
      await db.insert(sections).values({ id, tenantId, chapterId: req(parentId, 'Chapter'), name })
      break
    case 'concept':
      await db.insert(concepts).values({ id, tenantId, sectionId: req(parentId, 'Section'), name })
      break
    default:
      throw new Bad(`Unknown level '${level}'`)
  }
  return { id, message: `${level} '${name}' created.` }
}

// ── Pack import ──────────────────────────────────────────────────────────────

async function importPack(b: Record<string, string>) {
  const tenantId = req(b.tenantId, 'Coaching')
  const packId = req(b.packId, 'Pack')
  const pack = loadPacks().find((p) => p.id === packId)
  if (!pack) throw new Bad(`No pack with id '${packId}'`)

  const [owner] = await db
    .select({ id: tenants.ownerId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  const createdBy = b.createdBy || owner?.id || null

  const made = { subjects: 0, modules: 0, chapters: 0, sections: 0, concepts: 0, questions: 0 }
  let skipped = 0

  const subjectId = await upsertNode(
    () =>
      db
        .select({ id: subjects.id })
        .from(subjects)
        .where(
          and(
            eq(subjects.tenantId, tenantId),
            eq(subjects.name, pack.subject.name),
            pack.subject.gradeLevel
              ? eq(subjects.gradeLevel, pack.subject.gradeLevel)
              : sql`${subjects.gradeLevel} is null`,
          ),
        )
        .limit(1),
    async (id) => {
      await db.insert(subjects).values({
        id,
        tenantId,
        createdBy,
        name: pack.subject.name,
        code: pack.subject.code ?? null,
        gradeLevel: pack.subject.gradeLevel ?? null,
      })
      made.subjects++
    },
  )

  for (const [mi, m] of pack.modules.entries()) {
    const moduleId = await upsertNode(
      () =>
        db
          .select({ id: modulesTable.id })
          .from(modulesTable)
          .where(and(eq(modulesTable.subjectId, subjectId), eq(modulesTable.name, m.name)))
          .limit(1),
      async (id) => {
        await db.insert(modulesTable).values({ id, tenantId, createdBy, subjectId, name: m.name, order: mi + 1 })
        made.modules++
      },
    )

    for (const [ci, c] of m.chapters.entries()) {
      const chapterId = await upsertNode(
        () =>
          db
            .select({ id: chapters.id })
            .from(chapters)
            .where(and(eq(chapters.moduleId, moduleId), eq(chapters.name, c.name)))
            .limit(1),
        async (id) => {
          await db.insert(chapters).values({ id, tenantId, createdBy, moduleId, name: c.name, order: ci + 1 })
          made.chapters++
        },
      )

      for (const [si, s] of c.sections.entries()) {
        const sectionId = await upsertNode(
          () =>
            db
              .select({ id: sections.id })
              .from(sections)
              .where(and(eq(sections.chapterId, chapterId), eq(sections.name, s.name)))
              .limit(1),
          async (id) => {
            await db.insert(sections).values({ id, tenantId, createdBy, chapterId, name: s.name, order: si + 1 })
            made.sections++
          },
        )

        for (const con of s.concepts) {
          const conceptId = await upsertNode(
            () =>
              db
                .select({ id: concepts.id })
                .from(concepts)
                .where(and(eq(concepts.sectionId, sectionId), eq(concepts.name, con.name)))
                .limit(1),
            async (id) => {
              await db.insert(concepts).values({
                id, tenantId, createdBy, sectionId, name: con.name, description: con.description ?? null,
              })
              made.concepts++
            },
          )

          for (const q of con.questions) {
            const [dup] = await db
              .select({ id: questionBank.id })
              .from(questionBank)
              .where(and(eq(questionBank.tenantId, tenantId), sql`${questionBank.metadata}->>'ref' = ${q.ref}`))
              .limit(1)
            if (dup) { skipped++; continue }

            const { payload, answerKey } = buildPayloadAndAnswer(q)
            const validated = validateQuestionPayload(q.type, payload, answerKey)
            if ('error' in validated) throw new Bad(`Question ${q.ref}: ${validated.error}`)

            await db.insert(questionBank).values({
              id: crypto.randomUUID(),
              tenantId,
              createdBy,
              subjectId,
              moduleId,
              chapterId,
              sectionId,
              conceptId,
              type: q.type,
              difficulty: q.difficulty,
              body: q.body,
              payload: validated.payload as Record<string, unknown>,
              answerKey: validated.answerKey as Record<string, unknown>,
              defaultMarks: q.marks ?? 5,
              defaultNegativeMarks: q.negativeMarks ?? 0,
              explanation: q.explanation ?? null,
              tags: q.tags ?? null,
              language: 'en',
              source: { type: 'original' },
              isVerified: true,
              // Only `active` rows enter exam generation, and a bank the teacher
              // cannot draw from is the one thing this import exists to avoid.
              status: 'active',
              metadata: {
                ref: q.ref,
                pack: pack.id,
                ...(q.answerSheets?.length ? { answerSheets: q.answerSheets } : {}),
              },
            })
            made.questions++
          }
        }
      }
    }
  }

  return {
    made,
    skipped,
    message:
      `${made.questions} questions imported (${skipped} already present). ` +
      `Tree: ${made.subjects} subject, ${made.modules} modules, ${made.chapters} chapters, ` +
      `${made.sections} sections, ${made.concepts} concepts.`,
  }
}

async function upsertNode(
  find: () => Promise<Array<{ id: string }>>,
  create: (id: string) => Promise<void>,
): Promise<string> {
  const [existing] = await find()
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await create(id)
  return id
}

// ── Attempt simulation ───────────────────────────────────────────────────────

interface ExamQuestionRow {
  id: string
  type: string
  marks: number
  payload: Record<string, unknown> | null
  answerKey: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

async function examPlan(examId: string) {
  const rows = await db
    .select({
      id: questions.id,
      order: questions.order,
      type: questions.type,
      body: questions.body,
      marks: questions.marks,
      metadata: questionBank.metadata,
    })
    .from(questions)
    .leftJoin(questionBank, eq(questionBank.id, questions.bankQuestionId))
    .where(eq(questions.examId, examId))
    .orderBy(asc(questions.order))

  return rows.map((r) => {
    const sheets = (r.metadata?.answerSheets as AnswerSheet[] | undefined) ?? []
    return {
      id: r.id,
      order: r.order,
      type: r.type,
      marks: r.marks,
      body: r.body.length > 120 ? `${r.body.slice(0, 120)}…` : r.body,
      answerSheets: sheets,
    }
  })
}

/**
 * A plausible objective answer. Correctness is a pure function of the student
 * and question index rather than Math.random, so re-running a simulation
 * produces the same paper — a score that moves on its own is indistinguishable
 * from an evaluator bug.
 */
function synthAnswer(
  q: ExamQuestionRow,
  correct: boolean,
): Record<string, unknown> | null {
  const key = (q.answerKey ?? {}) as Record<string, any>
  const payload = (q.payload ?? {}) as Record<string, any>
  const options: Array<{ id: string }> = payload.options ?? []

  switch (q.type) {
    case 'mcq_single': {
      if (correct) return { optionId: key.optionId }
      const wrong = options.find((o) => o.id !== key.optionId)
      return wrong ? { optionId: wrong.id } : { optionId: key.optionId }
    }
    case 'mcq_multiple': {
      if (correct) return { optionIds: key.optionIds }
      const ids: string[] = key.optionIds ?? []
      const wrong = options.find((o) => !ids.includes(o.id))
      return { optionIds: wrong ? [wrong.id] : ids.slice(0, 1) }
    }
    case 'integer':
      return { value: correct ? key.value : Number(key.value) + 1 }
    case 'numerical':
      return { value: correct ? key.value : Number(key.value) * 1.5 + 1 }
    case 'assertion_reason': {
      if (correct) return { option: key.option }
      const all = ['A', 'B', 'C', 'D', 'E']
      return { option: all[(all.indexOf(key.option) + 1) % all.length] }
    }
    case 'fill_blanks': {
      const answers: string[] = key.answers ?? []
      return { answers: correct ? answers : answers.map(() => 'not attempted') }
    }
    case 'match': {
      const pairs: Array<{ leftId: string; rightId: string }> = key.pairs ?? []
      if (correct || pairs.length < 2) return { pairs }
      const swapped = pairs.map((p) => ({ ...p }))
      const tmp = swapped[0].rightId
      swapped[0].rightId = swapped[1].rightId
      swapped[1].rightId = tmp
      return { pairs: swapped }
    }
    default:
      return null
  }
}

async function simulateAttempts(b: Record<string, unknown>) {
  const examId = req(b.examId as string, 'Exam')
  const studentIds = (b.studentIds as string[]) ?? []
  const defaultSheet = String(b.defaultSheet || '')
  const ungradeableSheet = String(b.ungradeableSheet || '')
  const correctRate = Math.max(0, Math.min(100, Number(b.correctRate ?? 60)))
  const closeWindow = b.closeWindow === true
  const dryRun = b.dryRun === true

  if (studentIds.length === 0) throw new Bad('Pick at least one student')

  const [exam] = await db.select().from(exams).where(eq(exams.id, examId)).limit(1)
  if (!exam) throw new Bad('Exam not found')

  const examQuestions = await db
    .select({
      id: questions.id,
      order: questions.order,
      type: questions.type,
      marks: questions.marks,
      payload: questions.payload,
      answerKey: questions.answerKey,
      metadata: questionBank.metadata,
    })
    .from(questions)
    .leftJoin(questionBank, eq(questionBank.id, questions.bankQuestionId))
    .where(eq(questions.examId, examId))
    .orderBy(asc(questions.order))

  if (examQuestions.length === 0) throw new Bad('That exam has no questions yet')

  const subjectiveQuestions = examQuestions.filter((q) => q.type === 'subjective')
  if (subjectiveQuestions.length > 0 && !defaultSheet)
    throw new Bad('Pick a default answer sheet — subjective questions cannot be submitted blank')

  // Who already has a session: (exam, student, attempt) is unique, and a second
  // attempt would grade a second paper rather than repair the first.
  const existing = await db
    .select({ studentId: examSessions.studentId })
    .from(examSessions)
    .where(and(eq(examSessions.examId, examId), inArray(examSessions.studentId, studentIds)))
  const alreadyAttempted = new Set(existing.map((e) => e.studentId))

  const roster = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.id, studentIds))
  const byId = new Map(roster.map((r) => [r.id, r]))
  const ordered = studentIds.filter((id) => byId.has(id))

  // The ungradeable page goes on ONE question, not the whole paper. A student
  // whose every answer is unreadable burns `UNGRADEABLE_ATTEMPTS` retries per
  // question for nothing and parks the session in `needs_human` wholesale; one
  // bad photo among nine good ones is both the realistic case and the one that
  // actually exercises the review queue against a paper that can still settle.
  const firstSubjectiveIndex = examQuestions.findIndex((q) => q.type === 'subjective')

  const plan: Array<{ email: string; status: string; sheets: string[]; note?: string }> = []
  const distinctImages = new Set<string>()
  let subjectiveAnswers = 0

  for (const [studentIndex, studentId] of ordered.entries()) {
    const student = byId.get(studentId)!
    if (alreadyAttempted.has(studentId)) {
      plan.push({ email: student.email ?? studentId, status: 'skipped', sheets: [], note: 'already has a session' })
      continue
    }

    const isUngradeable = !!ungradeableSheet && studentIndex === ordered.length - 1
    const sheetsUsed: string[] = []
    const answerRows: Array<{ questionId: string; answer: Record<string, unknown> | null; imageUrl: string | null }> = []

    for (const [qi, q] of examQuestions.entries()) {
      if (q.type === 'subjective') {
        const matched = (q.metadata?.answerSheets as AnswerSheet[] | undefined) ?? []
        const file = isUngradeable && qi === firstSubjectiveIndex
          ? ungradeableSheet
          : matched.length
            ? matched[studentIndex % matched.length].file
            : defaultSheet
        sheetsUsed.push(file)
        distinctImages.add(file)
        subjectiveAnswers++
        answerRows.push({ questionId: q.id, answer: null, imageUrl: sheetPath(file) })
      } else {
        const correct = ((studentIndex * 7 + qi * 13) % 100) < correctRate
        answerRows.push({ questionId: q.id, answer: synthAnswer(q as ExamQuestionRow, correct), imageUrl: null })
      }
    }

    if (dryRun) {
      plan.push({ email: student.email ?? studentId, status: 'would submit', sheets: sheetsUsed })
      continue
    }

    const now = new Date()
    const sessionId = crypto.randomUUID()
    await db.insert(examSessions).values({
      id: sessionId,
      examId,
      studentId,
      tenantId: exam.tenantId,
      attemptNumber: 1,
      status: 'in_progress',
      startedAt: new Date(now.getTime() - exam.durationMins * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      totalMarks: exam.totalMarks,
    })
    await db.insert(sessionAnswers).values(
      answerRows.map((a) => ({ id: crypto.randomUUID(), sessionId, ...a })),
    )

    // The real submit path: objective grading, report or evaluation enqueue,
    // bank success-rate refresh. Nothing here reimplements any of it.
    await forceSubmitSession(sessionId)

    plan.push({ email: student.email ?? studentId, status: 'submitted', sheets: sheetsUsed })
  }

  let windowNote: string | undefined
  if (closeWindow && !dryRun) {
    if (exam.status === 'live' || exam.status === 'scheduled') {
      await db
        .update(exams)
        .set({
          scheduledAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          endsAt: new Date(Date.now() - 60 * 1000),
        })
        .where(eq(exams.id, examId))
      windowNote = 'Exam window closed — the lifecycle tick will move it to under_evaluation within a minute.'
    } else {
      windowNote = `Exam is '${exam.status}', not scheduled or live — window left untouched.`
    }
  }

  const submitted = plan.filter((p) => p.status === 'submitted').length
  // Two different bills. Every subjective answer is one grading call, always.
  // OCR is cached by image URL across every session and every exam, so the
  // worst case is one read per *distinct* image and the usual case is fewer.
  const cost =
    `${subjectiveAnswers} evaluate call(s) + at most ${distinctImages.size} OCR ` +
    `call(s) (${distinctImages.size} distinct image(s); repeats hit the OCR cache)`

  return {
    plan,
    windowNote,
    evaluateCalls: subjectiveAnswers,
    ocrCallsMax: distinctImages.size,
    message: dryRun
      ? `Dry run: ${plan.length} student(s), ${cost}.`
      : `${submitted} paper(s) submitted — ${cost}. ` +
        `Watch it grade: npm run eval:inspect -- --exam ${examId}`,
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function readBody(reqst: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    reqst.on('data', (chunk) => { data += chunk })
    reqst.on('end', () => {
      if (!data) return resolvePromise({})
      try { resolvePromise(JSON.parse(data)) } catch { reject(new Bad('Body is not valid JSON')) }
    })
    reqst.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = createServer(async (reqst, res) => {
  const url = new URL(reqst.url ?? '/', `http://localhost:${PORT}`)
  const route = `${reqst.method} ${url.pathname}`

  try {
    if (route === 'GET /' || route === 'GET /index.html') {
      const html = readFileSync(join(here, 'seed-studio.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // Answer-sheet preview, so you can see which page you are about to submit.
    if (reqst.method === 'GET' && url.pathname.startsWith('/sheets/')) {
      const file = decodeURIComponent(url.pathname.slice('/sheets/'.length))
      if (file.includes('/') || file.includes('\\') || file.includes('..')) return json(res, 400, { error: 'Bad file' })
      const full = sheetPath(file)
      if (!existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: 'Not found' })
      const ext = extname(full).toLowerCase()
      res.writeHead(200, { 'content-type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' })
      res.end(readFileSync(full))
      return
    }

    if (route === 'GET /api/state') {
      const tenantId = url.searchParams.get('tenantId')
      const packs = loadPacks().map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        subject: p.subject,
        counts: countPackQuestions(p),
      }))
      return json(res, 200, {
        tenants: await listTenants(),
        tenant: tenantId ? await tenantDetail(tenantId) : null,
        packs,
        answerSheets: listAnswerSheets(),
        sheetsDir: SHEETS_DIR,
        sheetsDirExists: existsSync(SHEETS_DIR),
      })
    }

    if (route === 'GET /api/roster') {
      return json(res, 200, { students: await classRoster(req(url.searchParams.get('classId'), 'Class')) })
    }

    if (route === 'GET /api/hierarchy') {
      const level = (url.searchParams.get('level') ?? 'subject') as Level
      if (!LEVELS.includes(level)) throw new Bad(`Unknown level '${level}'`)
      return json(res, 200, {
        nodes: await listHierarchy(
          level,
          req(url.searchParams.get('tenantId'), 'Coaching'),
          url.searchParams.get('parentId'),
        ),
      })
    }

    if (route === 'GET /api/exam-plan') {
      return json(res, 200, { questions: await examPlan(req(url.searchParams.get('examId'), 'Exam')) })
    }

    if (reqst.method === 'POST') {
      const body = await readBody(reqst)
      switch (url.pathname) {
        case '/api/coaching':  return json(res, 200, await createCoaching(body as Record<string, string>))
        case '/api/teacher':   return json(res, 200, await createTeacher(body as Record<string, string>))
        case '/api/class':     return json(res, 200, await createClass(body as Record<string, string>))
        case '/api/students':  return json(res, 200, await createStudents(body))
        case '/api/hierarchy': return json(res, 200, await createHierarchyNode(body as Record<string, string>))
        case '/api/pack':      return json(res, 200, await importPack(body as Record<string, string>))
        case '/api/simulate':  return json(res, 200, await simulateAttempts(body))
      }
    }

    json(res, 404, { error: `No route for ${route}` })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!(err instanceof Bad)) console.error(`[seed-studio] ${route} failed:`, err)
    json(res, err instanceof Bad ? 400 : 500, { error: message })
  }
})

const divider = '─'.repeat(66)
server.listen(PORT, () => {
  console.log(`\n${divider}`)
  console.log('  Seed Studio')
  console.log(divider)
  console.log(`  url        http://localhost:${PORT}`)
  console.log(`  database   ${DB_SUMMARY}`)
  console.log(`  packs      ${PACKS_DIR}`)
  console.log(`  sheets     ${SHEETS_DIR}${existsSync(SHEETS_DIR) ? '' : '   ← MISSING'}`)
  if (overrodeProductionEnv) {
    console.log('\n  note       NODE_ENV was "production" in this shell; overridden to')
    console.log('             "development" for this process (see scripts/dev-guard.ts).')
  }
  console.log(`\n  Simulating attempts calls the real AI engine at:`)
  console.log(`  ${process.env.EVAL_ENGINE_URL ?? '(EVAL_ENGINE_URL not set)'}`)
  console.log(`  and needs \`npm run dev:worker\` running to actually grade.`)
  console.log(`${divider}\n`)
})
