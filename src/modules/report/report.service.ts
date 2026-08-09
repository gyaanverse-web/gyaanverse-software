import { and, desc, eq, or, inArray } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { reports, reportItems } from './report.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { exams, questions } from '@modules/exam/exam.schema.js'
import { assertResultsVisible } from '@modules/exam/exam.service.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import { dispatch } from '@modules/notification/index.js'
import type {
  ReportDetail, ReportItem, ReportStatus, ReportSummary, TeacherReportSummary,
} from './report.types.js'

// ── Publish ───────────────────────────────────────────────────────────────

/**
 * Idempotent publish. Aggregates session answers + AI question_results into
 * a `reports` row + `report_items` rows, marks status='ready', dispatches the
 * student notification. Safe to call from both the eval worker AND the
 * objective-only submit path — second call returns the existing report.
 */
export async function createReportForSession(sessionId: string): Promise<{ reportId: string; created: boolean }> {
  // 1. Resolve session + exam (need exam.tenantId for the report owner)
  const [session] = await db
    .select()
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')

  const [exam] = await db
    .select({ id: exams.id, title: exams.title, tenantId: exams.tenantId, visibility: exams.visibility })
    .from(exams)
    .where(eq(exams.id, session.examId))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  // 2. Idempotency — if a report already exists, return it
  const [existing] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.sessionId, sessionId))
    .limit(1)
  if (existing) return { reportId: existing.id, created: false }

  // 3. Gather scoring inputs
  const autoScore = session.autoScore ?? 0
  const aiScore = session.manualScore ?? 0
  const totalScore = autoScore + aiScore
  const maxScore = session.totalMarks

  const answers = await db
    .select({
      questionId: sessionAnswers.questionId,
      isCorrect: sessionAnswers.isCorrect,
      awardedMarks: sessionAnswers.awardedMarks,
      imageUrl: sessionAnswers.imageUrl,
    })
    .from(sessionAnswers)
    .where(eq(sessionAnswers.sessionId, sessionId))

  const questionRows = await db
    .select({
      id: questions.id,
      type: questions.type,
      marks: questions.marks,
    })
    .from(questions)
    .where(eq(questions.examId, session.examId))

  // AI results joined through evaluation_jobs so we only pull rows belonging
  // to this session (retries delete prior rows, so there's at most one set).
  const aiResults = await db
    .select({
      questionId: questionResults.questionId,
      score: questionResults.score,
      maxScore: questionResults.maxScore,
      aiFeedback: questionResults.aiFeedback,
      imageUrl: questionResults.imageUrl,
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .where(eq(evaluationJobs.sessionId, sessionId))

  const answerByQ = new Map(answers.map((a) => [a.questionId, a]))
  const aiByQ = new Map(aiResults.map((r) => [r.questionId, r] as const))

  // 4. Persist report + items atomically
  const reportId = await db.transaction(async (tx) => {
    const [report] = await tx
      .insert(reports)
      .values({
        sessionId,
        studentId: session.studentId,
        examId: session.examId,
        tenantId: exam.tenantId,
        totalScore,
        maxScore,
        autoScore,
        aiScore,
        status: 'ready' satisfies ReportStatus,
        publishedAt: new Date(),
      })
      .returning({ id: reports.id })

    const itemRows = questionRows.map((q) => {
      const ai = aiByQ.get(q.id)
      const ans = answerByQ.get(q.id)
      if (ai) {
        return {
          reportId: report.id,
          questionId: q.id,
          score: ai.score,
          maxScore: ai.maxScore,
          feedback: ai.aiFeedback,
          imageUrl: ai.imageUrl,
        }
      }
      return {
        reportId: report.id,
        questionId: q.id,
        score: ans?.awardedMarks ?? 0,
        maxScore: q.marks,
        feedback: null,
        imageUrl: ans?.imageUrl ?? null,
      }
    })

    if (itemRows.length > 0) {
      await tx.insert(reportItems).values(itemRows)
    }

    return report.id
  })

  // 5. Notify student. Fire-and-forget — notification failures must not
  // prevent the report from being marked ready.
  //
  // Private (coaching) exams gate results behind the teacher's publish step, so
  // we must NOT tell the student their report is ready here — that notification
  // fires from the `completed` transition, which is the publish. Public
  // marketplace exams are self-paced and notify immediately.
  if (exam.visibility !== 'private') {
    void dispatch({
      type: 'result_ready',
      recipients: { userIds: [session.studentId] },
      tenantId: session.tenantId,
      data: {
        title: 'Your report is ready',
        body: `Your ${exam.title} report has been published. You scored ${totalScore} out of ${maxScore}.`,
        link: `/student/exams/${session.examId}/results/${sessionId}`,
        metadata: { reportId, sessionId, examId: session.examId },
      },
    })
  }

  return { reportId, created: true }
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function getReportForStudent(sessionId: string, studentId: string) {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.sessionId, sessionId), eq(reports.studentId, studentId)))
    .limit(1)
  if (!report) return null

  // Private exams hide the report until the teacher publishes results.
  await assertResultsVisible(report.examId)

  const items = await loadReportItems(report.id)
  return { ...report, items }
}

export async function getReportForTenant(reportId: string, tenantId: string): Promise<ReportDetail> {
  const [row] = await db
    .select({
      report: reports,
      studentName: users.name,
      studentEmail: users.email,
    })
    .from(reports)
    .innerJoin(users, eq(users.id, reports.studentId))
    .where(and(eq(reports.id, reportId), eq(reports.tenantId, tenantId)))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND('Report')

  const items = await loadReportItems(row.report.id)
  return {
    ...row.report,
    // The column is a varchar; the union lives in the type layer.
    status: row.report.status as ReportStatus,
    studentName: row.studentName,
    studentEmail: row.studentEmail,
    items,
  }
}

export async function listReportsForStudent(studentId: string): Promise<ReportSummary[]> {
  return db
    .select({
      id: reports.id,
      sessionId: reports.sessionId,
      examId: reports.examId,
      examTitle: exams.title,
      studentId: reports.studentId,
      totalScore: reports.totalScore,
      maxScore: reports.maxScore,
      autoScore: reports.autoScore,
      aiScore: reports.aiScore,
      status: reports.status,
      publishedAt: reports.publishedAt,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(exams, eq(exams.id, reports.examId))
    .where(
      and(
        eq(reports.studentId, studentId),
        // Private exams appear in the list only once results are published —
        // which is the `completed` status, since publishing finishes the
        // lifecycle. Public (self-paced) exam reports are always visible.
        or(
          inArray(exams.visibility, ['public_free', 'public_paid']),
          inArray(exams.status, ['completed']),
        ),
      ),
    )
    .orderBy(desc(reports.createdAt)) as Promise<ReportSummary[]>
}

export async function listReportsForExam(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
): Promise<TeacherReportSummary[]> {
  const [exam] = await db
    .select({ id: exams.id, createdBy: exams.createdBy })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (requesterRole !== 'coaching_owner' && exam.createdBy !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only view reports for exams you created', 403)
  }

  return db
    .select({
      id: reports.id,
      sessionId: reports.sessionId,
      examId: reports.examId,
      examTitle: exams.title,
      studentId: reports.studentId,
      studentName: users.name,
      studentEmail: users.email,
      totalScore: reports.totalScore,
      maxScore: reports.maxScore,
      autoScore: reports.autoScore,
      aiScore: reports.aiScore,
      status: reports.status,
      publishedAt: reports.publishedAt,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(exams, eq(exams.id, reports.examId))
    .innerJoin(users, eq(users.id, reports.studentId))
    .where(eq(reports.examId, examId))
    // Marks lists are read by name, not by recency — a reviewer scanning for a
    // student should not have to hunt through submission order.
    .orderBy(users.name) as Promise<TeacherReportSummary[]>
}

// ── Internal ──────────────────────────────────────────────────────────────

async function loadReportItems(reportId: string): Promise<ReportItem[]> {
  return db
    .select()
    .from(reportItems)
    .where(eq(reportItems.reportId, reportId))
}
