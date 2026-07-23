import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { payments, examPurchases } from '@modules/payment/payment.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import { env } from '@config/env.js'
import {
  seedTenantWithUsers,
  createTestExam,
  createTestUser,
} from '../../helpers/fixtures.js'

// Mock the entire Razorpay module — the SDK constructor returns an object
// with `.orders.create()` and `.orders.fetch()`. Tests control both responses.
const mockOrdersCreate = vi.fn()
const mockOrdersFetch = vi.fn()
vi.mock('razorpay', () => ({
  default: vi.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate, fetch: mockOrdersFetch },
  })),
}))

// Compute the same HMAC that Razorpay sends back after a successful checkout.
function signCheckout(orderId: string, paymentId: string): string {
  return createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
}

// Re-import the service AFTER vi.mock has been hoisted so it picks up the mock.
async function svc() {
  return await import('@modules/payment/payment.service.js')
}

beforeEach(() => {
  mockOrdersCreate.mockReset()
  mockOrdersFetch.mockReset()
})

describe('createOrder', () => {
  it('creates a Razorpay order and persists a pending payment row', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })
    mockOrdersCreate.mockResolvedValue({ id: 'order_test123' })

    const { createOrder } = await svc()
    const result = await createOrder(student.id, exam.id)

    expect(result.orderId).toBe('order_test123')
    expect(result.amount).toBe(9900) // ₹99 in paise
    expect(result.currency).toBe('INR')

    const [p] = await db.select().from(payments).where(eq(payments.razorpayOrderId, 'order_test123'))
    expect(p.studentId).toBe(student.id)
    expect(p.status).toBe('pending')
    expect(p.amount).toBe('99.00')
  })

  it('rejects free exams', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', price: null,
    })
    const student = await createTestUser({ role: 'student' })

    const { createOrder } = await svc()
    await expect(createOrder(student.id, exam.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  // ── Visibility guard (audit finding #2) ────────────────────────────────
  // A teacher who mistakenly sets `price` on a `private` exam must NOT
  // expose it to be purchased by anyone outside the linked classes.

  it('CRITICAL: rejects a private exam even when price is set', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id,
      visibility: 'private',
      price: '199.00',  // teacher misconfigured this
    })
    const student = await createTestUser({ role: 'student' })

    const { createOrder } = await svc()
    await expect(createOrder(student.id, exam.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })

    // Razorpay was NOT called — the bug would have created an order
    expect(mockOrdersCreate).not.toHaveBeenCalled()
  })

  it('CRITICAL: rejects a public_free exam even when price is set', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id,
      visibility: 'public_free',
      price: '99.00',  // misconfigured: public_free shouldn't have a price
    })
    const student = await createTestUser({ role: 'student' })

    const { createOrder } = await svc()
    await expect(createOrder(student.id, exam.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('rejects re-purchase by the same student', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })

    // Pre-create a successful purchase
    const [p] = await db.insert(payments).values({
      razorpayOrderId: 'order_already',
      studentId: student.id,
      amount: '99.00',
      status: 'completed',
    }).returning()
    await db.insert(examPurchases).values({
      studentId: student.id, examId: exam.id, paymentId: p.id,
    })

    const { createOrder } = await svc()
    await expect(createOrder(student.id, exam.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})

describe('confirmPayment', () => {
  async function setupOrder(opts: { studentId: string; examId: string; orderId: string }) {
    await db.insert(payments).values({
      razorpayOrderId: opts.orderId,
      studentId: opts.studentId,
      amount: '99.00',
      status: 'pending',
    })
    mockOrdersFetch.mockResolvedValue({
      id: opts.orderId,
      notes: { examId: opts.examId, studentId: opts.studentId },
    })
  }

  it('happy path: valid signature → marks payment completed + creates exam_purchases row', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: student.id, examId: exam.id, orderId: 'order_x' })

    const sig = signCheckout('order_x', 'pay_x')
    const { confirmPayment, hasPurchased } = await svc()
    const result = await confirmPayment(student.id, 'pay_x', 'order_x', sig)
    expect(result.success).toBe(true)

    const [p] = await db.select().from(payments).where(eq(payments.razorpayOrderId, 'order_x'))
    expect(p.status).toBe('completed')
    expect(p.razorpayPaymentId).toBe('pay_x')

    expect(await hasPurchased(student.id, exam.id)).toBe(true)
  })

  // ── Race-window guard: visibility flipped between order + confirm ──────
  // Window between Razorpay checkout open and confirm is 1-5 minutes. A
  // teacher could change visibility=public_paid → private mid-checkout.
  // We must not honor the purchase against the now-restricted exam.

  it('CRITICAL: rejects confirm if exam visibility flipped to private mid-checkout', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '199.00',
    })
    const student = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: student.id, examId: exam.id, orderId: 'order_race' })

    // Simulate the race: between createOrder and confirmPayment, the teacher
    // flips this exam to private.
    await db.update(exams)
      .set({ visibility: 'private', price: null })
      .where(eq(exams.id, exam.id))

    const sig = signCheckout('order_race', 'pay_race')
    const { confirmPayment, hasPurchased } = await svc()

    await expect(
      confirmPayment(student.id, 'pay_race', 'order_race', sig),
    ).rejects.toMatchObject({ code: 'VALIDATION' })

    // Payment must NOT have been marked complete; no exam_purchases row.
    const [p] = await db.select().from(payments).where(eq(payments.razorpayOrderId, 'order_race'))
    expect(p.status).toBe('pending')
    expect(await hasPurchased(student.id, exam.id)).toBe(false)
  })

  it('CRITICAL: rejects tampered signatures (any character flip)', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: student.id, examId: exam.id, orderId: 'order_tampered' })

    const real = signCheckout('order_tampered', 'pay_tampered')
    // Flip one hex digit — same length, wrong value
    const tampered = (real[0] === 'a' ? 'b' : 'a') + real.slice(1)

    const { confirmPayment } = await svc()
    await expect(
      confirmPayment(student.id, 'pay_tampered', 'order_tampered', tampered),
    ).rejects.toMatchObject({ code: 'VALIDATION' })

    // Payment must NOT have been completed
    const [p] = await db.select().from(payments).where(eq(payments.razorpayOrderId, 'order_tampered'))
    expect(p.status).toBe('pending')
    const purchases = await db
      .select()
      .from(examPurchases)
      .where(eq(examPurchases.examId, exam.id))
    expect(purchases).toHaveLength(0)
  })

  it('CRITICAL: rejects signatures of different length (no timing leak)', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: student.id, examId: exam.id, orderId: 'order_short' })

    const { confirmPayment } = await svc()
    await expect(
      confirmPayment(student.id, 'pay_short', 'order_short', 'tooshort'),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('CRITICAL: rejects when a different student tries to confirm', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const buyer = await createTestUser({ role: 'student' })
    const attacker = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: buyer.id, examId: exam.id, orderId: 'order_steal' })

    const sig = signCheckout('order_steal', 'pay_steal')
    const { confirmPayment } = await svc()
    await expect(
      confirmPayment(attacker.id, 'pay_steal', 'order_steal', sig),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects double-confirmation', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_paid', price: '99.00',
    })
    const student = await createTestUser({ role: 'student' })
    await setupOrder({ studentId: student.id, examId: exam.id, orderId: 'order_dup' })

    const sig = signCheckout('order_dup', 'pay_dup')
    const { confirmPayment } = await svc()
    await confirmPayment(student.id, 'pay_dup', 'order_dup', sig)

    await expect(
      confirmPayment(student.id, 'pay_dup', 'order_dup', sig),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects unknown orderId', async () => {
    const student = await createTestUser({ role: 'student' })
    const sig = signCheckout('order_nope', 'pay_nope')

    const { confirmPayment } = await svc()
    await expect(
      confirmPayment(student.id, 'pay_nope', 'order_nope', sig),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
