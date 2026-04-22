export interface Exam {
  id: string
  tenantId: string
  teacherId: string
  title: string
  durationMins: number
  visibility: 'public' | 'private'
  isPaid: boolean
  price: string | null
  status: 'draft' | 'published' | 'archived'
  createdAt: Date
}

export interface Question {
  id: string
  examId: string
  tenantId: string
  body: string
  marks: number
  order: number
}
