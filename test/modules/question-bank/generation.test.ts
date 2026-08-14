import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { questions, exams } from '@modules/exam/exam.schema.js'
import {
  createSubject, createBankQuestion, verifyBankQuestion, refreshSuccessRates,
} from '@modules/question-bank/index.js'
import { questionBank } from '@modules/question-bank/question-bank.schema.js'
import {
  startWizardDraft, generateIntoDraft, keepDraftQuestion, discardDraftQuestion,
  regenerateDraftQuestion, editDraftQuestion, finalizeGeneration,
} from '@modules/exam/index.js'
import { addQuestion, submitForReview, reorderQuestions, getPublicExamForStudent } from '@modules/exam/exam.service.js'
import {
  seedTenantWithUsers, createTestUser, createTestExam, createTestSession, createSessionAnswer,
  createTestClass, linkExamToClass,
} from '../../helpers/fixtures.js'

// Integration tests for the test-engine generator. They exercise the bank →
// generation → draft-review path against the real DB.
//
// Generation no longer creates an exam of its own: the wizard opens a draft
// first (`startWizardDraft`) and generation fills THAT draft, so a teacher's
// work is durable from the first click. `wizardGenerate` below is the two-step
// flow the UI performs, and papers are authored by the TEACHER — under the hard
// role split the coaching owner cannot author at all.

type Diff = 'easy' | 'medium' | 'hard'

let optionSeq = 0

// Create an mcq_single bank question and activate it so generation can pick it.
async function makeActiveQuestion(params: {
  tenantId: string | null
  createdBy: string
  subjectId: string
  difficulty?: Diff
  defaultMarks?: number
  sourceType?: 'original' | 'textbook' | 'pyq'
  cognitiveLevel?: string
}) {
  const a = `o${optionSeq++}`
  const b = `o${optionSeq++}`
  const q = await createBankQuestion({
    tenantId: params.tenantId,
    createdBy: params.createdBy,
    hierarchy: { subjectId: params.subjectId },
    type: 'mcq_single',
    difficulty: params.difficulty ?? 'easy',
    body: 'Pick the correct option',
    payload: { options: [{ id: a, text: 'A' }, { id: b, text: 'B' }] },
    answerKey: { optionId: a },
    defaultMarks: params.defaultMarks ?? 4,
    defaultNegativeMarks: 1,
    source: params.sourceType ? { type: params.sourceType } : undefined,
    metadata: params.cognitiveLevel ? { cognitiveLevel: params.cognitiveLevel } : undefined,
  })
  await verifyBankQuestion(q.id, params.tenantId, params.createdBy)
  return q
}

async function seedTeacherWithSubject(plan: 'free' | 'pro' = 'pro') {
  const { tenant, owner, teacher } = await seedTenantWithUsers(plan)
  const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
  return { tenant, owner, teacher, subjectId: subject.id }
}

// The wizard flow end to end: open a draft, then fill it from the bank.
async function wizardGenerate(input: {
  tenantId: string
  createdBy: string
  requesterRole: string
  title: string
  classIds?: string[]
  params: Parameters<typeof generateIntoDraft>[0]['params']
}) {
  const draft = await startWizardDraft({
    tenantId: input.tenantId, createdBy: input.createdBy,
    requesterRole: input.requesterRole, title: input.title,
  })
  return generateIntoDraft({
    examId: draft.id,
    tenantId: input.tenantId,
    requesterId: input.createdBy,
    requesterRole: input.requesterRole,
    title: input.title,
    classIds: input.classIds,
    params: input.params,
  })
}

const easyMcq = (total: number) => ({
  totalQuestions: total,
  typeDistribution: { mcq_single: total },
  difficultyDistribution: { easy: total },
})

describe('generateIntoDraft', () => {
  it('fills the buckets, copies questions as pending, and estimates duration', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    for (let i = 0; i < 5; i++) {
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId })
    }

    const result = await wizardGenerate({
      tenantId: tenant.id,
      createdBy: teacher.id,
      requesterRole: 'teacher',
      title: 'Generated Mock',
      params: { subjectId, ...easyMcq(3) },
    })

    expect(result.exam.status).toBe('draft')
    expect(result.questions).toHaveLength(3)
    expect(result.shortages).toHaveLength(0)

    for (const q of result.questions) {
      expect(q.draftStatus).toBe('pending')
      expect(q.bankQuestionId).toBeTruthy()
      expect(q.difficulty).toBe('easy')
      expect(q.marks).toBe(4)
    }

    // mcq_single/easy = 1 min each → 3
    expect(result.exam.estimatedDurationMins).toBe(3)
    // totalMarks reflects the in-transaction recompute (3 × 4)
    expect(result.exam.totalMarks).toBe(12)
    // No bank question is repeated within one exam.
    const bankIds = result.questions.map((q) => q.bankQuestionId)
    expect(new Set(bankIds).size).toBe(3)
  })

  it('reports a shortage when the bank cannot fully fill a bucket', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId })
    await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId })

    const result = await wizardGenerate({
      tenantId: tenant.id,
      createdBy: teacher.id,
      requesterRole: 'teacher',
      title: 'Too big',
      params: { subjectId, ...easyMcq(5) },
    })

    expect(result.questions).toHaveLength(2)
    expect(result.shortages).toEqual([
      { type: 'mcq_single', difficulty: 'easy', requested: 5, filled: 2 },
    ])
  })

  it('only picks active questions — drafts and flagged are ignored', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    // One active, plus one left as draft (never verified).
    await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId })
    await createBankQuestion({
      tenantId: tenant.id, createdBy: owner.id, hierarchy: { subjectId },
      type: 'mcq_single', difficulty: 'easy', body: 'draft one',
      payload: { options: [{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }] },
      answerKey: { optionId: 'x' },
    })

    const result = await wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'Active only', params: { subjectId, ...easyMcq(5) },
    })

    expect(result.questions).toHaveLength(1)
  })

  it('draws from the global pool plus own, but never another tenant\'s questions', async () => {
    // Global subject, visible to everyone.
    const sa = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global Physics' })

    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')

    const qGlobal = await makeActiveQuestion({ tenantId: null, createdBy: sa.owner.id, subjectId: globalSubject.id })
    const qA = await makeActiveQuestion({ tenantId: a.tenant.id, createdBy: a.owner.id, subjectId: globalSubject.id })
    const qB = await makeActiveQuestion({ tenantId: b.tenant.id, createdBy: b.owner.id, subjectId: globalSubject.id })

    // B generates under the global subject.
    const result = await wizardGenerate({
      tenantId: b.tenant.id, createdBy: b.teacher.id, requesterRole: 'teacher',
      title: 'Pooled', params: { subjectId: globalSubject.id, ...easyMcq(5) },
    })

    const pickedBankIds = result.questions.map((q) => q.bankQuestionId)
    expect(pickedBankIds).not.toContain(qA.id)        // tenant A's question is invisible to B
    expect(pickedBankIds.sort()).toEqual([qGlobal.id, qB.id].sort())
    expect(result.shortages[0]).toMatchObject({ requested: 5, filled: 2 })
  })

  it('source-filtered generation only draws from the requested origin', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    const pyq = [
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, sourceType: 'pyq' }),
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, sourceType: 'pyq' }),
    ]
    for (let i = 0; i < 3; i++) await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, sourceType: 'original' })

    const result = await wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'PYQ only', params: { subjectId, ...easyMcq(4), sourceType: 'pyq' },
    })

    const picked = result.questions.map((q) => q.bankQuestionId)
    expect(picked.every((id) => pyq.some((p) => p.id === id))).toBe(true)
    expect(result.questions).toHaveLength(2) // only 2 pyq exist
  })

  it('cognitive-level-filtered generation only draws from the requested levels', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    const apply = [
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, cognitiveLevel: 'apply' }),
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, cognitiveLevel: 'apply' }),
    ]
    for (let i = 0; i < 3; i++) await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId, cognitiveLevel: 'remember' })

    const result = await wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'Apply only', params: { subjectId, ...easyMcq(4), cognitiveLevels: ['apply'] },
    })

    const picked = result.questions.map((q) => q.bankQuestionId)
    expect(picked.every((id) => apply.some((p) => p.id === id))).toBe(true)
    expect(result.questions).toHaveLength(2)
  })

  it('rejects an invalid distribution before touching the bank', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    await expect(wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'Bad', params: {
        subjectId, totalQuestions: 10,
        typeDistribution: { mcq_single: 6 }, // sums to 6, not 10
        difficultyDistribution: { easy: 10 },
      },
    })).rejects.toThrow(/typeDistribution must sum/)
  })

  it('refuses a subject the tenant cannot see', async () => {
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const subjectA = await createSubject({ tenantId: a.tenant.id, createdBy: a.owner.id, name: 'A-only' })

    await expect(wizardGenerate({
      tenantId: b.tenant.id, createdBy: b.teacher.id, requesterRole: 'teacher',
      title: 'Cross-tenant', params: { subjectId: subjectA.id, ...easyMcq(1) },
    })).rejects.toThrow()
  })
})

describe('language variants', () => {
  it('copies bank language variants into generated questions', async () => {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    const q = await createBankQuestion({
      tenantId: tenant.id, createdBy: owner.id, hierarchy: { subjectId },
      type: 'mcq_single', difficulty: 'easy', body: 'English body',
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'a' },
      metadata: { languageVariants: { hi: 'हिंदी प्रश्न' } },
    })
    await verifyBankQuestion(q.id, tenant.id, owner.id)

    const result = await wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'LV', params: { subjectId, ...easyMcq(1) },
    })
    expect(result.questions[0].languageVariants).toEqual({ hi: 'हिंदी प्रश्न' })
  })

  it('serves the variant body for the requested language', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'live' })
    await db.insert(questions).values({
      examId: exam.id, tenantId: tenant.id, order: 1, type: 'mcq_single', body: 'English body',
      languageVariants: { hi: 'हिंदी प्रश्न' },
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, answerKey: { optionId: 'a' }, marks: 4,
    })

    const en = await getPublicExamForStudent(exam.id, student.id)
    expect(en.questions[0].body).toBe('English body')

    const hi = await getPublicExamForStudent(exam.id, student.id, 'hi')
    expect(hi.questions[0].body).toBe('हिंदी प्रश्न')

    // Falls back to the original body when no variant exists for the language.
    const ta = await getPublicExamForStudent(exam.id, student.id, 'ta')
    expect(ta.questions[0].body).toBe('English body')
  })
})

describe('draft review', () => {
  async function generateThree() {
    const { tenant, owner, teacher, subjectId } = await seedTeacherWithSubject()
    for (let i = 0; i < 6; i++) {
      await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId })
    }
    const result = await wizardGenerate({
      tenantId: tenant.id, createdBy: teacher.id, requesterRole: 'teacher',
      title: 'Review me', params: { subjectId, ...easyMcq(3) },
    })
    return { tenant, owner, teacher, subjectId, exam: result.exam, qs: result.questions }
  }

  it('finalize drops pending + discarded, keeps kept and manual, and renumbers', async () => {
    const { tenant, teacher, exam, qs } = await generateThree()

    await keepDraftQuestion(exam.id, qs[0].id, tenant.id, teacher.id, 'teacher')
    await discardDraftQuestion(exam.id, qs[1].id, tenant.id, teacher.id, 'teacher')
    // qs[2] left pending.

    // A manually authored question (draftStatus stays null) must survive.
    await addQuestion(exam.id, tenant.id, teacher.id, 'teacher', {
      type: 'mcq_single', body: 'manual', marks: 2,
      payload: { options: [{ id: 'm', text: 'A' }, { id: 'n', text: 'B' }] },
      answerKey: { optionId: 'm' },
    })

    await finalizeGeneration(exam.id, tenant.id, teacher.id, 'teacher')

    const remaining = await db.select().from(questions).where(eq(questions.examId, exam.id))
    const ids = remaining.map((r) => r.id).sort()
    expect(ids).toContain(qs[0].id)       // kept
    expect(ids).not.toContain(qs[1].id)   // discarded → gone
    expect(ids).not.toContain(qs[2].id)   // still pending → gone
    expect(remaining).toHaveLength(2)     // kept + manual
    // Orders are contiguous 1..n
    expect(remaining.map((r) => r.order).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('edit updates content + marks and flips the slot to kept', async () => {
    const { tenant, teacher, exam, qs } = await generateThree()
    const updated = await editDraftQuestion(
      exam.id, qs[1].id, tenant.id, teacher.id, 'teacher',
      { body: 'Edited question body', marks: 7 },
    )
    expect(updated.body).toBe('Edited question body')
    expect(updated.marks).toBe(7)
    expect(updated.draftStatus).toBe('kept')

    // totalMarks reflects the changed marks (2 untouched @ default + 1 @ 7)
    const all = await db.select().from(questions).where(eq(questions.examId, exam.id))
    const total = all.reduce((n, q) => n + q.marks, 0)
    const [{ totalMarks }] = await db.select({ totalMarks: exams.totalMarks }).from(exams).where(eq(exams.id, exam.id))
    expect(totalMarks).toBe(total)
  })

  it('reorder rearranges draft questions', async () => {
    const { tenant, teacher, exam, qs } = await generateThree()
    const reversed = qs.map((q) => q.id).reverse()
    const res = await reorderQuestions(exam.id, tenant.id, teacher.id, 'teacher', reversed)
    expect(res.map((r) => r.id)).toEqual(reversed)
  })

  it('regenerate swaps in a different bank question, keeping the slot pending', async () => {
    const { tenant, teacher, exam, qs } = await generateThree()
    const target = qs[0]
    const before = target.bankQuestionId

    const replaced = await regenerateDraftQuestion(exam.id, target.id, tenant.id, teacher.id, 'teacher')

    expect(replaced.id).toBe(target.id)            // same slot row
    expect(replaced.bankQuestionId).not.toBe(before) // different bank source
    expect(replaced.draftStatus).toBe('pending')

    // The new source isn't one already used elsewhere in the exam.
    const all = await db.select().from(questions).where(eq(questions.examId, exam.id))
    const bankIds = all.map((r) => r.bankQuestionId)
    expect(new Set(bankIds).size).toBe(bankIds.length)
  })

  it('refreshSuccessRates derives the fraction-correct from graded answers', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const bankQ = await makeActiveQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })

    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const [q] = await db.insert(questions).values({
      examId: exam.id, tenantId: tenant.id, bankQuestionId: bankQ.id, order: 1,
      type: 'mcq_single', body: 'Q', payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'a' }, marks: 4,
    }).returning()

    const s2 = await createTestUser({ role: 'student', tenantId: tenant.id })
    const sess1 = await createTestSession({ examId: exam.id, studentId: student.id, tenantId: tenant.id })
    const sess2 = await createTestSession({ examId: exam.id, studentId: s2.id, tenantId: tenant.id })
    // one correct, one wrong
    await createSessionAnswer({ sessionId: sess1.id, questionId: q.id, answer: { optionId: 'a' }, isCorrect: true, awardedMarks: 4 })
    await createSessionAnswer({ sessionId: sess2.id, questionId: q.id, answer: { optionId: 'b' }, isCorrect: false, awardedMarks: 0 })

    await refreshSuccessRates([bankQ.id])

    const [row] = await db.select({ rate: questionBank.avgSuccessRate }).from(questionBank).where(eq(questionBank.id, bankQ.id))
    expect(Number(row.rate)).toBeCloseTo(0.5, 4)
  })

  it('blocks draft review once the exam leaves draft (submitted for review)', async () => {
    const { tenant, teacher, exam, qs } = await generateThree()
    // Keep all three so finalize leaves a submittable exam.
    for (const q of qs) await keepDraftQuestion(exam.id, q.id, tenant.id, teacher.id, 'teacher')
    await finalizeGeneration(exam.id, tenant.id, teacher.id, 'teacher')
    // Generated exams are private, so they must be assigned to a class before
    // they can be submitted for review.
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, cls.id)
    const submitted = await submitForReview(exam.id, tenant.id, teacher.id, 'teacher')
    expect(submitted.status).toBe('under_review')

    await expect(
      discardDraftQuestion(exam.id, qs[0].id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/only allowed while the exam is a draft/)
  })
})
