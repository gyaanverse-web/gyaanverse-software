import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { internalAuth, logInternalAction } from '../../middleware/internal.js'
import { getPlatformSettings, setPlatformSetting, PLATFORM_KEYS, type PlatformKey } from './platform.service.js'

const AUTH = [{ bearerAuth: [] }]

const updateSchema = z.object({
  key: z.enum(PLATFORM_KEYS),
  value: z.boolean(),
})

export async function platformRoutes(app: FastifyInstance) {
  app.get(
    '/internal/platform/settings',
    {
      schema: {
        tags: ['Internal'],
        summary: 'Read platform switches',
        description: 'Returns every platform-wide switch and its current value. `super_admin` only.',
        security: AUTH,
      },
      preHandler: internalAuth,
    },
    async (_req, reply) => {
      reply.send({ settings: await getPlatformSettings() })
    },
  )

  app.post(
    '/internal/platform/settings',
    {
      schema: {
        tags: ['Internal'],
        summary: 'Flip a platform switch',
        description:
          'Sets one platform-wide switch. `super_admin` only, and audited.\n\n' +
          '`billing_enabled: false` (the MVP posture) suspends every plan limit and ' +
          'feature gate, answers 404 on all billing routes, and hides plan/billing UI ' +
          'in the app. It does **not** alter any coaching\'s `plan` value, so switching ' +
          'it back on restores the plan each tenant was already on.\n\n' +
          'Readers cache for 15s, so a flip reaches the worker and other API instances ' +
          'within that window rather than instantly.',
        security: AUTH,
      },
      preHandler: internalAuth,
    },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { key, value } = parsed.data
      const before = await getPlatformSettings()
      const settings = await setPlatformSetting(key as PlatformKey, value, req.user!.id)

      // Audited with its previous value. A platform switch is the widest-blast-
      // radius action in the panel — one click changes what every coaching on
      // the platform may do — and "who turned billing on, and when" is the first
      // question anyone will ask when a coaching reports being capped.
      await logInternalAction({
        actorId: req.user!.id,
        action: `platform.${key}`,
        metadata: { from: before[key], to: value },
      })

      reply.send({ settings })
    },
  )
}
