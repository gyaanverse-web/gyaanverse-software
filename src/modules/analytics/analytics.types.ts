export interface StudentStats {
  studentId: string
  totalExams: number
  avgScore: number
  scoreHistory: Array<{ examId: string; score: number; date: Date }>
}

export interface ClassStats {
  classId: string
  totalStudents: number
  avgScore: number
  topStudents: Array<{ studentId: string; score: number }>
}

export interface ExamStats {
  examId: string
  totalAttempts: number
  avgScore: number
  completionRate: number
}
