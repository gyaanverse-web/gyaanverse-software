export type UploadScope = 'answer' | 'question' | 'syllabus' | 'avatar'

export interface UploadSignature {
  /** POST destination, e.g. https://api.cloudinary.com/v1_1/<cloud>/auto/upload */
  uploadUrl: string
  /** Signed params that the client must send as multipart/form-data alongside `file` */
  fields: {
    api_key: string
    timestamp: number
    signature: string
    folder: string
    public_id: string
    resource_type: 'image' | 'raw' | 'auto'
  }
  /** Max bytes the client should reject before uploading */
  maxBytes: number
  /** Allow-list of content types the client should enforce locally too */
  allowedContentTypes: string[]
}
