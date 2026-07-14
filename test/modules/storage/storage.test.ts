import { describe, it, expect } from 'vitest'
import {
  getAnswerUploadSignature,
  buildOcrFriendlyUrl,
} from '@modules/storage/storage.service.js'
import {
  createTestUser,
  createTestExam,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

describe('getAnswerUploadSignature — content type validation', () => {
  it('accepts standard image types', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
      const sig = await getAnswerUploadSignature({
        studentId: student.id,
        sessionId: session.id,
        questionId: 'irrelevant',
        contentType: ct,
      })
      expect(sig.fields.signature).toMatch(/^[a-f0-9]+$/) // hex SHA1
      expect(sig.uploadUrl).toContain('cloudinary.com')
      expect(sig.fields.folder).toContain(tenant.id)
      expect(sig.fields.folder).toContain('answer')
      expect(sig.fields.folder).toContain(session.id)
    }
  })

  it('rejects non-image content types (PDFs, scripts, etc.)', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    for (const bad of ['application/pdf', 'text/html', 'application/x-msdownload', '']) {
      await expect(
        getAnswerUploadSignature({
          studentId: student.id,
          sessionId: session.id,
          questionId: 'q1',
          contentType: bad,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })
})

describe('getAnswerUploadSignature — session ownership', () => {
  it('CRITICAL: rejects upload requests against another student\'s session', async () => {
    // Without this guard, any authenticated student could upload images into
    // another student's exam session and have them OCR'd / scored.
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    const attacker = await createTestUser({ role: 'student' })

    await expect(
      getAnswerUploadSignature({
        studentId: attacker.id, // wrong student!
        sessionId: session.id,
        questionId: 'q1',
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
  })

  it('rejects unknown sessionId', async () => {
    const student = await createTestUser()
    await expect(
      getAnswerUploadSignature({
        studentId: student.id,
        sessionId: '00000000-0000-0000-0000-000000000000',
        questionId: 'q1',
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('getAnswerUploadSignature — session lifecycle', () => {
  it('rejects sessions that have already been submitted', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })

    await expect(
      getAnswerUploadSignature({
        studentId: student.id,
        sessionId: session.id,
        questionId: 'q1',
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects sessions that are already evaluated', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'evaluated',
    })

    await expect(
      getAnswerUploadSignature({
        studentId: student.id,
        sessionId: session.id,
        questionId: 'q1',
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('buildOcrFriendlyUrl', () => {
  it('inserts auto-orient + quality transforms into a Cloudinary URL', () => {
    const input = 'https://res.cloudinary.com/test/image/upload/v123/folder/abc.jpg'
    const output = buildOcrFriendlyUrl(input)
    expect(output).toContain('/upload/a_auto,q_auto:good,f_auto,w_2000,c_limit/')
    expect(output).toContain('v123/folder/abc.jpg')
  })

  it('returns non-Cloudinary URLs unchanged (no /upload/ marker)', () => {
    const input = 'https://example.com/foo.jpg'
    expect(buildOcrFriendlyUrl(input)).toBe(input)
  })

  it('handles URLs without a version segment', () => {
    const input = 'https://res.cloudinary.com/test/image/upload/folder/abc.jpg'
    const output = buildOcrFriendlyUrl(input)
    expect(output).toContain('/upload/a_auto,q_auto:good,f_auto,w_2000,c_limit/folder/abc.jpg')
  })
})
