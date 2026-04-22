export async function createExam(data: any) {
  throw new Error('Not implemented')
}

export async function getExam(id: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function listPublicExams() {
  throw new Error('Not implemented')
}

export async function listExamsForClass(classId: string, tenantId: string) {
  throw new Error('Not implemented')
}

export async function canStudentAccess(studentId: string, examId: string, tenantId: string): Promise<boolean> {
  throw new Error('Not implemented')
}
