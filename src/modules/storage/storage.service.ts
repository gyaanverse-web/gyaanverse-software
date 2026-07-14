import { v2 as cloudinary } from 'cloudinary'
import { eq } from 'drizzle-orm'
import { env } from '@config/env.js'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import type { UploadScope, UploadSignature } from './storage.types.js'

// ── Cloudinary singleton ──────────────────────────────────────────────────

let _configured = false
function getCloudinary() {
  if (!_configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    })
    _configured = true
  }
  return cloudinary
}

// ── Allow-lists ───────────────────────────────────────────────────────────

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const DOC_TYPES = ['application/pdf', 'text/plain']

function allowedTypesFor(scope: UploadScope): string[] {
  switch (scope) {
    case 'answer':
    case 'question':
    case 'avatar':
      return IMAGE_TYPES
    case 'syllabus':
      return [...IMAGE_TYPES, ...DOC_TYPES]
  }
}

function resourceTypeFor(scope: UploadScope): 'image' | 'raw' | 'auto' {
  return scope === 'syllabus' ? 'auto' : 'image'
}

// ── Folder strategy ────────────────────────────────────────────────────────
// All assets live under {root}/{tenantId|public}/{scope}/{contextKey}/
// Tenants can't read other tenants' uploads (URL is hard to guess, plus we
// can apply Cloudinary access-control later if needed).

function buildFolder(params: {
  tenantId: string | null
  scope: UploadScope
  contextKey: string
}): string {
  const tenant = params.tenantId ?? 'public'
  return `${env.CLOUDINARY_UPLOAD_FOLDER}/${tenant}/${params.scope}/${params.contextKey}`
}

// ── Public APIs ───────────────────────────────────────────────────────────

/**
 * Issue a signature so the client can upload a student answer image directly
 * to Cloudinary. Validates that the requesting student owns the session, that
 * the session is still active, and that the content type is image/*.
 */
export async function getAnswerUploadSignature(params: {
  studentId: string
  sessionId: string
  questionId: string
  contentType: string
}): Promise<UploadSignature> {
  const { studentId, sessionId, questionId, contentType } = params

  if (!IMAGE_TYPES.includes(contentType)) {
    throw Errors.VALIDATION(`Unsupported content type: ${contentType}`)
  }

  const [session] = await db
    .select({
      id: examSessions.id,
      studentId: examSessions.studentId,
      tenantId: examSessions.tenantId,
      status: examSessions.status,
      expiresAt: examSessions.expiresAt,
    })
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.studentId !== studentId) throw Errors.FORBIDDEN()
  if (session.status !== 'in_progress')
    throw new AppError('VALIDATION', 'Session is not active', 422)
  if (new Date() > session.expiresAt)
    throw new AppError('VALIDATION', 'Session has expired', 422)

  return signUpload({
    tenantId: session.tenantId,
    scope: 'answer',
    contextKey: `${sessionId}/${questionId}`,
    resourceType: 'image',
  })
}

/**
 * Tenant-staff upload (question images, syllabus PDFs, branding).
 */
export async function getTenantUploadSignature(params: {
  tenantId: string
  scope: Extract<UploadScope, 'question' | 'syllabus' | 'avatar'>
  contextKey: string
  contentType: string
}): Promise<UploadSignature> {
  const allowed = allowedTypesFor(params.scope)
  if (!allowed.includes(params.contentType)) {
    throw Errors.VALIDATION(`Unsupported content type for ${params.scope}: ${params.contentType}`)
  }

  return signUpload({
    tenantId: params.tenantId,
    scope: params.scope,
    contextKey: params.contextKey,
    resourceType: resourceTypeFor(params.scope),
  })
}

/**
 * Wrap a Cloudinary secure_url in transformations that make handwritten
 * student answers easier to OCR: auto-orient via EXIF, normalize quality,
 * cap dimensions so we don't ship 12 MP photos to the engine.
 *
 * Pass any Cloudinary URL — returns a new URL with the transform inserted.
 * If the URL isn't recognizable, returns the input unchanged.
 */
export function buildOcrFriendlyUrl(secureUrl: string): string {
  // Cloudinary URLs look like:
  //   https://res.cloudinary.com/<cloud>/image/upload/v123/folder/public_id.ext
  // Insert transform between `upload/` and the version segment.
  const marker = '/upload/'
  const idx = secureUrl.indexOf(marker)
  if (idx === -1) return secureUrl

  const transform = 'a_auto,q_auto:good,f_auto,w_2000,c_limit'
  return (
    secureUrl.slice(0, idx + marker.length) +
    transform +
    '/' +
    secureUrl.slice(idx + marker.length)
  )
}

/**
 * Delete an asset by public_id. Returns true if Cloudinary acknowledged the
 * deletion ("ok" or "not found" — both end states are fine for our purposes).
 */
export async function deleteFile(publicId: string, resourceType: 'image' | 'raw' = 'image'): Promise<boolean> {
  const result = await getCloudinary().uploader.destroy(publicId, { resource_type: resourceType })
  return result.result === 'ok' || result.result === 'not found'
}

// ── Internal ──────────────────────────────────────────────────────────────

function signUpload(params: {
  tenantId: string | null
  scope: UploadScope
  contextKey: string
  resourceType: 'image' | 'raw' | 'auto'
}): UploadSignature {
  const folder = buildFolder({
    tenantId: params.tenantId,
    scope: params.scope,
    contextKey: params.contextKey,
  })
  const publicId = crypto.randomUUID()
  const timestamp = Math.floor(Date.now() / 1000)

  // Cloudinary signs the sorted params (excluding api_key, file, signature,
  // resource_type, cloud_name). We include only what we want pinned.
  const paramsToSign = {
    folder,
    public_id: publicId,
    timestamp,
  }

  const signature = getCloudinary().utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET)

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${params.resourceType}/upload`,
    fields: {
      api_key: env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
      public_id: publicId,
      resource_type: params.resourceType,
    },
    maxBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    allowedContentTypes: allowedTypesFor(params.scope),
  }
}
