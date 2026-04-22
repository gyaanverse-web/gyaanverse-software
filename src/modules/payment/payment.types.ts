export interface Payment {
  id: string
  razorpayOrderId: string
  razorpayPaymentId: string | null
  studentId: string
  amount: string
  status: 'pending' | 'completed' | 'failed'
  createdAt: Date
}

export interface ExamPurchase {
  id: string
  studentId: string
  examId: string
  paymentId: string
  purchasedAt: Date
}
