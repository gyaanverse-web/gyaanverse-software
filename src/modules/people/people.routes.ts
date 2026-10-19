import type { FastifyInstance } from 'fastify'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  getStudentProfile,
  getTeacherProfile,
  listStudents,
} from './people.service.js'

const AUTH = [{ bearerAuth: [] }]

const userIdParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', format: 'uuid' } },
} as const

/**
 * Per-person detail screens for coaching staff.
 *
 * One endpoint per person TYPE, role-branched inside the handler — there is no
 * `/tenant/teacher-view/students/:id` twin. The convention is set by the exam
 * and class modules: a second namespace is a second guard to keep in sync, and
 * the one that drifts is whichever was added last.
 *
 * Nothing here is student-facing. A student's own equivalents already exist and
 * are self-scoped (`/account`, `/student/*`, `GET /reports`), and a student has
 * no business reading a classmate's page at all.
 */
export async function peopleRoutes(app: FastifyInstance) {
  const STAFF = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')]
  const OWNER = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')]

  app.get(
    '/tenant/people/students',
    {
      schema: {
        tags: ['People'],
        summary: 'List students with batch and activity rollups',
        description:
          'The owner sees every student in the coaching. A teacher sees only students approved in a batch they are assigned to. `outstanding` is present for the owner only, and only while the platform fees switch is on — `null` means "not shown", never "owes nothing".',
        security: AUTH,
      },
      preHandler: STAFF,
    },
    async (req, reply) => {
      const students = await listStudents(req.tenant!.id, {
        id: req.user!.id,
        role: req.tenantRole!,
      })
      reply.send({ students })
    },
  )

  app.get(
    '/tenant/people/students/:userId',
    {
      schema: {
        tags: ['People'],
        summary: 'Student detail',
        description:
          'The owner gets batches, every attempt, the fee summary and guardians. An assigned teacher gets a narrower payload — shared batches and their own papers only, with no fee or guardian keys at all — marked by `scope: "teacher"`. A teacher who shares no batch with the student gets 404, not 403, so the response cannot be used to confirm who is enrolled.',
        security: AUTH,
        params: userIdParams,
      },
      preHandler: STAFF,
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const profile = await getStudentProfile(req.tenant!.id, userId, {
        id: req.user!.id,
        role: req.tenantRole!,
      })
      reply.send(profile)
    },
  )

  app.get(
    '/tenant/people/teachers/:userId',
    {
      schema: {
        tags: ['People'],
        summary: 'Teacher detail (owner-only)',
        description:
          'Contact details, assigned batches with student counts, authored papers and workload totals. Draft papers are excluded from both the list and the counts — the owner is not entitled to know an unfinished paper exists. A teacher reading their own id gets 404: `/account` is the self surface.',
        security: AUTH,
        params: userIdParams,
      },
      preHandler: OWNER,
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      reply.send(await getTeacherProfile(req.tenant!.id, userId))
    },
  )
}
