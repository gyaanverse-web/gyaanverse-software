import { pgTable, uuid, varchar, numeric, timestamp, index } from 'drizzle-orm/pg-core'
import { users } from '../auth/auth.schema.js'
import { exams } from '../exam/exam.schema.js'

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  razorpayOrderId: varchar('razorpay_order_id', { length: 255 }).notNull().unique(),
  razorpayPaymentId: varchar('razorpay_payment_id', { length: 255 }).unique(),
  studentId: uuid('student_id').notNull().references(() => users.id),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('payments_student_id_idx').on(t.studentId)])

export const examPurchases = pgTable('exam_purchases', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => users.id),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
})
