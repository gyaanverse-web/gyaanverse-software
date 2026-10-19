export {
  assertTenantMember,
  sharesBatchWith,
  getStudentBatches,
  getStudentExamActivity,
  getStudentProfile,
  listStudents,
  getTeacherProfile,
} from './people.service.js'
export type { Viewer } from './people.service.js'
export { peopleRoutes } from './people.routes.js'
export type {
  GuardianRef,
  PersonIdentity,
  StudentActivitySummary,
  StudentBatchRef,
  StudentExamAttempt,
  StudentFeeBlock,
  StudentListRow,
  StudentProfile,
  StudentProfileForTeacher,
  StudentProfileResponse,
  TeacherBatchRef,
  TeacherPaperRef,
  TeacherProfile,
} from './people.types.js'
