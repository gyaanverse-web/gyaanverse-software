import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '@middleware/auth.middleware.js'
import { createOrder, confirmPayment, hasPurchased } from './payment.service.js'

const confirmSchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpaySignature: z.string().min(1),
})

const AUTH = [{ bearerAuth: [] }]

export async function paymentRoutes(app: FastifyInstance) {
  // Create a Razorpay order for a paid exam
  app.post('/exams/:examId/purchase', {
    schema: {
      tags: ['Payments'],
      summary: 'Create a Razorpay order for a paid exam',
      description: 'Returns a Razorpay order ID and amount. Pass these to the Razorpay JS SDK to show the checkout modal.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { examId } = req.params as { examId: string }
    const user = req.user!
    const result = await createOrder(user.id, examId)
    return reply.status(201).send(result)
  })

  // Confirm payment after Razorpay checkout succeeds
  app.post('/exams/:examId/purchase/confirm', {
    schema: {
      tags: ['Payments'],
      summary: 'Confirm a Razorpay payment',
      description: 'Verifies the Razorpay payment signature and records the purchase. Call this after the Razorpay checkout succeeds.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['razorpayPaymentId', 'razorpayOrderId', 'razorpaySignature'],
        properties: {
          razorpayPaymentId: { type: 'string' },
          razorpayOrderId: { type: 'string' },
          razorpaySignature: { type: 'string' },
        },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const user = req.user!
    const body = confirmSchema.parse(req.body)
    const result = await confirmPayment(
      user.id,
      body.razorpayPaymentId,
      body.razorpayOrderId,
      body.razorpaySignature,
    )
    return reply.send(result)
  })

  // Check if the authenticated student has purchased an exam
  app.get('/exams/:examId/purchase/status', {
    schema: {
      tags: ['Payments'],
      summary: 'Check purchase status for an exam',
      description: 'Returns `{ purchased: true/false }` for the authenticated user and exam.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { examId } = req.params as { examId: string }
    const user = req.user!
    const purchased = await hasPurchased(user.id, examId)
    return reply.send({ purchased })
  })
}
