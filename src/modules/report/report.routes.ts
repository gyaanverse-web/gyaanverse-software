import type { FastifyInstance } from 'fastify'
import { authenticate, requireTenantRole } from '@middleware/auth.middleware.js'
import { tenantMiddleware } from '@middleware/tenant.middleware.js'
import {
  getReportForStudent,
  getReportForTenant,
  listReportsForExam,
  listReportsForStudent,
} from './report.service.js'

const AUTH = [{ bearerAuth: [] }]

export async function reportRoutes(app: FastifyInstance) {
  // ── Student: own report by session ──────────────────────────────────────
  // Returns null while the AI pipeline is still running (no row exists yet),
  // so the client can show a "your report is being generated" state.

  app.get('/reports/:sessionId', {
    schema: {
      tags: ['Reports'],
      summary: 'Get my report for a session',
      description: 'Returns the performance report for the authenticated student\'s session. Returns `null` while the AI pipeline is still running — poll until it resolves.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }
    const user = req.user!
    return getReportForStudent(sessionId, user.id)
  })

  // ── Student: history of own reports ─────────────────────────────────────

  app.get('/reports', {
    schema: {
      tags: ['Reports'],
      summary: 'List my reports',
      description: 'Returns all performance reports for the authenticated student.',
      security: AUTH,
    },
    preHandler: [authenticate],
  }, async (req) => {
    const user = req.user!
    return { reports: await listReportsForStudent(user.id) }
  })

  // ── Teacher / owner: inspect a specific report ──────────────────────────

  const tenantAuth = [
    authenticate,
    tenantMiddleware,
    requireTenantRole('coaching_owner', 'teacher'),
  ]

  app.get('/tenant/reports/:reportId', {
    schema: {
      tags: ['Reports'],
      summary: 'Get a student report (teacher view)',
      description: 'Returns the full performance report — student identity, totals and per-question items — for any student in the resolved tenant. An item with non-null `feedback` was graded by the AI.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['reportId'],
        properties: { reportId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const { reportId } = req.params as { reportId: string }
    const tenant = req.tenant!
    return getReportForTenant(reportId, tenant.id)
  })

  // ── Teacher / owner: list reports for an exam ───────────────────────────
  // Teachers see only reports for exams they created; owners see all.

  app.get('/tenant/exams/:examId/reports', {
    schema: {
      tags: ['Reports'],
      summary: 'List reports for an exam',
      description: 'Returns all student reports for the given exam, each with the student\'s name and email, ordered by student name. Teachers only see reports for exams they created; owners see all.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const { examId } = req.params as { examId: string }
    const tenant = req.tenant!
    const user = req.user!
    return { reports: await listReportsForExam(examId, tenant.id, user.id, user.role) }
  })
}
