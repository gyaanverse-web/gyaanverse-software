import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createTenant, getTenantById, updateSettings } from './tenant.service.js'

const createTenantSchema = z.object({
  slug: z.string().min(3).max(63),
  name: z.string().min(2).max(255),
})

export async function tenantRoutes(app: FastifyInstance) {
  app.post('/tenants', async (req, reply) => {
    const body = createTenantSchema.parse(req.body)
    const user = (req as any).user
    const tenant = await createTenant({ ...body, ownerId: user.id })
    return reply.status(201).send(tenant)
  })

  app.get('/tenants/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = await getTenantById(id)
    if (!tenant) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Tenant not found' })
    return tenant
  })

  app.patch('/tenants/settings', async (req, reply) => {
    const tenant = (req as any).tenant
    const body = req.body as Record<string, unknown>
    await updateSettings(tenant.id, body)
    return { success: true }
  })
}
