import type { FastifyInstance } from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { swaggerConfig } from './swagger.js'
import { mountOpsSurface } from './ops-surface.js'
import { env } from './env.js'

// ─────────────────────────────────────────────────────────────────────────────
// `/docs` and `/openapi.json` — the API reference.
//
// This used to be served unconditionally, which meant a production deploy
// published a complete, machine-readable map of every route, its parameters, its
// role requirements and its error shapes to anyone who asked. `/internal/*` was
// never in it (`hide: true` on each route) and neither was `/queues`, so nothing
// secret leaked — but everything else did, and none of it was addressed to the
// public. Coachings integrate with Gyanverse through the frontend, not through
// this document; the people who need it are us.
//
// So the reader goes through the same gate as the queue dashboard — see
// config/ops-surface.ts for the rule and why it fails closed. In practice:
//
//   local / staging   open at /docs, which is what you want while building
//   production        set API_DOCS_PASSWORD to enable it, or leave it unset and
//                     neither route exists
//
// ── Why the plugin and the reader are registered separately ────────────────
//
// `@fastify/swagger` itself serves nothing. It collects routes through an
// `onRoute` hook and decorates the instance with `app.swagger()`. That hook only
// ever sees routes registered on the same encapsulated scope or below it — so
// registering it *inside* the guarded scope would produce a document containing
// nothing but the guarded scope's own routes. It is registered on the root
// instance, always, before any route file.
//
// Only the two things that actually respond to a request — the Swagger UI and
// `/openapi.json` — live inside the guard. `/openapi.json` is in there
// deliberately rather than left outside: it is the same content as the UI minus
// the HTML, so exempting it would re-open the whole exposure with an extra step.
//
// Nothing else depends on any of this. Route `schema` blocks stay in place
// either way; Fastify uses `body` / `querystring` / `params` / `response` for
// validation and serialisation regardless, and ignores the documentation keys
// (`tags`, `summary`, `security`) when nothing is collecting them.
// ─────────────────────────────────────────────────────────────────────────────

export async function registerApiDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, swaggerConfig())

  await mountOpsSurface(app, {
    name: 'API docs (/docs)',
    passwordVar: 'API_DOCS_PASSWORD',
    user: env.API_DOCS_USER,
    password: env.API_DOCS_PASSWORD,
    ips: env.API_DOCS_IPS,
    register: async (scope) => {
      await scope.register(swaggerUi, {
        routePrefix: '/docs',
        uiConfig: {
          docExpansion: 'list',
          deepLinking: true,
          persistAuthorization: true,
        },
      })

      scope.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
        reply.send(app.swagger())
      })
    },
  })
}
