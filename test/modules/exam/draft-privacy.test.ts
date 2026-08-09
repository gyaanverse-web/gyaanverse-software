import { describe, it, expect } from 'vitest'
import {
  listExamsForTenant, getExamStatsForTenant, getExamFull, listExamClasses,
  loadVisibleExam, listMyDrafts, linkExamToClass, addQuestion, submitForReview,
} from '@modules/exam/exam.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass,
  createTestUser, createMembership,
} from '../../helpers/fixtures.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// ── Drafts are the teacher's private workspace ───────────────────────────────
//
// "In the admin panel we should not see the drafts exam created by anyone.
//  Admin has no role in it." — the client, 2026-08-05.
//
// A draft is unfinished thinking. The owner's involvement in a paper begins the
// moment the teacher submits it for review, and not one status earlier. Because
// hiding a row is only half the job, an owner reaching for a draft BY ID gets
// 404, not 403 — a 403 would confirm the paper exists.

const mcq = {
  type: 'mcq_single',
  body: 'Pick the correct option',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

const asOwner = (id: string) => [id, 'coaching_owner'] as const
const asTeacher = (id: string) => [id, 'teacher'] as const

/** A coaching with one draft and one paper already in the review pipeline. */
async function coachingWithDraftAndSubmitted() {
  const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
  const draft = await createTestExam({
    tenantId: tenant.id, createdBy: teacher.id, status: 'draft', title: 'Half-written paper',
  })
  const submitted = await createTestExam({
    tenantId: tenant.id, createdBy: teacher.id, status: 'under_review', title: 'Ready for review',
  })
  return { tenant, owner, teacher, draft, submitted }
}

describe('the owner never sees drafts in a list', () => {
  it('CRITICAL: listExamsForTenant hides every draft from the owner', async () => {
    const { tenant, owner, draft, submitted } = await coachingWithDraftAndSubmitted()

    const seen = await listExamsForTenant(tenant.id, ...asOwner(owner.id))
    const ids = seen.map((e) => e.id)
    expect(ids).toContain(submitted.id)
    expect(ids).not.toContain(draft.id)
  })

  it('CRITICAL: asking for ?status=draft explicitly still returns nothing', async () => {
    const { tenant, owner, draft } = await coachingWithDraftAndSubmitted()

    const seen = await listExamsForTenant(tenant.id, ...asOwner(owner.id), ['draft'] as ExamStatus[])
    expect(seen.map((e) => e.id)).not.toContain(draft.id)
    expect(seen).toHaveLength(0)
  })

  it('the authoring teacher does see their own draft', async () => {
    const { tenant, teacher, draft } = await coachingWithDraftAndSubmitted()

    const seen = await listExamsForTenant(tenant.id, ...asTeacher(teacher.id))
    expect(seen.map((e) => e.id)).toContain(draft.id)
  })

  it('CRITICAL: a teacher does not see a colleague\'s draft either', async () => {
    const { tenant, draft } = await coachingWithDraftAndSubmitted()
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    const seen = await listExamsForTenant(tenant.id, ...asTeacher(colleague.id))
    expect(seen.map((e) => e.id)).not.toContain(draft.id)
  })

  it('a draft becomes visible to the owner the moment it is submitted', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'draft', visibility: 'private',
    })
    await addQuestion(exam.id, tenant.id, ...asTeacher(teacher.id), mcq)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, ...asTeacher(teacher.id), cls.id)

    const before = await listExamsForTenant(tenant.id, ...asOwner(owner.id))
    expect(before.map((e) => e.id)).not.toContain(exam.id)

    await submitForReview(exam.id, tenant.id, ...asTeacher(teacher.id))

    const after = await listExamsForTenant(tenant.id, ...asOwner(owner.id))
    expect(after.map((e) => e.id)).toContain(exam.id)
  })
})

describe('the owner cannot reach a draft by id', () => {
  it('CRITICAL: getExamFull answers 404 (not 403) for the owner on a draft', async () => {
    const { tenant, owner, draft } = await coachingWithDraftAndSubmitted()

    await expect(getExamFull(draft.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('the owner can open a paper that has been submitted', async () => {
    const { tenant, owner, submitted } = await coachingWithDraftAndSubmitted()

    const exam = await getExamFull(submitted.id, tenant.id, ...asOwner(owner.id))
    expect(exam.id).toBe(submitted.id)
    expect(exam.statusHistory).toBeDefined()
  })

  it('CRITICAL: the class assignment of a draft is hidden from the owner too', async () => {
    const { tenant, owner, teacher, draft } = await coachingWithDraftAndSubmitted()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(draft.id, tenant.id, ...asTeacher(teacher.id), cls.id)

    await expect(listExamClasses(draft.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    // …but the author reads it fine.
    const rows = await listExamClasses(draft.id, tenant.id, ...asTeacher(teacher.id))
    expect(rows.map((r) => r.classId)).toEqual([cls.id])
  })

  it('CRITICAL: a teacher gets 404 on a colleague\'s exam in any state', async () => {
    const { tenant, draft, submitted } = await coachingWithDraftAndSubmitted()
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    await expect(loadVisibleExam(draft.id, tenant.id, ...asTeacher(colleague.id)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(loadVisibleExam(submitted.id, tenant.id, ...asTeacher(colleague.id)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the KPI tiles agree with the list', () => {
  it('CRITICAL: the owner\'s draft count is 0 even when drafts exist', async () => {
    const { tenant, owner } = await coachingWithDraftAndSubmitted()

    const stats = await getExamStatsForTenant(tenant.id, ...asOwner(owner.id))
    expect(stats.byStatus.draft).toBe(0)
    expect(stats.byStatus.under_review).toBe(1)
    // The headline total must exclude drafts too, or the tiles contradict the list.
    expect(stats.totalExams).toBe(1)
  })

  it('the teacher\'s own draft count includes it', async () => {
    const { tenant, teacher } = await coachingWithDraftAndSubmitted()

    const stats = await getExamStatsForTenant(tenant.id, ...asTeacher(teacher.id))
    expect(stats.byStatus.draft).toBe(1)
    expect(stats.totalExams).toBe(2)
  })
})

describe('listMyDrafts — the resume list', () => {
  it('returns only the caller\'s own drafts, newest activity first', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    const older = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'draft', title: 'Older',
    })
    const newer = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'draft', title: 'Newer',
    })
    // Not a draft, and not mine — neither belongs in the resume list.
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'live' })
    await createTestExam({ tenantId: tenant.id, createdBy: colleague.id, status: 'draft' })

    const mine = await listMyDrafts(tenant.id, teacher.id)
    expect(mine.map((d) => d.id)).toEqual([newer.id, older.id])
  })

  it('reports the question count so the card can show progress', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const draft = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'draft',
    })
    await addQuestion(draft.id, tenant.id, ...asTeacher(teacher.id), mcq)
    await addQuestion(draft.id, tenant.id, ...asTeacher(teacher.id), mcq)

    const [row] = await listMyDrafts(tenant.id, teacher.id)
    expect(row.questionCount).toBe(2)
  })
})
