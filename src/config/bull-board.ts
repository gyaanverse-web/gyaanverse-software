import type { FastifyInstance } from 'fastify'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js'
import { FastifyAdapter } from '@bull-board/fastify'
import { getEvaluationQueue } from '@modules/evaluation/evaluation.service.js'
import { getEmailQueue, getSmsQueue, getBulkQueue } from '@modules/notification/notification.queues.js'
import { getExamLifecycleQueue } from '@modules/exam/exam.scheduler.js'
import { getReconcilerQueue } from '@modules/evaluation/evaluation.reconciler.js'
import { mountOpsSurface } from './ops-surface.js'
import { env } from './env.js'

// ─────────────────────────────────────────────────────────────────────────────
// Bull Board — the fallback ops surface.
//
// The operator panel built in Phase 7 covers evaluation and will cover only
// evaluation for a long time. Everything else in this system that runs on a
// queue — email, SMS, bulk fan-out, the exam lifecycle tick, the reconciler —
// is observable here or nowhere, which is why this is worth having in
// production and not just in dev.
//
// It is also, unavoidably, a *write* surface: the UI can retry, promote, and
// delete jobs, across every tenant, with no audit trail (`logInternalAction`
// covers `/internal/*`, not this). That asymmetry is why it goes through
// `mountOpsSurface` — the shared fail-closed rule in config/ops-surface.ts —
// rather than being registered directly:
//
//   - **Fail closed.** No `BULL_BOARD_PASSWORD` in production means the board is
//     never registered. Not registered-and-open, not registered-and-warning —
//     absent. The alternative failure mode is a public queue console, which is
//     considerably worse than a missing one.
//   - **Basic auth, not the session cookie.** This is the surface you reach for
//     when the app is broken; making it depend on better-auth, Postgres and a
//     working `users` table couples it to the machinery it exists to diagnose.
//     A shared secret has no per-actor trail — the exact objection that pushed
//     `/internal/*` onto `super_admin` — but the trade lands differently here:
//     that route group *writes scores*, this one restarts jobs, and its whole
//     value is being reachable during an incident.
//
// Swagger: every route under `/queues` is excluded, by three independent
// mechanisms — @bull-board/fastify sets `schema.hide` on its own routes,
// @fastify/static defaults `schemaHide` to true for the asset route, and the
// `onRoute` hook below forces it regardless. Belt and braces because the first
// two are library defaults that a version bump could quietly change, and the
// failure is silent: a queue console advertised in the public API docs.
// ─────────────────────────────────────────────────────────────────────────────

export function createBoard() {
  const serverAdapter = new FastifyAdapter()
  serverAdapter.setBasePath('/queues')

  createBullBoard({
    queues: [
      new BullMQAdapter(getEvaluationQueue()),
      new BullMQAdapter(getEmailQueue()),
      new BullMQAdapter(getSmsQueue()),
      new BullMQAdapter(getBulkQueue()),
      new BullMQAdapter(getExamLifecycleQueue()),
      // The reconciler is the hardest component to observe from anywhere else:
      // when it is working, it logs nothing and leaves no trace beyond a job row
      // quietly going back to `pending`. Its repeat schedule showing up here is
      // the cheapest way to answer "is the self-healing actually armed?".
      new BullMQAdapter(getReconcilerQueue()),
    ],
    serverAdapter,
  })

  return serverAdapter
}

/** Mount `/queues`, or deliberately don't. See config/ops-surface.ts for the policy. */
export async function registerBullBoard(app: FastifyInstance): Promise<void> {
  await mountOpsSurface(app, {
    name: 'queue dashboard (/queues)',
    passwordVar: 'BULL_BOARD_PASSWORD',
    user: env.BULL_BOARD_USER,
    password: env.BULL_BOARD_PASSWORD,
    ips: env.BULL_BOARD_IPS,
    register: async (scope) => {
      // Force `hide` on every route this subtree registers — the board's own
      // routes, the static asset route, and anything a future version adds.
      // Cheap insurance against a library default changing under us; the failure
      // it prevents is silent, which is the kind worth paying for.
      scope.addHook('onRoute', (route) => {
        route.schema = { ...route.schema, hide: true }
      })

      await scope.register(createBoard().registerPlugin(), { prefix: '/queues' })
    },
  })
}
