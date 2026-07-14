import { z } from 'zod'

// ── Payload schemas ────────────────────────────────────────────────────────

const mcqOption = z.object({
  id: z.string().min(1).max(10),
  text: z.string().min(1).max(500),
  imageUrl: z.string().url().optional(),
})

export const payloadSchemas = {
  mcq_single: z.object({ options: z.array(mcqOption).min(2).max(6) }),
  mcq_multiple: z.object({ options: z.array(mcqOption).min(2).max(6) }),
  integer: z.object({}),
  numerical: z.object({ decimalPlaces: z.number().int().min(0).max(4).optional() }),
  subjective: z.object({ wordLimit: z.number().int().min(1).max(5000).optional() }),
  match: z.object({
    left: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2).max(8),
    right: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2).max(8),
  }),
  assertion_reason: z.object({ assertion: z.string().min(1), reason: z.string().min(1) }),
  fill_blanks: z.object({ blanks: z.number().int().min(1).max(10) }),
} as const

// ── Answer key schemas ─────────────────────────────────────────────────────

export const answerKeySchemas = {
  mcq_single: z.object({ optionId: z.string().min(1) }),
  mcq_multiple: z.object({ optionIds: z.array(z.string().min(1)).min(1) }),
  integer: z.object({ value: z.number().int() }),
  numerical: z.object({ value: z.number(), tolerance: z.number().nonnegative().optional() }),
  subjective: z.object({ sampleAnswer: z.string().optional(), rubric: z.string().optional() }),
  match: z.object({
    pairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })).min(1),
  }),
  assertion_reason: z.object({ option: z.enum(['A', 'B', 'C', 'D', 'E']) }),
  fill_blanks: z.object({ answers: z.array(z.string().min(1)).min(1) }),
} as const

// ── Student answer schemas ─────────────────────────────────────────────────

export const studentAnswerSchemas = {
  mcq_single: z.object({ optionId: z.string().min(1) }),
  mcq_multiple: z.object({ optionIds: z.array(z.string().min(1)).min(1) }),
  integer: z.object({ value: z.number().int() }),
  numerical: z.object({ value: z.number() }),
  subjective: z.object({ text: z.string().max(10000).optional() }),
  match: z.object({
    pairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })),
  }),
  assertion_reason: z.object({ option: z.enum(['A', 'B', 'C', 'D', 'E']) }),
  fill_blanks: z.object({ answers: z.array(z.string()) }),
} as const

// ── Combined validation ────────────────────────────────────────────────────

type QuestionType = keyof typeof payloadSchemas

export function validateQuestionPayload(
  type: string,
  payload: unknown,
  answerKey: unknown,
): { error: string } | { payload: Record<string, unknown>; answerKey: Record<string, unknown> } {
  if (!(type in payloadSchemas)) return { error: `Unknown question type: ${type}` }
  const t = type as QuestionType

  const p = payloadSchemas[t].safeParse(payload)
  if (!p.success) return { error: `payload: ${p.error.errors[0].message}` }

  const a = answerKeySchemas[t].safeParse(answerKey)
  if (!a.success) return { error: `answerKey: ${a.error.errors[0].message}` }

  // Cross-field checks
  if (t === 'mcq_single') {
    const pd = p.data as { options: Array<{ id: string }> }
    const ad = a.data as { optionId: string }
    if (!pd.options.some((o) => o.id === ad.optionId))
      return { error: 'answerKey.optionId must match one of the option ids' }
  }

  if (t === 'mcq_multiple') {
    const pd = p.data as { options: Array<{ id: string }> }
    const ad = a.data as { optionIds: string[] }
    const optionIds = new Set(pd.options.map((o) => o.id))
    if (!ad.optionIds.every((id) => optionIds.has(id)))
      return { error: 'answerKey.optionIds must all be valid option ids' }
  }

  if (t === 'fill_blanks') {
    const pd = p.data as { blanks: number }
    const ad = a.data as { answers: string[] }
    if (ad.answers.length !== pd.blanks)
      return { error: `answerKey.answers must have exactly ${pd.blanks} entries` }
  }

  return { payload: p.data as Record<string, unknown>, answerKey: a.data as Record<string, unknown> }
}

export function validateStudentAnswer(
  type: string,
  answer: unknown,
): { error: string } | { answer: Record<string, unknown> } {
  if (!(type in studentAnswerSchemas)) return { error: `Unknown question type: ${type}` }
  const result = studentAnswerSchemas[type as QuestionType].safeParse(answer)
  if (!result.success) return { error: result.error.errors[0].message }
  return { answer: result.data as Record<string, unknown> }
}
