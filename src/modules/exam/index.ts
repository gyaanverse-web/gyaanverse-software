export {
  createExam, updateExam, submitForReview, transitionExam, archiveExam,
  setExamChapters, linkExamToClass, unlinkExamFromClass, listExamClasses,
  addQuestion, updateQuestion, removeQuestion, reorderQuestions,
  listExamsForTenant, listAvailableExamsForStudent, listPublicExams,
  getExamFull, getExamForStudent, getPublicExamPreview,
  canStudentAccess,
} from './exam.service.js'
export { examRoutes } from './exam.routes.js'
export {
  generateExam, keepDraftQuestion, discardDraftQuestion,
  regenerateDraftQuestion, editDraftQuestion, finalizeGeneration,
} from './exam.generation.service.js'
export type { BucketShortage } from './exam.generation.service.js'
