// Pure grading functions — no DB access, fully unit-testable.

export function isObjectiveType(type: string): boolean {
  return ['mcq_single', 'mcq_multiple', 'integer', 'numerical', 'assertion_reason', 'match', 'fill_blanks'].includes(type)
}

export function gradeQuestion(
  type: string,
  answerKey: Record<string, unknown>,
  answer: Record<string, unknown> | null,
  marks: number,
  negativeMarks: number,
): { isCorrect: boolean; awardedMarks: number } {
  if (answer === null) return { isCorrect: false, awardedMarks: 0 }

  switch (type) {
    case 'mcq_single': {
      const correct = (answerKey.optionId as string) === (answer.optionId as string)
      return { isCorrect: correct, awardedMarks: correct ? marks : -negativeMarks }
    }

    case 'mcq_multiple': {
      const keyIds = new Set(answerKey.optionIds as string[])
      const ansIds = new Set((answer.optionIds as string[]) ?? [])
      // Any wrong selection → negative
      const hasWrong = [...ansIds].some((id) => !keyIds.has(id))
      if (hasWrong) return { isCorrect: false, awardedMarks: -negativeMarks }
      // All correct selected → full marks; subset → partial (proportional)
      const correct = ansIds.size === keyIds.size && [...ansIds].every((id) => keyIds.has(id))
      if (correct) return { isCorrect: true, awardedMarks: marks }
      // Partial: (correct selected / total correct) * marks
      const fraction = ansIds.size / keyIds.size
      return { isCorrect: false, awardedMarks: Math.floor(fraction * marks) }
    }

    case 'integer': {
      const correct = (answerKey.value as number) === (answer.value as number)
      return { isCorrect: correct, awardedMarks: correct ? marks : -negativeMarks }
    }

    case 'numerical': {
      const tolerance = (answerKey.tolerance as number) ?? 0
      const correct = Math.abs((answerKey.value as number) - (answer.value as number)) <= tolerance
      return { isCorrect: correct, awardedMarks: correct ? marks : -negativeMarks }
    }

    case 'assertion_reason': {
      const correct = (answerKey.option as string) === (answer.option as string)
      return { isCorrect: correct, awardedMarks: correct ? marks : -negativeMarks }
    }

    case 'match': {
      const keyPairs = answerKey.pairs as Array<{ leftId: string; rightId: string }>
      const ansPairs = (answer.pairs as Array<{ leftId: string; rightId: string }>) ?? []
      // Partial: each correct pair = marks / totalPairs, no negative
      const marksPerPair = marks / keyPairs.length
      let correctCount = 0
      for (const kp of keyPairs) {
        if (ansPairs.some((ap) => ap.leftId === kp.leftId && ap.rightId === kp.rightId)) {
          correctCount++
        }
      }
      const isCorrect = correctCount === keyPairs.length
      return { isCorrect, awardedMarks: Math.floor(correctCount * marksPerPair) }
    }

    case 'fill_blanks': {
      const keyAnswers = answerKey.answers as string[]
      const ansAnswers = (answer.answers as string[]) ?? []
      // Partial: each blank = marks / totalBlanks, no negative
      const marksPerBlank = marks / keyAnswers.length
      let correctCount = 0
      for (let i = 0; i < keyAnswers.length; i++) {
        if ((ansAnswers[i] ?? '').trim().toLowerCase() === keyAnswers[i].trim().toLowerCase()) {
          correctCount++
        }
      }
      const isCorrect = correctCount === keyAnswers.length
      return { isCorrect, awardedMarks: Math.floor(correctCount * marksPerBlank) }
    }

    default:
      // subjective — cannot auto-grade
      return { isCorrect: false, awardedMarks: 0 }
  }
}
