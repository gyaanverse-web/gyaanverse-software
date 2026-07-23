import '../src/config/env.js'
import { db } from '../src/shared/db.js'
import { hashPassword } from 'better-auth/crypto'
import { eq, and } from 'drizzle-orm'
import { users, accounts } from '../src/modules/auth/auth.schema.js'
import { tenants, tenantSettings } from '../src/modules/tenant/tenant.schema.js'
import { memberships } from '../src/modules/membership/membership.schema.js'
import { classes, classMembers } from '../src/modules/class/class.schema.js'
import { exams, questions } from '../src/modules/exam/exam.schema.js'
import { subjects, modules, chapters, questionBank } from '../src/modules/question-bank/question-bank.schema.js'

// ── Production guard ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('\n  ERROR: seed script is not allowed in production.\n')
  process.exit(1)
}

const SEED_PASSWORD = 'Seed@1234'
const TENANT_SLUG = 'dev'

// ── Summary tracker ────────────────────────────────────────────────────────────
type Counts = { created: number; existed: number }
const summary = new Map<string, Counts>()

function track(entity: string) {
  if (!summary.has(entity)) summary.set(entity, { created: 0, existed: 0 })
  const c = summary.get(entity)!
  return {
    created: () => { c.created++ },
    existed: () => { c.existed++ },
  }
}

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function upsertUser(data: {
  email: string
  name: string
  role: string
}): Promise<string> {
  const t = track('users')
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, data.email))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  const hashedPw = await hashPassword(SEED_PASSWORD)

  await db.insert(users).values({
    id,
    email: data.email,
    name: data.name,
    emailVerified: true,
    isProfileComplete: true,
    role: data.role,
  })

  await db.insert(accounts).values({
    id: crypto.randomUUID(),
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: hashedPw,
  })

  t.created()
  return id
}

async function upsertTenant(slug: string, name: string, ownerId: string): Promise<string> {
  const t = track('tenants')
  const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  await db.transaction(async (tx) => {
    await tx.insert(tenants).values({ id, slug, name, ownerId, plan: 'starter' })
    await tx.insert(tenantSettings).values({ tenantId: id })
  })

  t.created()
  return id
}

async function upsertMembership(userId: string, tenantId: string, role: string): Promise<void> {
  const t = track('memberships')
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
  if (existing) { t.existed(); return }

  await db.insert(memberships).values({ id: crypto.randomUUID(), userId, tenantId, role })
  t.created()
}

async function upsertSubject(tenantId: string, name: string, gradeLevel: string): Promise<string> {
  const t = track('subjects')
  const [existing] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(and(eq(subjects.tenantId, tenantId), eq(subjects.name, name)))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  await db.insert(subjects).values({ id, tenantId, name, gradeLevel })
  t.created()
  return id
}

async function upsertModule(
  tenantId: string,
  subjectId: string,
  name: string,
  order: number,
): Promise<string> {
  const t = track('modules')
  const [existing] = await db
    .select({ id: modules.id })
    .from(modules)
    .where(and(eq(modules.subjectId, subjectId), eq(modules.name, name)))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  await db.insert(modules).values({ id, tenantId, subjectId, name, order })
  t.created()
  return id
}

async function upsertChapter(
  tenantId: string,
  moduleId: string,
  name: string,
  order: number,
): Promise<string> {
  const t = track('chapters')
  const [existing] = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.moduleId, moduleId), eq(chapters.name, name)))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  await db.insert(chapters).values({ id, tenantId, moduleId, name, order })
  t.created()
  return id
}

// Seed a small pool of active mcq_single questions across difficulties so the
// test-engine generator has something to draw from in dev.
async function seedBankQuestions(
  tenantId: string,
  createdBy: string,
  subjectId: string,
  moduleId: string,
  chapterId: string,
): Promise<void> {
  const t = track('question_bank')
  const [existing] = await db
    .select({ id: questionBank.id })
    .from(questionBank)
    .where(and(eq(questionBank.tenantId, tenantId), eq(questionBank.subjectId, subjectId)))
  if (existing) { t.existed(); return }

  const difficulties = ['easy', 'medium', 'hard'] as const
  const rows = []
  for (const difficulty of difficulties) {
    for (let i = 1; i <= 4; i++) {
      rows.push({
        id: crypto.randomUUID(),
        tenantId,
        createdBy,
        subjectId,
        moduleId,
        chapterId,
        type: 'mcq_single' as const,
        difficulty,
        body: `[${difficulty}] Mechanics practice question #${i}: choose the correct option.`,
        payload: {
          options: [
            { id: 'a', text: 'Option A' },
            { id: 'b', text: 'Option B' },
            { id: 'c', text: 'Option C' },
            { id: 'd', text: 'Option D' },
          ],
        },
        answerKey: { optionId: 'a' },
        defaultMarks: 4,
        defaultNegativeMarks: 1,
        isVerified: true,
        status: 'active' as const,
      })
    }
  }
  await db.insert(questionBank).values(rows)
  for (let i = 0; i < rows.length; i++) t.created()
}

async function upsertClass(
  tenantId: string,
  teacherId: string,
  name: string,
  description: string,
): Promise<string> {
  const t = track('classes')
  const [existing] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), eq(classes.name, name)))
  if (existing) { t.existed(); return existing.id }

  const id = crypto.randomUUID()
  await db.insert(classes).values({ id, tenantId, teacherId, name, description, autoApprove: true })
  t.created()
  return id
}

async function upsertClassMember(classId: string, studentId: string): Promise<void> {
  const t = track('classMembers')
  const [existing] = await db
    .select({ id: classMembers.id })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
  if (existing) { t.existed(); return }

  await db.insert(classMembers).values({
    id: crypto.randomUUID(),
    classId,
    studentId,
    status: 'approved',
  })
  t.created()
}

async function upsertExam(
  tenantId: string,
  createdBy: string,
  title: string,
): Promise<{ id: string; isNew: boolean }> {
  const t = track('exams')
  const [existing] = await db
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.tenantId, tenantId), eq(exams.title, title)))
  if (existing) { t.existed(); return { id: existing.id, isNew: false } }

  const id = crypto.randomUUID()
  await db.insert(exams).values({
    id,
    tenantId,
    createdBy,
    title,
    description: 'A sample mock test with mixed question types.',
    durationMins: 60,
    gradeLevel: '12',
    scopeType: 'custom',
    visibility: 'private',
    maxAttempts: 3,
    status: 'published',
    totalMarks: 12,
    publishedAt: new Date(),
  })
  t.created()
  return { id, isNew: true }
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('\nSeeding database...\n')

// 1. Users
const ownerId   = await upsertUser({ email: 'owner@dev.local',    name: 'Dev Owner',   role: 'coaching_owner' })
const teacherId = await upsertUser({ email: 'teacher@dev.local',  name: 'Dev Teacher', role: 'teacher' })
const s1Id      = await upsertUser({ email: 'student1@dev.local', name: 'Dev Student 1', role: 'student' })
const s2Id      = await upsertUser({ email: 'student2@dev.local', name: 'Dev Student 2', role: 'student' })

// 2. Tenant
const tenantId = await upsertTenant(TENANT_SLUG, 'Dev Coaching Institute', ownerId)

// 3. Link all users to the tenant (idempotent UPDATE — same value each run)
await db.update(users).set({ tenantId }).where(eq(users.id, ownerId))
await db.update(users).set({ tenantId }).where(eq(users.id, teacherId))
await db.update(users).set({ tenantId }).where(eq(users.id, s1Id))
await db.update(users).set({ tenantId }).where(eq(users.id, s2Id))

// 4. Memberships
await upsertMembership(ownerId,   tenantId, 'coaching_owner')
await upsertMembership(teacherId, tenantId, 'teacher')
await upsertMembership(s1Id,      tenantId, 'student')
await upsertMembership(s2Id,      tenantId, 'student')

// 5. Subjects → modules → chapters
const mathsId   = await upsertSubject(tenantId, 'Mathematics', '12')
const physicsId = await upsertSubject(tenantId, 'Physics', '12')

const mathsModId   = await upsertModule(tenantId, mathsId,   'Core Mathematics', 1)
const physicsModId = await upsertModule(tenantId, physicsId, 'Core Physics',      1)

await upsertChapter(tenantId, mathsModId,   'Algebra',        1)
await upsertChapter(tenantId, mathsModId,   'Calculus',       2)
const mechanicsId = await upsertChapter(tenantId, physicsModId, 'Mechanics',      1)
await upsertChapter(tenantId, physicsModId, 'Thermodynamics', 2)

// 5b. A few active bank questions so the test-engine generator is demoable.
await seedBankQuestions(tenantId, ownerId, physicsId, physicsModId, mechanicsId)

// 6. Classes
const mathsClassId   = await upsertClass(tenantId, teacherId, 'Maths Batch A',   'Grade 12 Mathematics')
const physicsClassId = await upsertClass(tenantId, teacherId, 'Physics Batch A', 'Grade 12 Physics')

// 7. Class enrollments
await upsertClassMember(mathsClassId,   s1Id)
await upsertClassMember(mathsClassId,   s2Id)
await upsertClassMember(physicsClassId, s1Id)

// 8. Published exam with questions
const { id: examId, isNew: examIsNew } = await upsertExam(tenantId, teacherId, 'Sample Mock Test')

if (examIsNew) {
  await db.insert(questions).values([
    {
      id: crypto.randomUUID(),
      examId,
      tenantId,
      order: 1,
      type: 'mcq_single',
      body: 'What is the derivative of x²?',
      payload: {
        options: [
          { id: 'a', text: '2x' },
          { id: 'b', text: 'x' },
          { id: 'c', text: '2' },
          { id: 'd', text: 'x²' },
        ],
      },
      answerKey: { optionId: 'a' },
      marks: 4,
      negativeMarks: 1,
    },
    {
      id: crypto.randomUUID(),
      examId,
      tenantId,
      order: 2,
      type: 'mcq_single',
      body: "Newton's second law states F = ma. If F = 30 N and m = 5 kg, what is the acceleration (m/s²)?",
      payload: {
        options: [
          { id: 'a', text: '3' },
          { id: 'b', text: '6' },
          { id: 'c', text: '150' },
          { id: 'd', text: '25' },
        ],
      },
      answerKey: { optionId: 'b' },
      marks: 4,
      negativeMarks: 1,
    },
    {
      id: crypto.randomUUID(),
      examId,
      tenantId,
      order: 3,
      type: 'integer',
      body: 'How many sides does a regular hexagon have?',
      payload: {},
      answerKey: { value: 6 },
      marks: 4,
      negativeMarks: 0,
    },
  ])
  track('questions').created()
  track('questions').created()
  track('questions').created()
}

// ── Console summary ────────────────────────────────────────────────────────────

const divider = '─'.repeat(50)
console.log(`\n${divider}`)
console.log('  Seed summary')
console.log(divider)

for (const [entity, counts] of summary) {
  const parts: string[] = []
  if (counts.created > 0) parts.push(`${counts.created} created`)
  if (counts.existed > 0) parts.push(`${counts.existed} already existed`)
  console.log(`  ${entity.padEnd(14)}  ${parts.join(', ')}`)
}

console.log(divider)
console.log('\n  Dev credentials  (password: Seed@1234)')
console.log(`  ${'owner@dev.local'.padEnd(26)} coaching_owner`)
console.log(`  ${'teacher@dev.local'.padEnd(26)} teacher`)
console.log(`  ${'student1@dev.local'.padEnd(26)} student`)
console.log(`  ${'student2@dev.local'.padEnd(26)} student`)
console.log(`\n  Tenant slug: ${TENANT_SLUG}  →  use ?tenant=${TENANT_SLUG} in local API requests`)
console.log(`${divider}\n`)

process.exit(0)
