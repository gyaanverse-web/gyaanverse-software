export { questionBankRoutes } from './question-bank.routes.js'
export {
  // Hierarchy
  createSubject, listSubjects, updateSubject, deleteSubject,
  createModule, listModules, updateModule, deleteModule,
  createChapter, listChapters, updateChapter, deleteChapter,
  createSection, listSections, updateSection, deleteSection,
  createConcept, listConcepts, updateConcept, deleteConcept,
  resolveHierarchyPath,
  // Bank questions
  createBankQuestion, listBankQuestions, getBankQuestion, updateBankQuestion,
  verifyBankQuestion, flagBankQuestion, archiveBankQuestion,
  // Generation support
  pickQuestionsForGeneration, incrementUsage, refreshSuccessRates,
} from './question-bank.service.js'
export type { GenerationScope } from './question-bank.service.js'
export type {
  Difficulty, BankStatus, Subject, Module, Chapter, Section, Concept,
  HierarchyPath, HierarchyPathInput, BankQuestion, BankQuestionFilters, QuestionSource,
} from './question-bank.types.js'
