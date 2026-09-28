import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { exams, questions } from '@modules/exam/exam.schema.js'
import { tenants } from '@modules/tenant/tenant.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { BLANK_PAGE_AUTO_ZERO_REASON } from './evaluation.blank-page.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE BLANK-PAGE AUDIT — spot-checking the detector, not gating anything.
//
// WHAT THIS IS FOR
// `evaluation.service.ts` auto-scores a confirmed-blank page 0 the moment the
// pixel detector says so — no human in the loop, by design (client decision,
// 2026-08-24, see docs/decisions and the blank-page checklist). This file is
// what lets a Gyaanverse operator sample those decisions afterwards and answer
// "how often is the detector actually right?"
//
// THE ONE THING THIS IS NOT: a review gate. Unlike `evaluation.review.ts`'s
// `needs_human` queue, a row here has ALREADY completed — its job is
// `completed`, its exam is free to publish, its report may already be built
// and read. Nothing here blocks anything. "Not blank" is a correction applied
// after the fact, not a release of something that was held up.
//
// WHY IT REUSES `reviewed_by` / `reviewed_at` / `review_note` INSTEAD OF NEW
// COLUMNS: those three already mean exactly "a Gyaanverse operator looked at
// this row", regardless of which queue sent them here. Reusing them means an
// operator's audit trail reads the same way whether they came from the
// needs_human queue or this one — one investigator, not two vocabularies.
//
// SAME "LEAF" RULE AS evaluation.review.ts: only imports the database, table
// definitions and evaluation.blank-page.ts's constant. See that file's header
// for why (avoiding an import cycle through report.service → exam.service).
// ─────────────────────────────────────────────────────────────────────────────

export interface BlankPageAuditItem {
  resultId: string
  jobId: string
  sessionId: string
  questionId: string
  examId: string
  examTitle: string
  tenantId: string
  tenantName: string
  studentName: string
  questionBody: string
  maxScore: number
  imageUrl: string
  /** null = not yet audited by anyone. */
  reviewedBy: string | null
  reviewedAt: Date | null
  reviewNote: string | null
  /** 'ai' = confirmed blank (or not yet audited); 'resolved' = corrected. */
  reviewStatus: string
  /** The corrected score, once an operator has overturned the auto-zero. */
  score: number
  createdAt: Date
}

/**
 * The join every function in this file needs, factored out once. Not a query
 * builder abstraction — just the one `select({...}).from(...).innerJoin(...)`
 * chain that both `listBlankPageAudit` and `getBlankPageAuditItem` would
 * otherwise duplicate verbatim.
 */
function auditItemQuery() {
  return db
    .select({
      resultId: questionResults.id,
      jobId: questionResults.jobId,
      sessionId: evaluationJobs.sessionId,
      questionId: questionResults.questionId,
      examId: examSessions.examId,
      examTitle: exams.title,
      tenantId: evaluationJobs.tenantId,
      tenantName: tenants.name,
      studentName: users.name,
      questionBody: questions.body,
      maxScore: questionResults.maxScore,
      imageUrl: questionResults.imageUrl,
      reviewedBy: questionResults.reviewedBy,
      reviewedAt: questionResults.reviewedAt,
      reviewNote: questionResults.reviewNote,
      reviewStatus: questionResults.reviewStatus,
      score: questionResults.score,
      createdAt: evaluationJobs.createdAt,
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
    .innerJoin(users, eq(users.id, examSessions.studentId))
    .innerJoin(questions, eq(questions.id, questionResults.questionId))
}

/**
 * The audit sample: every row the blank-page detector auto-zeroed, most
 * recent first. `reviewed` narrows to already-audited (true) or still-open
 * (false) rows; omitted, it returns both — an operator picking a random one
 * from thousands doesn't care which bucket it's in.
 */
export async function listBlankPageAudit(
  opts: { tenantId?: string; reviewed?: boolean; limit?: number; offset?: number } = {},
): Promise<{ items: BlankPageAuditItem[]; total: number }> {
  const where = and(
    eq(questionResults.autoZeroReason, BLANK_PAGE_AUTO_ZERO_REASON),
    opts.tenantId ? eq(evaluationJobs.tenantId, opts.tenantId) : undefined,
    opts.reviewed === true ? sql`${questionResults.reviewedBy} is not null` : undefined,
    opts.reviewed === false ? isNull(questionResults.reviewedBy) : undefined,
  )

  const items = await auditItemQuery()
    .where(where)
    .orderBy(desc(evaluationJobs.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)

  const [totalRow] = await db
    .select({ n: count() })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .where(where)

  return { items, total: totalRow?.n ?? 0 }
}

/**
 * ONE row, by id — unlike the `needs_human` review queue, this list is not
 * "small and bounded" (the whole point is it can run into the thousands), so
 * a detail screen cannot assume the row it wants is sitting in whatever page
 * of the list it last fetched. `null` covers both "no such result" and "this
 * result was never auto-zeroed" — the route turns either into a 404.
 */
export async function getBlankPageAuditItem(resultId: string): Promise<BlankPageAuditItem | null> {
  const [item] = await auditItemQuery()
    .where(
      and(eq(questionResults.id, resultId), eq(questionResults.autoZeroReason, BLANK_PAGE_AUTO_ZERO_REASON)),
    )
    .limit(1)
  return item ?? null
}

export interface BlankPageAuditSummary {
  /** Every row the detector has ever auto-zeroed. */
  totalAutoZeroed: number
  /** Sampled by an operator, either way. */
  reviewed: number
  /** Still un-sampled. */
  unreviewed: number
  /** Operator agreed it was blank. */
  confirmed: number
  /** Operator overturned it — a real answer the detector missed. */
  falsePositive: number
  /**
   * `confirmed / reviewed`, as a percentage rounded to one decimal. `null`
   * until at least one row has been sampled — reporting "100% accurate" off
   * zero samples would be worse than reporting nothing.
   */
  accuracyPct: number | null
}

/**
 * Counts only — the number an operator actually wants before diving into a
 * sample of potentially thousands of rows: "how much of this have we actually
 * checked, and how good does the detector look so far?"
 */
export async function getBlankPageAuditSummary(): Promise<BlankPageAuditSummary> {
  const base = eq(questionResults.autoZeroReason, BLANK_PAGE_AUTO_ZERO_REASON)

  const [totalRow] = await db.select({ n: count() }).from(questionResults).where(base)
  const [reviewedRow] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(and(base, sql`${questionResults.reviewedBy} is not null`))
  const [confirmedRow] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(
      and(base, sql`${questionResults.reviewedBy} is not null`, eq(questionResults.reviewStatus, 'ai')),
    )
  const [falsePositiveRow] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(and(base, eq(questionResults.reviewStatus, 'resolved')))

  const totalAutoZeroed = totalRow?.n ?? 0
  const reviewed = reviewedRow?.n ?? 0
  const confirmed = confirmedRow?.n ?? 0
  const falsePositive = falsePositiveRow?.n ?? 0

  return {
    totalAutoZeroed,
    reviewed,
    unreviewed: totalAutoZeroed - reviewed,
    confirmed,
    falsePositive,
    accuracyPct: reviewed > 0 ? Math.round((confirmed / reviewed) * 1000) / 10 : null,
  }
}

async function loadAuditableRow(resultId: string) {
  const [row] = await db
    .select({
      id: questionResults.id,
      autoZeroReason: questionResults.autoZeroReason,
      reviewedBy: questionResults.reviewedBy,
      maxScore: questionResults.maxScore,
      jobId: questionResults.jobId,
      sessionId: evaluationJobs.sessionId,
      tenantId: evaluationJobs.tenantId,
      examId: examSessions.examId,
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(eq(questionResults.id, resultId))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND('Evaluation result')
  if (row.autoZeroReason !== BLANK_PAGE_AUTO_ZERO_REASON)
    throw new AppError('CONFLICT', 'This answer was not auto-zeroed by the blank-page detector', 409)
  if (row.reviewedBy)
    throw new AppError('CONFLICT', 'This answer has already been audited', 409)
  return row
}

/**
 * The detector was right. No score change — it is already 0 — just a stamp
 * recording that a person looked and agreed, using the same reviewer columns
 * the needs_human queue uses.
 */
export async function confirmBlankPage(params: {
  resultId: string
  reviewerId: string
  note?: string
}): Promise<{ resultId: string }> {
  const row = await loadAuditableRow(params.resultId)

  const updated = await db
    .update(questionResults)
    .set({
      reviewedBy: params.reviewerId,
      reviewedAt: new Date(),
      reviewNote: params.note ?? null,
    })
    .where(and(eq(questionResults.id, row.id), isNull(questionResults.reviewedBy)))
    .returning({ id: questionResults.id })
  if (updated.length === 0)
    throw new AppError('CONFLICT', 'This answer has already been audited', 409)

  return { resultId: row.id }
}

export interface FalsePositiveResult {
  resultId: string
  sessionId: string
  examId: string
  tenantId: string
  score: number
  /** Always 0 — what the detector produced, kept for the record. */
  aiScore: number
  /** The session's new subjective total, after this correction. */
  sessionScore: number
}

/**
 * The detector was WRONG — there was a real answer on the page. An operator
 * types the correct score, exactly like `overrideQuestionResult` does for the
 * needs_human queue, but this never touches `needs_human`/the publish gate:
 * the exam may already be published and the student may already have their
 * report, so this is a correction to an existing result, not a release of a
 * held one. The caller (the route) is responsible for rebuilding the report
 * afterwards — same split as `overrideQuestionResult`, for the same reason
 * (this file must stay a leaf; see the header).
 */
export async function correctBlankPageFalsePositive(params: {
  resultId: string
  score: number
  note?: string
  reviewerId: string
}): Promise<FalsePositiveResult> {
  const row = await loadAuditableRow(params.resultId)

  if (!Number.isInteger(params.score) || params.score < 0 || params.score > row.maxScore)
    throw Errors.VALIDATION(`score must be an integer between 0 and ${row.maxScore}`)

  const now = new Date()
  const updated = await db
    .update(questionResults)
    .set({
      score: params.score,
      // The detector's own verdict, preserved — same reasoning as `ai_score` on
      // the needs_human override: without it, "what did the auto-zero actually
      // produce?" is destroyed the moment it is corrected.
      aiScore: 0,
      reviewStatus: 'resolved',
      reviewedBy: params.reviewerId,
      reviewedAt: now,
      reviewNote: params.note ?? null,
    })
    .where(and(eq(questionResults.id, row.id), isNull(questionResults.reviewedBy)))
    .returning({ id: questionResults.id })
  if (updated.length === 0)
    throw new AppError('CONFLICT', 'This answer has already been audited', 409)

  const [rollup] = await db
    .select({ total: sql<number>`coalesce(sum(${questionResults.score}), 0)::int` })
    .from(questionResults)
    .where(eq(questionResults.jobId, row.jobId))
  const sessionScore = rollup?.total ?? 0

  await db
    .update(examSessions)
    .set({ manualScore: sessionScore })
    .where(eq(examSessions.id, row.sessionId))

  console.log(
    `[blank-page-audit] false positive result=${row.id} session=${row.sessionId} ` +
      `by=${params.reviewerId} score=${params.score}/${row.maxScore} sessionScore=${sessionScore}`,
  )

  return {
    resultId: row.id,
    sessionId: row.sessionId,
    examId: row.examId,
    tenantId: row.tenantId,
    score: params.score,
    aiScore: 0,
    sessionScore,
  }
}
