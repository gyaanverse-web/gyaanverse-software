import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// Mirror the createExamSchema refine logic exactly. We test the schema
// behavior by re-declaring it here — exam.routes.ts doesn't export it, and
// extracting it just for tests would couple the test to internal layout.
// If the routes' schema drifts from this, the test won't catch it; the
// payment.service tests still catch the actual exploit either way.
const createExamSchema = z.object({
  title: z.string().min(2).max(255),
  durationMins: z.number().int().min(1).max(600),
  visibility: z.enum(['private', 'public_free', 'public_paid']),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
}).refine(
  (data) => {
    const hasPrice = data.price !== undefined && parseFloat(data.price) > 0
    if (data.visibility === 'public_paid') return hasPrice
    return !hasPrice
  },
  {
    message: 'price > 0 is required for public_paid exams and forbidden for private/public_free',
    path: ['price'],
  },
)

describe('createExamSchema price/visibility consistency', () => {
  it('accepts public_paid with a valid price', () => {
    const result = createExamSchema.safeParse({
      title: 'JEE Mock 1', durationMins: 60, visibility: 'public_paid', price: '199.00',
    })
    expect(result.success).toBe(true)
  })

  it('accepts private without a price', () => {
    const result = createExamSchema.safeParse({
      title: 'Class Test', durationMins: 60, visibility: 'private',
    })
    expect(result.success).toBe(true)
  })

  it('accepts public_free without a price', () => {
    const result = createExamSchema.safeParse({
      title: 'Free Mock', durationMins: 60, visibility: 'public_free',
    })
    expect(result.success).toBe(true)
  })

  it('CRITICAL: rejects private with a price set', () => {
    const result = createExamSchema.safeParse({
      title: 'Class Test', durationMins: 60, visibility: 'private', price: '99.00',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.errors[0].path).toContain('price')
    }
  })

  it('CRITICAL: rejects public_free with a price set', () => {
    const result = createExamSchema.safeParse({
      title: 'Free Mock', durationMins: 60, visibility: 'public_free', price: '49.00',
    })
    expect(result.success).toBe(false)
  })

  it('rejects public_paid without a price', () => {
    const result = createExamSchema.safeParse({
      title: 'Paid Mock', durationMins: 60, visibility: 'public_paid',
    })
    expect(result.success).toBe(false)
  })

  it('rejects public_paid with price = 0', () => {
    const result = createExamSchema.safeParse({
      title: 'Paid Mock', durationMins: 60, visibility: 'public_paid', price: '0.00',
    })
    expect(result.success).toBe(false)
  })
})
