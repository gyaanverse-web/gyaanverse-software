import { describe, it, expect } from 'vitest'
import { eq, asc } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams, questions, examClasses } from '@modules/exam/exam.schema.js'
import {
  startWizardDraft, saveWizardState, listMyDrafts, discardDraft, getExamFull,
  addQuestion, submitForReview, UNTITLED_DRAFT_TITLE,
} from '@modules/exam/exam.service.js'
import { generateIntoDraft } from '@modules/exam/exam.generation.service.js'
import { createSubject, createBankQuestion, verifyBankQuestion } from '@modules/question-bank/index.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass,
  createTestUser, createMembership,
} from '../../helpers/fixtures.js'
import type { WizardState } from '@modules/exam/exam.types.js'

// ── The resumable authoring wizard ───────────────────────────────────────────
//
// "Whenever a teacher clicks generate exam, it will create a draft. If he closes
//  and comes back tomorrow, he can see his draft." — the client, 2026-08-05.
//
// The draft row therefore exists from the FIRST CLICK, not from the first
// generated question, and every step writes its form state back to it. These
// tests cover: the draft exists immediately, state survives a round trip,
// stepping backwards and regenerating behaves, and the draft is private and
// free (no plan quota) until it is submitted.

const asTeacher = (id: string) => [id, 'teacher'] as const

const mcq = {
  type: 'mcq_single',
  body: 'Manually written question',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

let optionSeq = 0

async function seedBank(tenantId: string, ownerId: string, subjectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = `w${optionSeq++}`
    const b = `w${optionSeq++}`
    const q = await createBankQuestion({
      tenantId, createdBy: ownerId, hierarchy: { subjectId },
      type: 'mcq_single', difficulty: 'easy', body: `Bank question ${i}`,
      payload: { options: [{ id: a, text: 'A' }, { id: b, text: 'B' }] },
      answerKey: { optionId: a },
      defaultMarks: 4, defaultNegativeMarks: 1,
    })
    await verifyBankQuestion(q.id, tenantId, ownerId)
  }
}

async function seedWizardTenant(bankSize = 10) {
  const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
  const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
  await seedBank(tenant.id, owner.id, subject.id, bankSize)
  return { tenant, owner, teacher, subjectId: subject.id }
}

const easyMcq = (total: number) => ({
  totalQuestions: total,
  typeDistribution: { mcq_single: total },
  difficultyDistribution: { easy: total },
})

describe('startWizardDraft', () => {
  it('creates a draft the instant the teacher opens the generator', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')

    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    expect(draft.status).toBe('draft')
    expect(draft.createdBy).toBe(teacher.id)
    expect(draft.title).toBe(UNTITLED_DRAFT_TITLE)
    expect(draft.wizardStep).toBe(1)
    expect(draft.wizardState).toEqual({})
  })

  it('does not consume the monthly mock quota', async () => {
    // Free plan allows 3 mocks/month. Opening drafts must stay free, or a
    // teacher who changes their mind twice is locked out for the month.
    const { tenant, teacher } = await seedTenantWithUsers('free')

    for (let i = 0; i < 10; i++) {
      const d = await startWizardDraft({
        tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      })
      expect(d.status).toBe('draft')
    }

    const mine = await listMyDrafts(tenant.id, teacher.id)
    expect(mine).toHaveLength(10)
  })
})

describe('saveWizardState — close the tab, come back tomorrow', () => {
  it('round-trips the step and the form state', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant(0)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    const state: WizardState = {
      classIds: [cls.id],
      subjectId,
      scopeType: 'multi',
      chapterIds: [],
      typeCounts: { mcq_single: 15, numerical: 5 },
      difficultyPct: { easy: 30, medium: 50, hard: 20 },
      verifiedOnly: true,
    }
    await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
      step: 3, state, title: 'Kinematics Weekly Test',
    })

    // "Coming back tomorrow" is just re-reading the exam.
    const resumed = await getExamFull(draft.id, tenant.id, ...asTeacher(teacher.id))
    expect(resumed.wizardStep).toBe(3)
    expect(resumed.wizardState).toEqual(state)
    expect(resumed.title).toBe('Kinematics Weekly Test')
  })

  it('replaces the stored state rather than merging it', async () => {
    // Deselecting every chapter has to persist as "no chapters" — a merge would
    // silently resurrect yesterday's selection.
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
      step: 2, state: { chapterIds: ['a', 'b'].map(() => crypto.randomUUID()), scopeType: 'multi' },
    })
    const cleared = await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
      step: 2, state: { chapterIds: [], scopeType: 'full-subject' },
    })

    expect(cleared.wizardState).toEqual({ chapterIds: [], scopeType: 'full-subject' })
  })

  it('walks forwards and backwards through the steps', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    for (const step of [1, 2, 3, 4, 3, 2]) {
      const saved = await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
        step, state: { scopeType: 'multi' },
      })
      expect(saved.wizardStep).toBe(step)
    }
  })

  it('rejects a step outside the wizard', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    await expect(
      saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), { step: 9, state: {} }),
    ).rejects.toThrow(/step must be an integer between 1 and 4/)
  })

  it('CRITICAL: another teacher cannot autosave over my draft', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    await expect(
      saveWizardState(draft.id, tenant.id, ...asTeacher(colleague.id), { step: 2, state: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('generateIntoDraft — filling the draft the wizard opened', () => {
  it('fills the existing draft instead of creating a second exam', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'My paper',
    })

    const result = await generateIntoDraft({
      examId: draft.id,
      tenantId: tenant.id,
      requesterId: teacher.id,
      requesterRole: 'teacher',
      classIds: [cls.id],
      params: { subjectId, ...easyMcq(3) },
    })

    expect(result.exam.id).toBe(draft.id)          // same row, not a new one
    expect(result.exam.title).toBe('My paper')     // the wizard's title survives
    expect(result.questions).toHaveLength(3)
    expect(result.exam.totalMarks).toBe(12)

    // Exactly one exam exists for this teacher.
    const all = await db.select().from(exams).where(eq(exams.createdBy, teacher.id))
    expect(all).toHaveLength(1)
  })

  it('regenerating replaces the previous picks (the Back button)', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    const first = await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id,
      requesterRole: 'teacher', params: { subjectId, ...easyMcq(3) },
    })
    expect(first.questions).toHaveLength(3)

    // Step back to Distribution, ask for a bigger paper, regenerate.
    const second = await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id,
      requesterRole: 'teacher', params: { subjectId, ...easyMcq(5) },
    })

    expect(second.questions).toHaveLength(5)       // not 8 — the old run is gone
    expect(second.exam.totalMarks).toBe(20)
    const oldIds = first.questions.map((q) => q.id)
    expect(second.questions.some((q) => oldIds.includes(q.id))).toBe(false)
  })

  it('CRITICAL: regenerating keeps hand-written questions and renumbers cleanly', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })
    await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id,
      requesterRole: 'teacher', params: { subjectId, ...easyMcq(3) },
    })

    // The teacher writes one of their own on the review step…
    const manual = await addQuestion(draft.id, tenant.id, ...asTeacher(teacher.id), mcq)

    // …then goes back and regenerates. Their own work must not be thrown away.
    const after = await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id,
      requesterRole: 'teacher', params: { subjectId, ...easyMcq(2) },
    })

    const ids = after.questions.map((q) => q.id)
    expect(ids).toContain(manual.id)
    expect(after.questions).toHaveLength(3)        // 2 generated + 1 manual

    // Orders are contiguous, with the manual question last.
    const rows = await db.select().from(questions)
      .where(eq(questions.examId, draft.id)).orderBy(asc(questions.order))
    expect(rows.map((r) => r.order)).toEqual([1, 2, 3])
    expect(rows[2].id).toBe(manual.id)
    expect(after.exam.totalMarks).toBe(12)         // 2×4 generated + 4 manual
  })

  it('replaces the class assignment on a re-run', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const classA = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const classB = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })

    await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id, requesterRole: 'teacher',
      classIds: [classA.id], params: { subjectId, ...easyMcq(2) },
    })
    await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id, requesterRole: 'teacher',
      classIds: [classB.id], params: { subjectId, ...easyMcq(2) },
    })

    const links = await db.select().from(examClasses).where(eq(examClasses.examId, draft.id))
    expect(links.map((l) => l.classId)).toEqual([classB.id])
  })

  it('refuses to generate into a paper that has left draft', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'under_review',
    })

    await expect(generateIntoDraft({
      examId: exam.id, tenantId: tenant.id, requesterId: teacher.id,
      requesterRole: 'teacher', params: { subjectId, ...easyMcq(2) },
    })).rejects.toThrow(/can only be generated into a draft/)
  })
})

describe('discardDraft', () => {
  it('deletes an abandoned draft and its questions', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })
    await addQuestion(draft.id, tenant.id, ...asTeacher(teacher.id), mcq)

    await discardDraft(draft.id, tenant.id, ...asTeacher(teacher.id))

    const rows = await db.select().from(exams).where(eq(exams.id, draft.id))
    expect(rows).toHaveLength(0)
    const qs = await db.select().from(questions).where(eq(questions.examId, draft.id))
    expect(qs).toHaveLength(0)
  })

  it('CRITICAL: refuses to delete a paper that has entered the pipeline', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'live',
    })

    await expect(discardDraft(exam.id, tenant.id, ...asTeacher(teacher.id)))
      .rejects.toThrow(/Only a draft can be discarded/)
  })
})

describe('the full wizard journey', () => {
  it('start → save steps → generate → submit, resuming in the middle', async () => {
    const { tenant, teacher, subjectId } = await seedWizardTenant()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    // Day 1: the teacher gets as far as the distribution step and closes the tab.
    const draft = await startWizardDraft({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
    })
    await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
      step: 1, state: { classIds: [cls.id], subjectId }, title: 'Unit Test 4',
    })
    await saveWizardState(draft.id, tenant.id, ...asTeacher(teacher.id), {
      step: 3,
      state: {
        classIds: [cls.id], subjectId, scopeType: 'full-subject',
        typeCounts: { mcq_single: 4 }, difficultyPct: { easy: 100 },
      },
    })

    // Day 2: the draft is waiting on the resume list, at the step they left.
    const [resumed] = await listMyDrafts(tenant.id, teacher.id)
    expect(resumed.id).toBe(draft.id)
    expect(resumed.wizardStep).toBe(3)
    expect(resumed.title).toBe('Unit Test 4')

    // They finish: generate, then submit for review.
    const generated = await generateIntoDraft({
      examId: draft.id, tenantId: tenant.id, requesterId: teacher.id, requesterRole: 'teacher',
      classIds: [cls.id], params: { subjectId, ...easyMcq(4) },
    })
    expect(generated.questions).toHaveLength(4)

    // The class came along with the generate call, so submission's
    // "assign at least one class" gate is already satisfied.
    const submitted = await submitForReview(draft.id, tenant.id, ...asTeacher(teacher.id))
    expect(submitted.status).toBe('under_review')

    // …and it is no longer on the resume list.
    expect(await listMyDrafts(tenant.id, teacher.id)).toHaveLength(0)
  })
})
