export async function startSession(studentId: string, examId: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function saveAnswer(sessionId: string, questionId: string, imageUrl: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function submitSession(sessionId: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function getSession(sessionId: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function hasAttempted(studentId: string, examId: string, tenantId: string): Promise<boolean> {
  throw new Error('Not implemented')
}
