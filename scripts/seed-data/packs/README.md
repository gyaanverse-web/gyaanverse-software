# Content packs

A **pack** is one subject's full 5-level tree plus the questions hanging off it:

```
subject → module → chapter → section → concept → questions
```

`npm run seed:studio` (step 5) lists every `.json` file in this folder and
imports the chosen one into the selected coaching. Questions land as
`status: 'active'` and `isVerified: true`, because only `active` rows are
visible to the test generator — an import the teacher cannot draw from would
defeat the point.

Imports are **idempotent**: a question whose `ref` already exists in that
tenant is skipped, and every tree node is matched by name under its parent. Add
questions to a pack and re-import to insert only the new ones.

This is the sibling of `seed-data/<grade>/<Subject>.json`, which
`npm run db:seed:questions` reads. That format is flat (subject → module →
chapter) and predates sections and concepts; this one exists because the
question bank filters at all five levels and a realistic tenant needs all five
populated.

## File shape

```jsonc
{
  "id": "physics-11-mechanics",        // must be unique; stored on each question
  "label": "Physics 11 — Mechanics",   // what the studio dropdown shows
  "description": "…",
  "subject": { "name": "Physics", "gradeLevel": "11", "code": "PHY11" },
  "modules": [
    { "name": "Mechanics", "chapters": [
      { "name": "Motion in a Straight Line", "sections": [
        { "name": "Uniformly Accelerated Motion", "concepts": [
          { "name": "Equations of Motion", "questions": [ /* … */ ] }
        ]}
      ]}
    ]}
  ]
}
```

## Question fields

| Field | Required | Notes |
|---|---|---|
| `ref` | ✅ | Stable unique id, e.g. `phy11-kin-01`. Idempotency key. |
| `type` | ✅ | `subjective` `numerical` `integer` `mcq_single` `mcq_multiple` `assertion_reason` `fill_blanks` `match`. |
| `difficulty` | ✅ | `easy` `medium` `hard`. |
| `body` | ✅ | The question as the student sees it. |
| `marks` | — | Default `5`. Integer — the grader floors partial awards. |
| `negativeMarks` | — | Default `0`. |
| `explanation` | — | Shown in the solution view. |
| `tags` | — | String array. |
| `answerSheets` | — | Subjective only. See below. |

Type-specific fields (`options`, `answer`, `assertion`, `reason`, `blanks`,
`match`, `decimalPlaces`, `tolerance`, `wordLimit`) follow the same convention
as `seed-data/README.md`. `subjective` differs in one way: instead of `answer`
it takes **`sampleAnswer`** and **`rubric`**, both optional, both stored in
`answerKey`. Write the rubric as step marks — it is what makes an AI-graded
numerical reviewable by a human afterwards.

## `answerSheets` — the field that makes evaluation mean something

The AI evaluator reads a **photograph** of handwritten working; it never sees
typed text. So a subjective question can only be graded meaningfully if the
image submitted for it actually answers *that* question.

`answerSheets` records which real answer sheets do:

```jsonc
"answerSheets": [
  { "file": "test_image1.jpeg", "quality": "correct", "note": "Boxed a = 8.10." },
  { "file": "testImage5.jpeg",  "quality": "partial", "note": "No substitution shown." },
  { "file": "testImage3.jpeg",  "quality": "wrong",   "note": "Incoherent." }
]
```

`file` names an image in `AI_Engines/Data` (override the folder with
`SEED_STUDIO_SHEETS_DIR`). The studio hands student *n* the sheet at index
`n % sheets.length`, so a question with correct/partial/wrong sheets produces a
real spread of marks across the class instead of one number repeated.

A subjective question with no `answerSheets` still submits — it gets the
default sheet chosen in the studio — but the score is noise, and the studio
labels it as such. Pair a question with a sheet before drawing conclusions
about the evaluator from its marks.
