import type { JobsOptions } from 'bullmq'
import type { EvaluationFailureClass } from './evaluation.types.js'

// ── The retry rules ───────────────────────────────────────────────────────
//
// WHAT THIS FILE IS
// The settings file for "when something goes wrong, when do we try again?".
// It holds only numbers and small decision functions — it never touches the
// database and never calls the AI engine. Every other file in this folder asks
// this one for the answer.
//
// WHY IT IS SEPARATE
// Two different parts of the system need the same answer:
//   1. BullMQ (the queue library in worker.ts) needs to know how long to wait
//      before running the job again.
//   2. evaluation.service.ts writes that same wait time into the database
//      column `next_retry_at` when a job fails.
// If those two ever disagree, the reconciler sees a job whose `next_retry_at`
// has passed, thinks nobody is handling it, and adds a SECOND copy to the queue
// while BullMQ is still holding the first one in its `delayed` state. So there
// is one function here, it always returns the same answer for the same input,
// and both sides call it.
//
// IF YOU CHANGE THE NUMBERS HERE
// Nothing breaks immediately — but the behaviour of the whole pipeline shifts,
// because the reconciler, the backstop and the ops screens all read them.

/** The first wait, after the first failed try: 5 seconds. */
const BASE_DELAY_MS = 5_000
/** The longest we ever wait between tries: 30 minutes. */
const MAX_DELAY_MS = 30 * 60_000

/**
 * How many times the queue will run one job before it stops trying.
 *
 * 50 is intentionally a big number. Example of why: the AI engine goes down for
 * 2 hours. If this were 3, every job in the system would use up all three tries
 * within the first 35 seconds, and then every exam would be stuck in
 * `under_evaluation` forever with nothing left to run them.
 *
 * With the waiting times below, 50 tries stretch over roughly 20 hours of
 * continuous downtime. And a job that is genuinely hopeless does not waste all
 * 50 — a `permanent` or `needs_human` failure jumps straight out (see
 * `isTerminal`).
 */
export const MAX_ATTEMPTS = 50

/**
 * How many tries a paper gets to produce *something readable* before we stop
 * blaming the engine and start blaming the photo.
 *
 * Three runs in a row that come back with nothing is not a temporary glitch —
 * the photo is blank, too dark, or unreadable, and a person has to look at it.
 *
 * Two different error codes can land here, because both really happen:
 *   OCR_EMPTY   the text-reader found no text at all (or only empty text)
 *   EVAL_EMPTY  text was found, but the grader returned zero scored steps
 */
export const UNGRADEABLE_ATTEMPTS = 3

// ── The backstop limits ───────────────────────────────────────────────────
//
// Everything above is the promise that evaluation KEEPS TRYING. The two numbers
// below are the promise that it eventually STOPS. Both promises were asked for,
// and a blank photo is the one input where they contradict each other:
//
//   "AI evaluation must never look like it failed"  → never give up
//   "one student must not block the whole class"    → you must give up sometime
//
// The agreed answer (client decision, 2026-08-12): keep trying, but only up to
// these limits. Past them the session is closed anyway, the unread answers are
// marked `needs_human`, the exam moves on to `ready_to_publish`, and a Gyaanverse
// staff member — never the coaching's teacher — grades those answers by hand.
// Full write-up: docs/decisions/2026-08-12-evaluation-backstop.md.

/**
 * TIME LIMIT — how long one job may stay unfinished before the backstop closes
 * it out.
 *
 * Counted from when the row was created in `evaluation_jobs`, i.e. from the
 * moment the student submitted. So it answers "how long has this student been
 * waiting for a mark?", not "how long since the last of fifty tries?" (that
 * second clock keeps resetting and would never reach six hours).
 *
 * Six hours is chosen so that anything reaching it has already survived every
 * automatic repair the system has, and so a Gyaanverse operator still has a
 * window to step in before a placeholder 0 gets written.
 */
export const BACKSTOP_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * TRY LIMIT — how many tries a job that still looks fixable may use before the
 * backstop treats it as hopeless anyway.
 *
 * Jobs already marked `needs_human` or `permanent` are finished failing; they
 * only sit and wait out the time limit above. This number is for the other
 * situation: the engine has been down so long that the reconciler keeps putting
 * the job back on the queue forever. This is the number that stops that loop.
 *
 * BOTH limits must be reached, never just one. Example: a job burns 30 tries in
 * the first hour of an outage. The engine could still come back and grade that
 * paper properly, so closing it out at that point would flag a paper that was
 * never actually unreadable.
 */
export const BACKSTOP_MAX_ATTEMPTS = 30

/**
 * How long to wait before the next try. The wait doubles each time, up to a
 * 30-minute ceiling.
 *
 * `attemptsMade` counts from 1, and the number returned is the wait AFTER that
 * try failed:
 *
 *   1 → 5s   2 → 10s   3 → 20s   …   9 → 21m   10+ → 30m (never longer)
 *
 * Waiting longer each time is the point: if the engine is down, hammering it
 * every 5 seconds neither helps it recover nor tells us anything new.
 */
export function retryDelayMs(attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1)
  // Stop before the doubling grows past what a number can hold. On try 40 the
  // maths would otherwise produce Infinity.
  if (exponent > 30) return MAX_DELAY_MS
  return Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS)
}

/** The same function, handed to the queue library as its wait-time strategy. */
export function evaluationBackoffStrategy(attemptsMade: number): number {
  return retryDelayMs(attemptsMade)
}

/**
 * Look at the error code and decide what kind of failure this is.
 *
 * Anything we do not recognise is treated as `transient` (worth retrying) on
 * purpose. Getting this wrong in that direction only wastes some computing
 * time; getting it wrong the other way leaves a whole class permanently stuck.
 *
 * `attemptsMade` only changes the answer for the unreadable-photo codes.
 * Everything else is classified the same on try 1 as on try 40.
 */
export function classifyFailure(code: string, attemptsMade: number): EvaluationFailureClass {
  switch (code) {
    case 'NOT_FOUND':
      // The session or the exam row was deleted. Running this again cannot
      // bring it back, so do not waste tries on it.
      return 'permanent'
    case 'OCR_EMPTY':
    case 'EVAL_EMPTY':
      // Worth retrying — until the 3 tries are used up. After that it is a
      // person's job, not the machine's.
      return attemptsMade >= UNGRADEABLE_ATTEMPTS ? 'needs_human' : 'transient'
    case 'ENGINE_TIMEOUT':
    case 'ENGINE_UNREACHABLE':
    case 'ENGINE_ERROR':
    case 'ENGINE_BAD_RESPONSE':
      return 'transient'
    default:
      return 'transient'
  }
}

/** True when trying again cannot possibly help. Only `transient` is worth a retry. */
export function isTerminal(failureClass: EvaluationFailureClass): boolean {
  return failureClass !== 'transient'
}

/**
 * The settings used EVERY time a job is put on the queue — the first time, and
 * every repair afterwards (reconciler, force-retry).
 *
 * Kept in one place because if one caller used its own settings, that job would
 * quietly get a different number of tries than the rest and nobody would notice
 * until an exam got stuck.
 *
 * `removeOnFail` keeps failed jobs around for 7 days on purpose. The reconciler
 * decides a job is lost by checking whether the queue still knows about it — so
 * if we deleted failed jobs quickly, the reconciler would think they were lost
 * and start putting duplicates back. Keeping them is what prevents that.
 */
export const EVALUATION_JOB_OPTS: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
}
