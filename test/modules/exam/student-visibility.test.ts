import { describe, it, expect } from 'vitest'
import {
  canStudentAccess,
  getExamForStudent,
  listAvailableExamsForStudent,
} from '@modules/exam/exam.service.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'
import {
  createTestExam,
  createTestClass,
  createTestQuestion,
  createTestSession,
  enrollStudent,
  linkExamToClass,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// Student visibility across the 11-state lifecycle: scheduled (upcoming,
// metadata only), live (attemptable), and post-live states stay reachable so
// attempted exams can show "results pending" / "result ready". Pre-approval
// states never surface.

async function seedEnrolledStudent() {
  const seeded = await seedTenantWithUsers()
  const cls = await createTestClass({ tenantId: seeded.tenant.id, teacherId: seeded.teacher.id })
  await enrollStudent({ classId: cls.id, studentId: seeded.student.id, status: 'approved' })
  return { ...seeded, cls }
}

async function seedLinkedExam(
  s: Awaited<ReturnType<typeof seedEnrolledStudent>>,
  status: ExamStatus,
) {
  const exam = await createTestExam({
    tenantId: s.tenant.id,
    createdBy: s.teacher.id,
    visibility: 'private',
    status,
  })
  await linkExamToClass(exam.id, s.cls.id)
  return exam
}

describe('listAvailableExamsForStudent — lifecycle visibility', () => {
  it('includes scheduled, live and post-live exams; hides pre-approval states', async () => {
    const s = await seedEnrolledStudent()
    const visible: ExamStatus[] = ['scheduled', 'live', 'under_evaluation', 'ready_to_publish', 'completed']
    const hidden: ExamStatus[] = ['draft', 'under_review', 'changes_requested', 'rejected', 'approved', 'archived']

    const visibleIds = new Set<string>()
    for (const status of visible) visibleIds.add((await seedLinkedExam(s, status)).id)
    const hiddenIds = new Set<string>()
    for (const status of hidden) hiddenIds.add((await seedLinkedExam(s, status)).id)

    const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
    const listedIds = new Set(list.map((e) => e.id))

    for (const id of visibleIds) expect(listedIds.has(id)).toBe(true)
    for (const id of hiddenIds) expect(listedIds.has(id)).toBe(false)
  })

  it("attaches the student's own sessions (and nobody else's)", async () => {
    const s = await seedEnrolledStudent()
    const exam = await seedLinkedExam(s, 'live')
    const mine = await createTestSession({
      examId: exam.id, studentId: s.student.id, tenantId: s.tenant.id, status: 'in_progress',
    })
    // Another student's session on the same exam must not leak.
    const other = await seedTenantWithUsers()
    await createTestSession({
      examId: exam.id, studentId: other.student.id, tenantId: s.tenant.id, status: 'submitted',
    })

    const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
    const row = list.find((e) => e.id === exam.id)
    expect(row).toBeDefined()
    expect(row!.mySessions.map((x) => x.id)).toEqual([mine.id])
    expect(row!.mySessions[0].status).toBe('in_progress')
  })

  // `classIds` is what lets a single batch's screen filter this list without an
  // endpoint of its own, so it has to name every batch of the student's the exam
  // reached — and no others.
  describe('classIds', () => {
    it('names the batch the exam was assigned to', async () => {
      const s = await seedEnrolledStudent()
      const exam = await seedLinkedExam(s, 'live')

      const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
      const row = list.find((e) => e.id === exam.id)
      expect(row!.classIds).toEqual([s.cls.id])
    })

    it("names both batches when the exam reached two of the student's", async () => {
      const s = await seedEnrolledStudent()
      const second = await createTestClass({ tenantId: s.tenant.id, teacherId: s.teacher.id })
      await enrollStudent({ classId: second.id, studentId: s.student.id, status: 'approved' })

      const exam = await seedLinkedExam(s, 'live')
      await linkExamToClass(exam.id, second.id)

      const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
      const row = list.find((e) => e.id === exam.id)
      expect([...row!.classIds].sort()).toEqual([s.cls.id, second.id].sort())
    })

    it('omits a batch the student is not in, even when the same exam was assigned there', async () => {
      const s = await seedEnrolledStudent()
      const notMine = await createTestClass({ tenantId: s.tenant.id, teacherId: s.teacher.id })

      const exam = await seedLinkedExam(s, 'live')
      await linkExamToClass(exam.id, notMine.id)

      const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
      const row = list.find((e) => e.id === exam.id)
      expect(row!.classIds).toEqual([s.cls.id])
    })

    it('omits a batch whose enrollment is still pending', async () => {
      const s = await seedEnrolledStudent()
      const waiting = await createTestClass({ tenantId: s.tenant.id, teacherId: s.teacher.id })
      await enrollStudent({ classId: waiting.id, studentId: s.student.id, status: 'pending' })

      const exam = await seedLinkedExam(s, 'live')
      await linkExamToClass(exam.id, waiting.id)

      const list = await listAvailableExamsForStudent(s.student.id, s.tenant.id)
      const row = list.find((e) => e.id === exam.id)
      expect(row!.classIds).toEqual([s.cls.id])
    })
  })
})

describe('getExamForStudent — lifecycle visibility', () => {
  it('returns a scheduled exam with questions hidden', async () => {
    const s = await seedEnrolledStudent()
    const exam = await seedLinkedExam(s, 'scheduled')
    await createTestQuestion({ examId: exam.id, tenantId: s.tenant.id })

    const result = await getExamForStudent(exam.id, s.student.id)
    expect(result.status).toBe('scheduled')
    expect(result.questions).toEqual([])
  })

  it('returns questions once the exam is live', async () => {
    const s = await seedEnrolledStudent()
    const exam = await seedLinkedExam(s, 'live')
    await createTestQuestion({ examId: exam.id, tenantId: s.tenant.id })

    const result = await getExamForStudent(exam.id, s.student.id)
    expect(result.questions).toHaveLength(1)
  })

  it('still rejects pre-approval exams', async () => {
    const s = await seedEnrolledStudent()
    const exam = await seedLinkedExam(s, 'under_review')

    await expect(getExamForStudent(exam.id, s.student.id)).rejects.toThrow('not available')
  })
})

describe('canStudentAccess — widened lifecycle statuses', () => {
  it('allows scheduled and completed private exams for an enrolled student', async () => {
    const s = await seedEnrolledStudent()
    const scheduled = await seedLinkedExam(s, 'scheduled')
    const completed = await seedLinkedExam(s, 'completed')

    expect(await canStudentAccess(s.student.id, scheduled.id)).toBe(true)
    expect(await canStudentAccess(s.student.id, completed.id)).toBe(true)
  })

  it('still rejects draft/under_review exams', async () => {
    const s = await seedEnrolledStudent()
    const draft = await seedLinkedExam(s, 'draft')
    const underReview = await seedLinkedExam(s, 'under_review')

    expect(await canStudentAccess(s.student.id, draft.id)).toBe(false)
    expect(await canStudentAccess(s.student.id, underReview.id)).toBe(false)
  })
})
