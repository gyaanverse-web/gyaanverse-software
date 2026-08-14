import { createHmac, timingSafeEqual } from 'crypto'
import Razorpay from 'razorpay'
import { eq, and } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { Errors, AppError } from '@shared/errors.js'
import { env } from '@config/env.js'
import { payments, examPurchases } from './payment.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import { dispatch } from '@modules/notification/index.js'

function getRazorpay() {
  return new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  })
}

export async function createOrder(studentId: string, examId: string) {
  const [exam] = await db.select({ price: exams.price, title: exams.title, visibility: exams.visibility })
    .from(exams)
    .where(eq(exams.id, examId))
    .limit(1)

  if (!exam) throw Errors.NOT_FOUND('Exam')
  // Visibility guard: only public_paid exams are purchasable. A `private` exam
  // with a stray `price` set by mistake must NOT be exposed for purchase —
  // students outside the linked classes would pay and still be denied access.
  if (exam.visibility !== 'public_paid')
    throw new AppError('VALIDATION', 'This exam is not available for purchase', 422)
  if (!exam.price || parseFloat(exam.price) === 0)
    throw new AppError('VALIDATION', 'This exam is free and does not require purchase', 422)

  const alreadyBought = await hasPurchased(studentId, examId)
  if (alreadyBought)
    throw new AppError('CONFLICT', 'You have already purchased this exam', 409)

  const amountPaise = Math.round(parseFloat(exam.price) * 100)

  const razorpay = getRazorpay()
  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    notes: { examId, studentId },
  })

  await db.insert(payments).values({
    razorpayOrderId: order.id,
    studentId,
    amount: exam.price,
    status: 'pending',
  })

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
  }
}

export async function confirmPayment(
  studentId: string,
  razorpayPaymentId: string,
  razorpayOrderId: string,
  razorpaySignature: string,
) {
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')

  const sigBuf = Buffer.from(razorpaySignature)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf))
    throw new AppError('VALIDATION', 'Invalid payment signature', 400)

  const [payment] = await db.select()
    .from(payments)
    .where(eq(payments.razorpayOrderId, razorpayOrderId))
    .limit(1)

  if (!payment) throw Errors.NOT_FOUND('Payment order')
  if (payment.studentId !== studentId) throw Errors.FORBIDDEN()
  if (payment.status === 'completed')
    throw new AppError('CONFLICT', 'Payment already confirmed', 409)

  const razorpay = getRazorpay()
  const order = await razorpay.orders.fetch(razorpayOrderId)
  const orderExamId = (order.notes as Record<string, string>)['examId']
  if (!orderExamId) throw new AppError('VALIDATION', 'Order missing exam reference', 400)

  // Re-verify visibility at confirm time. The Razorpay checkout window is
  // 1-5 minutes — long enough for a teacher to flip the exam from
  // public_paid → private. If we don't re-check, the student pays but
  // canStudentAccess will still deny them. Refuse the confirm instead.
  const [examNow] = await db
    .select({ visibility: exams.visibility })
    .from(exams)
    .where(eq(exams.id, orderExamId))
    .limit(1)
  if (!examNow || examNow.visibility !== 'public_paid')
    throw new AppError('VALIDATION', 'This exam is no longer available for purchase', 422)

  await db.transaction(async (tx) => {
    await tx.update(payments)
      .set({ razorpayPaymentId, status: 'completed' })
      .where(eq(payments.razorpayOrderId, razorpayOrderId))

    await tx.insert(examPurchases).values({
      studentId,
      examId: orderExamId,
      paymentId: payment.id,
    })
  })

  void dispatch({
    type: 'payment_confirmed',
    recipients: { userIds: [studentId] },
    tenantId: null,
    data: {
      title: 'Payment confirmed',
      body: `Your payment of ₹${payment.amount} was successful.`,
      link: `/student/exams/${orderExamId}/intro`,
    },
  })

  return { success: true }
}

export async function hasPurchased(studentId: string, examId: string): Promise<boolean> {
  const [row] = await db.select({ id: examPurchases.id })
    .from(examPurchases)
    .where(and(eq(examPurchases.studentId, studentId), eq(examPurchases.examId, examId)))
    .limit(1)
  return !!row
}
