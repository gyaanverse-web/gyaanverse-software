export async function createOrder(studentId: string, examId: string) {
  throw new Error('Not implemented')
}

export async function confirmPayment(razorpayPaymentId: string, razorpayOrderId: string, signature: string) {
  throw new Error('Not implemented')
}

export async function hasPurchased(studentId: string, examId: string): Promise<boolean> {
  throw new Error('Not implemented')
}
