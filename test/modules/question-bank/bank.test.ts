import { describe, it, expect } from 'vitest'
import {
  createSubject, listSubjects, updateSubject, deleteSubject,
  createModule, createChapter, createSection, createConcept,
  updateChapter, deleteChapter,
  createBankQuestion, getBankQuestion, listBankQuestions, updateBankQuestion,
  verifyBankQuestion, flagBankQuestion, archiveBankQuestion,
} from '@modules/question-bank/index.js'
import { seedTenantWithUsers } from '../../helpers/fixtures.js'

// Integration tests for the question bank: hierarchy resolution, the bank CRUD
// lifecycle (draft → verify → active → flag/archive), and the dual-ownership
// scope rules (see global + own; mutate only your own).

let seq = 0

async function makeDraftQuestion(params: {
  tenantId: string | null
  createdBy: string
  subjectId?: string
  conceptId?: string
  difficulty?: 'easy' | 'medium' | 'hard'
}) {
  const a = `o${seq++}`
  const b = `o${seq++}`
  return createBankQuestion({
    tenantId: params.tenantId,
    createdBy: params.createdBy,
    hierarchy: params.conceptId ? { conceptId: params.conceptId } : { subjectId: params.subjectId! },
    type: 'mcq_single',
    difficulty: params.difficulty ?? 'medium',
    body: 'Pick one',
    payload: { options: [{ id: a, text: 'A' }, { id: b, text: 'B' }] },
    answerKey: { optionId: a },
    defaultMarks: 4,
  })
}

describe('hierarchy resolution', () => {
  it('denormalizes the full ancestor path onto a question tagged at concept level', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const mod = await createModule({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id, name: 'Mechanics' })
    const chapter = await createChapter({ tenantId: tenant.id, createdBy: owner.id, moduleId: mod.id, name: 'Kinematics' })
    const section = await createSection({ tenantId: tenant.id, createdBy: owner.id, chapterId: chapter.id, name: 'Motion' })
    const concept = await createConcept({ tenantId: tenant.id, createdBy: owner.id, sectionId: section.id, name: 'Velocity' })

    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, conceptId: concept.id })

    expect(q.subjectId).toBe(subject.id)
    expect(q.moduleId).toBe(mod.id)
    expect(q.chapterId).toBe(chapter.id)
    expect(q.sectionId).toBe(section.id)
    expect(q.conceptId).toBe(concept.id)
  })

  it('leaves deeper levels null when a question is tagged at subject level', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })

    expect(q.subjectId).toBe(subject.id)
    expect(q.moduleId).toBeNull()
    expect(q.chapterId).toBeNull()
  })

  it('refuses to create a module under a subject the tenant cannot see', async () => {
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const subjectA = await createSubject({ tenantId: a.tenant.id, createdBy: a.owner.id, name: 'A-only' })

    await expect(
      createModule({ tenantId: b.tenant.id, createdBy: b.owner.id, subjectId: subjectA.id, name: 'X' }),
    ).rejects.toThrow()
  })

  it('lets an institute tag a question against a global subject', async () => {
    const sa = await seedTenantWithUsers('pro')
    const tenantBundle = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global Physics' })

    const q = await makeDraftQuestion({
      tenantId: tenantBundle.tenant.id, createdBy: tenantBundle.owner.id, subjectId: globalSubject.id,
    })
    expect(q.subjectId).toBe(globalSubject.id)
    expect(q.tenantId).toBe(tenantBundle.tenant.id) // the question is institute-private
  })
})

describe('bank question lifecycle', () => {
  it('starts as an unverified draft', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })

    expect(q.status).toBe('draft')
    expect(q.isVerified).toBe(false)
    expect(q.verifiedAt).toBeNull()
    expect(q.usageCount).toBe(0)
  })

  it('verify activates the question and stamps the reviewer', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })

    const verified = await verifyBankQuestion(q.id, tenant.id, owner.id)
    expect(verified.status).toBe('active')
    expect(verified.isVerified).toBe(true)
    expect(verified.verifiedBy).toBe(owner.id)
    expect(verified.verifiedAt).not.toBeNull()
  })

  it('editing the answer key resets verification', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })
    await verifyBankQuestion(q.id, tenant.id, owner.id)

    // Flip the correct option to the other existing option id.
    const otherId = (q.payload as { options: { id: string }[] }).options[1].id
    const updated = await updateBankQuestion(q.id, tenant.id, { answerKey: { optionId: otherId } })

    expect(updated.isVerified).toBe(false)
    expect(updated.verifiedBy).toBeNull()
    expect(updated.verifiedAt).toBeNull()
  })

  it('editing only non-content fields keeps verification intact', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })
    await verifyBankQuestion(q.id, tenant.id, owner.id)

    const updated = await updateBankQuestion(q.id, tenant.id, { tags: ['jee', 'important'], explanation: 'because' })
    expect(updated.isVerified).toBe(true)
    expect(updated.tags).toEqual(['jee', 'important'])
  })

  it('flag and archive move the question out of the active pool', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })
    const q = await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id })

    const flagged = await flagBankQuestion(q.id, tenant.id, 'wrong answer key')
    expect(flagged.status).toBe('flagged')
    expect(flagged.flagReason).toBe('wrong answer key')

    const archived = await archiveBankQuestion(q.id, tenant.id)
    expect(archived.status).toBe('archived')
  })

  it('rejects an answer key that does not match the payload options', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })

    await expect(createBankQuestion({
      tenantId: tenant.id, createdBy: owner.id, hierarchy: { subjectId: subject.id },
      type: 'mcq_single', difficulty: 'easy', body: 'bad',
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'zzz' }, // not a real option
    })).rejects.toThrow()
  })

  it('rejects an unknown difficulty', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Physics' })

    await expect(createBankQuestion({
      tenantId: tenant.id, createdBy: owner.id, hierarchy: { subjectId: subject.id },
      type: 'mcq_single', difficulty: 'impossible', body: 'x',
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'a' },
    })).rejects.toThrow(/difficulty/)
  })
})

describe('hierarchy edit / delete', () => {
  it('renames a node', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Phsyics' })
    const fixed = await updateSubject(subject.id, tenant.id, { name: 'Physics' })
    expect(fixed.name).toBe('Physics')
  })

  it('deletes an empty node and cascades to its children', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Temp' })
    const mod = await createModule({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id, name: 'M' })
    await createChapter({ tenantId: tenant.id, createdBy: owner.id, moduleId: mod.id, name: 'C' })

    await expect(deleteSubject(subject.id, tenant.id)).resolves.toMatchObject({ success: true })
    const remaining = await listSubjects(tenant.id)
    expect(remaining.map((s) => s.id)).not.toContain(subject.id)
  })

  it('refuses to delete a node that has bank questions tagged in its subtree', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const subject = await createSubject({ tenantId: tenant.id, createdBy: owner.id, name: 'Has Qs' })
    const mod = await createModule({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id, name: 'M' })
    const chapter = await createChapter({ tenantId: tenant.id, createdBy: owner.id, moduleId: mod.id, name: 'C' })
    await makeDraftQuestion({ tenantId: tenant.id, createdBy: owner.id, subjectId: subject.id }) // tagged under subject (denormalized chapter null)

    // Deleting the subject is blocked because a question carries its subjectId.
    await expect(deleteSubject(subject.id, tenant.id)).rejects.toThrow(/Cannot delete/)
    // The chapter has no questions tagged at chapter level → deletable.
    await expect(deleteChapter(chapter.id, tenant.id)).resolves.toMatchObject({ success: true })
  })

  it('cannot edit or delete another tenant\'s node', async () => {
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const subjectA = await createSubject({ tenantId: a.tenant.id, createdBy: a.owner.id, name: 'A' })
    await expect(updateSubject(subjectA.id, b.tenant.id, { name: 'X' })).rejects.toThrow()
    await expect(deleteSubject(subjectA.id, b.tenant.id)).rejects.toThrow()
  })
})

describe('dual-ownership scope rules', () => {
  it('a tenant can read global and own questions, but not another tenant\'s', async () => {
    const sa = await seedTenantWithUsers('pro')
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global' })

    const qGlobal = await makeDraftQuestion({ tenantId: null, createdBy: sa.owner.id, subjectId: globalSubject.id })
    const qA = await makeDraftQuestion({ tenantId: a.tenant.id, createdBy: a.owner.id, subjectId: globalSubject.id })
    const qB = await makeDraftQuestion({ tenantId: b.tenant.id, createdBy: b.owner.id, subjectId: globalSubject.id })

    // B sees global + its own.
    await expect(getBankQuestion(qGlobal.id, b.tenant.id)).resolves.toMatchObject({ id: qGlobal.id })
    await expect(getBankQuestion(qB.id, b.tenant.id)).resolves.toMatchObject({ id: qB.id })
    // B cannot see A's.
    await expect(getBankQuestion(qA.id, b.tenant.id)).rejects.toThrow()
  })

  it('a tenant cannot mutate another tenant\'s question', async () => {
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const subjectA = await createSubject({ tenantId: a.tenant.id, createdBy: a.owner.id, name: 'A' })
    const qA = await makeDraftQuestion({ tenantId: a.tenant.id, createdBy: a.owner.id, subjectId: subjectA.id })

    await expect(verifyBankQuestion(qA.id, b.tenant.id, b.owner.id)).rejects.toThrow()
    await expect(updateBankQuestion(qA.id, b.tenant.id, { tags: ['x'] })).rejects.toThrow()
    await expect(archiveBankQuestion(qA.id, b.tenant.id)).rejects.toThrow()
  })

  it('a tenant cannot mutate a global question (read-only to institutes)', async () => {
    const sa = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global' })
    const qGlobal = await makeDraftQuestion({ tenantId: null, createdBy: sa.owner.id, subjectId: globalSubject.id })

    await expect(verifyBankQuestion(qGlobal.id, b.tenant.id, b.owner.id)).rejects.toThrow()
  })

  it('listBankQuestions returns global + own and honours filters', async () => {
    const sa = await seedTenantWithUsers('pro')
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global' })

    const qGlobal = await makeDraftQuestion({ tenantId: null, createdBy: sa.owner.id, subjectId: globalSubject.id, difficulty: 'hard' })
    const qA = await makeDraftQuestion({ tenantId: a.tenant.id, createdBy: a.owner.id, subjectId: globalSubject.id })
    const qB = await makeDraftQuestion({ tenantId: b.tenant.id, createdBy: b.owner.id, subjectId: globalSubject.id, difficulty: 'hard' })

    const visibleToB = await listBankQuestions(b.tenant.id, {})
    const ids = visibleToB.map((q) => q.id)
    expect(ids).toContain(qGlobal.id)
    expect(ids).toContain(qB.id)
    expect(ids).not.toContain(qA.id)

    const hardOnly = await listBankQuestions(b.tenant.id, { difficulty: 'hard' })
    const hardIds = hardOnly.map((q) => q.id)
    expect(hardIds).toContain(qGlobal.id)
    expect(hardIds).toContain(qB.id)
  })

  it('listSubjects returns global + own only', async () => {
    const sa = await seedTenantWithUsers('pro')
    const a = await seedTenantWithUsers('pro')
    const b = await seedTenantWithUsers('pro')
    const globalSubject = await createSubject({ tenantId: null, createdBy: sa.owner.id, name: 'Global Subject' })
    const subjA = await createSubject({ tenantId: a.tenant.id, createdBy: a.owner.id, name: 'A Subject' })
    const subjB = await createSubject({ tenantId: b.tenant.id, createdBy: b.owner.id, name: 'B Subject' })

    const forB = await listSubjects(b.tenant.id)
    const ids = forB.map((s) => s.id)
    expect(ids).toContain(globalSubject.id)
    expect(ids).toContain(subjB.id)
    expect(ids).not.toContain(subjA.id)
  })
})
