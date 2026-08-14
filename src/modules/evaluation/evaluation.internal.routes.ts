import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '@shared/errors.js'
import { internalAuth, logInternalAction } from '@middleware/internal.js'
import { recomputeReportForSession } from '@modules/report/report.service.js'
import {
  getReviewQueueSummary,
  listReviewQueue,
  overrideQuestionResult,
} from './evaluation.review.js'
import { forceRetryJob, getEvaluationOverview, listActionableJobs } from './evaluation.ops.js'

// ─────────────────────────────────────────────────────────────────────────────
// `/internal/evaluation/*` — THE API FOR GYANVERSE'S OWN STAFF.
//
// These are the URLs the internal ops panel calls. Three things make this file
// different from every other route file in the codebase:
//
//   1. **IT IS NOT SPLIT PER COACHING.** No tenant middleware, no tenant role
//      check. The whole value of this queue is being able to see that four
//      different coachings are all failing on the same OCR error — which a
//      per-coaching view cannot show by definition.
//
//   2. **`super_admin` ONLY, plus a recent-login requirement.** That is what the
//      shared `internalAuth` chain does. It checks the account's GLOBAL role,
//      never the role inside a coaching — a coaching owner holds
//      `coaching_owner` in their own tenant and must never reach these routes.
//
//   3. **IT IS DELIBERATELY NOT A TEACHER SCREEN.** Answers marked `needs_human`
//      go to Gyanverse staff, not to the coaching. Showing a teacher a "the AI
//      couldn't read this, please fix it" task is exactly the AI failure the
//      client asked us to hide. Decision of 2026-08-12.
//
// `hide: true` on every route keeps them out of the public API documentation.
// They are not part of what we promise to coachings, and listing them there
// would just advertise them to everyone integrating with our API.
// ─────────────────────────────────────────────────────────────────────────────

const overrideSchema = z.object({
  score: z.number().int().min(0),
  note: z.string().max(2000).optional(),
})

const listSchema = z.object({
  tenantId: z.string().uuid().optional(),
  examId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const jobListSchema = z.object({
  status: z.enum(['pending', 'processing', 'failed', 'completed']).optional(),
  failureClass: z.enum(['transient', 'permanent', 'needs_human']).optional(),
  tenantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export async function evaluationInternalRoutes(app: FastifyInstance) {
  // ── The whole picture, in one call ───────────────────────────────────────
  //
  // One endpoint rather than four separate ones, because it is one screen
  // answering one question.
  //
  // It fails in PARTS, not all at once: if Redis is down, the queue and drift
  // sections come back with an error marker and everything from Postgres — above
  // all, how many students are waiting — still renders. That is the half that
  // matters most on exactly the day Redis is down.

  app.get('/internal/evaluation/overview', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async () => getEvaluationOverview())

  // ── The job list ─────────────────────────────────────────────────────────
  //
  // The review queue further down lists flagged ANSWERS, and those only exist
  // after the backstop has closed a session out. This route lists JOBS instead.
  //
  // That makes it the only place an operator can reach a failure during the six
  // hours BEFORE the backstop acts — or one whose close-out wrote no
  // placeholders and would otherwise never appear anywhere clickable at all.
  //
  // `force-retry` below needs a `jobId`. This is where those ids come from.

  app.get('/internal/evaluation/jobs', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async (req) => {
    const parsed = jobListSchema.safeParse(req.query)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    return listActionableJobs(parsed.data)
  })

  // ── The review queue ─────────────────────────────────────────────────────

  app.get('/internal/evaluation/review-queue', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async (req) => {
    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    return listReviewQueue(parsed.data)
  })

  app.get('/internal/evaluation/review-queue/summary', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async () => getReviewQueueSummary())

  // ── Score a flagged answer by hand ───────────────────────────────────────
  //
  // The last resort, when the photo genuinely cannot be read by the AI. An
  // operator looks at the image and types in the mark themselves.

  app.post('/internal/evaluation/results/:resultId/override', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async (req) => {
    const { resultId } = req.params as { resultId: string }
    const parsed = overrideSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    const result = await overrideQuestionResult({
      resultId,
      score: parsed.data.score,
      note: parsed.data.note,
      reviewerId: req.user!.id,
    })

    // TWO CALLS INSTEAD OF ONE, and it has to stay that way. Rebuilding the
    // report cannot happen inside `overrideQuestionResult`, because
    // `evaluation.review.ts` must not import `report.service` — that would create
    // a circle of imports (report.service → exam.service → evaluation.review)
    // and the app would refuse to start. See the header of evaluation.review.ts.
    //
    // It runs AFTER the score is saved, and we wait for it: the report is what
    // the student actually reads, and telling an operator "resolved" while the
    // student still sees the placeholder 0 would be telling them something false.
    const report = await recomputeReportForSession(result.sessionId)

    // The audit record is written last, after both writes have succeeded — never
    // before. The trail should say what actually happened, and a log entry
    // claiming a correction that then failed to reach the student is worse than
    // no entry at all. (`logInternalAction` handles its own errors, so a logging
    // problem can never undo the operator's work.)
    await logInternalAction({
      actorId: req.user!.id,
      action: 'evaluation.override',
      targetId: result.resultId,
      tenantId: result.tenantId,
      metadata: {
        sessionId: result.sessionId,
        examId: result.examId,
        score: result.score,
        aiScore: result.aiScore,
        note: parsed.data.note ?? null,
        remainingForExam: result.remainingForExam,
      },
    })

    return { ...result, report }
  })

  // ── Run it again ─────────────────────────────────────────────────────────
  //
  // TRY THIS BEFORE grading by hand. If the re-run succeeds it clears the flag,
  // clears `settled_at` and unlocks the teacher's publish button — with nobody
  // having had to read a student's handwriting at all.

  app.post('/internal/evaluation/jobs/:jobId/force-retry', {
    schema: { hide: true, tags: ['Internal'] },
    preHandler: internalAuth,
  }, async (req) => {
    const { jobId } = req.params as { jobId: string }
    const result = await forceRetryJob(jobId)

    await logInternalAction({
      actorId: req.user!.id,
      action: 'evaluation.force_retry',
      targetId: jobId,
      metadata: {
        previousStatus: result.previousStatus,
        leaseWasLive: result.leaseWasLive,
        attempts: result.attempts,
        flaggedAnswers: result.flaggedAnswers,
      },
    })

    return result
  })
}
