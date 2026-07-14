import type { FastifyInstance } from 'fastify'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import { getUsageSummary, getInvoices, handleSubscriptionWebhook } from './billing.service.js'

const AUTH = [{ bearerAuth: [] }]

export async function billingRoutes(app: FastifyInstance) {
  // ── Tenant-scoped ─────────────────────────────────────────────────────────

  // Returns current plan, live usage vs limits, and subscription metadata
  app.get(
    '/tenant/billing/summary',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Get plan, usage, and subscription summary',
        description: 'Returns the current plan name, live usage counters vs plan limits, and subscription metadata for the resolved tenant. Requires `coaching_owner` role.',
        security: AUTH,
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const summary = await getUsageSummary(tenant.id)
      reply.send(summary)
    },
  )

  // Returns invoice history for the tenant
  app.get(
    '/tenant/billing/invoices',
    {
      schema: {
        tags: ['Billing'],
        summary: 'List invoice history',
        description: 'Returns all invoices recorded for the resolved tenant. Requires `coaching_owner` role.',
        security: AUTH,
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const list = await getInvoices(tenant.id)
      reply.send({ invoices: list })
    },
  )

  // ── Global — Razorpay webhook ─────────────────────────────────────────────

  // Razorpay calls this on subscription.activated, subscription.charged,
  // subscription.cancelled, subscription.halted, payment.failed
  app.post(
    '/billing/webhook',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Razorpay subscription webhook',
        description: 'Receives Razorpay events (`subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`, `payment.failed`). Verifies the `x-razorpay-signature` header before processing. **Called by Razorpay — not for direct use.**',
      },
      config: { rawBody: true },
    },
    async (req, reply) => {
      const signature = (req.headers['x-razorpay-signature'] as string) ?? ''
      const rawBody = (req as any).rawBody as string ?? JSON.stringify(req.body)
      await handleSubscriptionWebhook(rawBody, signature)
      reply.send({ received: true })
    },
  )
}
