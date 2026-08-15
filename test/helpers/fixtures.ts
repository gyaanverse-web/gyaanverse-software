// Fixture factories — insert rows directly to keep tests fast.
// Bypasses Better Auth's sign-up flow, which is the right tradeoff for unit
// tests of service/middleware logic: we test isolation/authorization rules,
// not the auth provider's internals.

import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { tenants } from '@modules/tenant/tenant.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { memberships, coachingJoinCodes } from '@modules/membership/membership.schema.js'
import { classes, classMembers } from '@modules/class/class.schema.js'
import { exams, questions, examClasses } from '@modules/exam/exam.schema.js'
import { subjects } from '@modules/question-bank/question-bank.schema.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import { setPlatformSetting, __clearPlatformCache } from '@modules/platform/platform.service.js'
import { examPurchases, payments } from '@modules/payment/payment.schema.js'
import { invites } from '@modules/invite/invite.schema.js'
import type { PlanName } from '@config/plans.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// Lifecycle states in which an exam has become student-visible at least once,
// so `publishedAt` should be stamped (mirrors transitionExam's → live rule).
const PUBLISHED_STATES = new Set<ExamStatus>([
  'live', 'under_evaluation', 'ready_to_publish', 'completed', 'archived',
])

let _counter = 0
const uniq = () => `t${Date.now()}${_counter++}`

// ── Tenant ────────────────────────────────────────────────────────────────

export async function createTestTenant(overrides: {
  slug?: string
  plan?: PlanName
  ownerId?: string
  name?: string
} = {}) {
  const slug = overrides.slug ?? `acme-${uniq()}`
  const ownerId = overrides.ownerId ?? (await createTestUser({ role: 'coaching_owner' })).id

  const [tenant] = await db
    .insert(tenants)
    .values({
      slug,
      name: overrides.name ?? `Acme ${slug}`,
      ownerId,
      plan: overrides.plan ?? 'free',
    })
    .returning()

  // Backfill the owner's tenantId pointer; matches what registerCoaching does.
  await db.update(users).set({ tenantId: tenant.id }).where(eq(users.id, ownerId))

  return tenant
}

// ── User ──────────────────────────────────────────────────────────────────

export async function createTestUser(overrides: {
  role?: 'super_admin' | 'coaching_owner' | 'teacher' | 'student'
  email?: string
  name?: string
  phoneNumber?: string
  tenantId?: string
  emailVerified?: boolean
} = {}) {
  const id = uniq()
  const [user] = await db
    .insert(users)
    .values({
      name: overrides.name ?? `User ${id}`,
      email: overrides.email ?? `${id}@test.local`,
      emailVerified: overrides.emailVerified ?? true,
      phoneNumber: overrides.phoneNumber ?? null,
      role: overrides.role ?? 'student',
      tenantId: overrides.tenantId ?? null,
    })
    .returning()
  return user
}

// ── Membership ────────────────────────────────────────────────────────────

export async function createMembership(params: {
  userId: string
  tenantId: string
  role: 'coaching_owner' | 'teacher' | 'student'
}) {
  const [m] = await db.insert(memberships).values(params).returning()
  return m
}

// ── Class + class member ──────────────────────────────────────────────────

export async function createTestClass(params: {
  tenantId: string
  teacherId: string
  name?: string
  autoApprove?: boolean
}) {
  const [c] = await db
    .insert(classes)
    .values({
      tenantId: params.tenantId,
      teacherId: params.teacherId,
      name: params.name ?? `Class ${uniq()}`,
      autoApprove: params.autoApprove ?? true,
    })
    .returning()
  return c
}

export async function enrollStudent(params: {
  classId: string
  studentId: string
  status?: 'pending' | 'approved' | 'rejected'
}) {
  const [m] = await db
    .insert(classMembers)
    .values({
      classId: params.classId,
      studentId: params.studentId,
      status: params.status ?? 'approved',
    })
    .returning()
  return m
}

// ── Exam ──────────────────────────────────────────────────────────────────

export async function createTestSubject(tenantId: string, name = 'Physics') {
  const [s] = await db
    .insert(subjects)
    .values({ tenantId, name, gradeLevel: '10' })
    .returning()
  return s
}

export async function createTestExam(overrides: {
  tenantId: string
  createdBy: string
  title?: string
  visibility?: 'private' | 'public_free' | 'public_paid'
  // Full 11-state lifecycle (PRD v1). Defaults to `live` — the closest analog to
  // the retired `published` (student-attemptable, marketplace-visible).
  status?: ExamStatus
  price?: string | null
  durationMins?: number
  totalMarks?: number
  maxAttempts?: number
  subjectId?: string
  scheduledAt?: Date | null
  endsAt?: Date | null
  // When the paper entered the review pipeline. This is what the monthly mock
  // quota counts (drafts are free), so tests that exercise plan limits set it
  // explicitly. Defaults to "now" for any post-draft status.
  submittedAt?: Date | null
}) {
  const status = overrides.status ?? 'live'
  const [e] = await db
    .insert(exams)
    .values({
      tenantId: overrides.tenantId,
      createdBy: overrides.createdBy,
      title: overrides.title ?? `Exam ${uniq()}`,
      durationMins: overrides.durationMins ?? 60,
      totalMarks: overrides.totalMarks ?? 100,
      maxAttempts: overrides.maxAttempts ?? 1,
      visibility: overrides.visibility ?? 'private',
      status,
      price: overrides.price ?? null,
      subjectId: overrides.subjectId ?? null,
      scheduledAt: overrides.scheduledAt ?? null,
      endsAt: overrides.endsAt ?? null,
      publishedAt: PUBLISHED_STATES.has(status) ? new Date() : null,
      submittedAt:
        overrides.submittedAt !== undefined
          ? overrides.submittedAt
          : status === 'draft' ? null : new Date(),
    })
    .returning()
  return e
}

export async function linkExamToClass(examId: string, classId: string) {
  const [link] = await db.insert(examClasses).values({ examId, classId }).returning()
  return link
}

export async function createTestQuestion(overrides: {
  examId: string
  tenantId: string
  order?: number
  type?: 'mcq_single' | 'subjective' | 'integer'
  marks?: number
  body?: string
  payload?: Record<string, unknown>
  answerKey?: Record<string, unknown>
}) {
  const [q] = await db
    .insert(questions)
    .values({
      examId: overrides.examId,
      tenantId: overrides.tenantId,
      order: overrides.order ?? 1,
      type: overrides.type ?? 'subjective',
      body: overrides.body ?? 'A particle starts from rest with a = 2 m/s². Find v after 10 s.',
      marks: overrides.marks ?? 10,
      payload: overrides.payload ?? {},
      answerKey: overrides.answerKey ?? {},
    })
    .returning()
  return q
}

// ── Session + answers ─────────────────────────────────────────────────────

export async function createTestSession(overrides: {
  examId: string
  studentId: string
  tenantId: string | null
  totalMarks?: number
  autoScore?: number | null
  manualScore?: number | null
  status?: 'in_progress' | 'submitted' | 'evaluated'
}) {
  const [s] = await db
    .insert(examSessions)
    .values({
      examId: overrides.examId,
      studentId: overrides.studentId,
      tenantId: overrides.tenantId,
      totalMarks: overrides.totalMarks ?? 100,
      autoScore: overrides.autoScore ?? null,
      manualScore: overrides.manualScore ?? null,
      status: overrides.status ?? 'submitted',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      submittedAt: overrides.status === 'in_progress' ? null : new Date(),
    })
    .returning()
  return s
}

export async function createSessionAnswer(params: {
  sessionId: string
  questionId: string
  answer?: Record<string, unknown> | null
  imageUrl?: string | null
  isCorrect?: boolean | null
  awardedMarks?: number | null
}) {
  const [a] = await db
    .insert(sessionAnswers)
    .values({
      sessionId: params.sessionId,
      questionId: params.questionId,
      answer: params.answer ?? null,
      imageUrl: params.imageUrl ?? null,
      isCorrect: params.isCorrect ?? null,
      awardedMarks: params.awardedMarks ?? null,
    })
    .returning()
  return a
}

// ── Evaluation rows ───────────────────────────────────────────────────────

export async function createEvaluationJob(params: {
  sessionId: string
  tenantId: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
}) {
  const [j] = await db
    .insert(evaluationJobs)
    .values({
      sessionId: params.sessionId,
      tenantId: params.tenantId,
      status: params.status ?? 'completed',
    })
    .returning()
  return j
}

export async function createQuestionResult(params: {
  jobId: string
  questionId: string
  score: number
  maxScore: number
  imageUrl: string
  aiFeedback?: string | null
  // Defaults to 'ai', i.e. the machine graded it and nobody had to look. Pass
  // 'needs_human' to stand in for a row the Phase 6 backstop parked.
  reviewStatus?: 'ai' | 'needs_human' | 'resolved'
}) {
  const [r] = await db
    .insert(questionResults)
    .values({
      jobId: params.jobId,
      questionId: params.questionId,
      score: params.score,
      maxScore: params.maxScore,
      imageUrl: params.imageUrl,
      aiFeedback: params.aiFeedback ?? null,
      reviewStatus: params.reviewStatus ?? 'ai',
    })
    .returning()
  return r
}

// ── Payment / purchase ────────────────────────────────────────────────────

export async function createTestPurchase(params: {
  studentId: string
  examId: string
}) {
  const [p] = await db
    .insert(payments)
    .values({
      razorpayOrderId: `order_${uniq()}`,
      studentId: params.studentId,
      amount: '99.00',
      status: 'completed',
    })
    .returning()

  const [purchase] = await db
    .insert(examPurchases)
    .values({
      studentId: params.studentId,
      examId: params.examId,
      paymentId: p.id,
    })
    .returning()

  return { payment: p, purchase }
}

// ── Invite ────────────────────────────────────────────────────────────────

export async function createTestInvite(params: {
  tenantId: string
  invitedBy: string
  contact: string
  contactType?: 'email' | 'phone'
  token?: string
  status?: 'pending' | 'accepted' | 'revoked'
  expiresAt?: Date
}) {
  const token = params.token ?? crypto.randomUUID().replace(/-/g, '')
  const [i] = await db
    .insert(invites)
    .values({
      tenantId: params.tenantId,
      invitedBy: params.invitedBy,
      contact: params.contact,
      contactType: params.contactType ?? 'email',
      role: 'teacher',
      token,
      status: params.status ?? 'pending',
      expiresAt: params.expiresAt ?? new Date(Date.now() + 48 * 60 * 60 * 1000),
    })
    .returning()
  return i
}

// ── Coaching join code ────────────────────────────────────────────────────

export async function createTestCoachingJoinCode(params: {
  tenantId: string
  createdBy: string
  code?: string
  maxUses?: number
  usedCount?: number
  revoked?: boolean
  expiresAt?: Date | null
}) {
  const code = params.code ?? `CODE${uniq().slice(-6).toUpperCase()}`
  const [c] = await db
    .insert(coachingJoinCodes)
    .values({
      tenantId: params.tenantId,
      createdBy: params.createdBy,
      code,
      maxUses: params.maxUses ?? 100,
      usedCount: params.usedCount ?? 0,
      revoked: params.revoked ?? false,
      expiresAt: params.expiresAt ?? null,
    })
    .returning()
  return c
}

// ── Composite helpers ─────────────────────────────────────────────────────

/**
 * Seed a fully-wired tenant: owner, teacher, student, all memberships.
 * Returns the {tenant, owner, teacher, student} bundle.
 */
export async function seedTenantWithUsers(plan: PlanName = 'free') {
  const owner = await createTestUser({ role: 'coaching_owner' })
  const tenant = await createTestTenant({ ownerId: owner.id, plan })
  await createMembership({ userId: owner.id, tenantId: tenant.id, role: 'coaching_owner' })

  const teacher = await createTestUser({ role: 'teacher', tenantId: tenant.id })
  await createMembership({ userId: teacher.id, tenantId: tenant.id, role: 'teacher' })

  const student = await createTestUser({ role: 'student', tenantId: tenant.id })
  await createMembership({ userId: student.id, tenantId: tenant.id, role: 'student' })

  return { tenant, owner, teacher, student }
}

// ── Platform switches ─────────────────────────────────────────────────────

/**
 * Turn the platform billing switch on (or off) for the current test.
 *
 * `billing_enabled` defaults to FALSE — the MVP posture — and while it is off
 * `assertWithinLimit` / `assertHasFeature` return immediately without counting
 * anything. So any test asserting that a quota or feature gate *fires* must call
 * this first, or it passes vacuously: the expectation becomes
 * "resolved undefined instead of rejecting", which reads like a broken limit
 * rather than a suspended one.
 *
 * Clears the service's 15s memo as well as writing the row — that cache easily
 * outlives a whole test file, so a suite that only wrote the row would inherit
 * whatever the previously-run file left in memory.
 *
 * @example
 * describe('some quota', () => {
 *   beforeEach(() => setBillingEnabled(true))
 * })
 */
export async function setBillingEnabled(enabled: boolean): Promise<void> {
  await setPlatformSetting('billing_enabled', enabled, '00000000-0000-0000-0000-000000000000')
  __clearPlatformCache()
}
