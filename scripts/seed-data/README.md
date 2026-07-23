# Question seed data

Authored questions live in **one file per grade-subject**:

```
seed-data/
  9/
    Physics.json
    Maths.json   …
  10/
    …
```

Each file carries a `grade` + `subject` header; its `questions` only name their
`chapter`. The importer (`npm run db:seed:questions`) reads every file, creates
any missing `subject → module → chapter` rows for the **dev** tenant, and inserts
each question into `question_bank` as an `active`, verified row (so the
test-engine generator can draw from it).

```bash
npm run db:seed:questions               # import everything
npm run db:seed:questions -- 9          # only grade 9
npm run db:seed:questions -- 9 Physics  # only grade 9 Physics
```

**Workflow:** you paste raw questions in chat → I convert each into an entry in
the right grade-subject file → run the import. It's idempotent (keyed on `ref`),
so re-running after appending only inserts the new ones.

> Requires `npm run db:seed` to have run once (it creates the `dev` tenant).

## File header

| Field | Required | Notes |
|---|---|---|
| `grade` | ✅ | `"9"` / `"10"` → `subjects.gradeLevel`. |
| `subject` | ✅ | e.g. `"Physics"`. Subject is keyed by `grade + name`. |
| `questions` | ✅ | Array of question objects (below). |

## Question fields

| Field | Required | Notes |
|---|---|---|
| `ref` | ✅ | Unique stable id, e.g. `9-phy-flm-1`. Used to skip re-imports. |
| `chapter` | ✅ | e.g. `"Force and Laws of Motion"`. |
| `module` | — | Defaults to `Core <subject>`. |
| `type` | ✅ | `mcq_single` `mcq_multiple` `integer` `numerical` `subjective` `assertion_reason` `fill_blanks` `match`. |
| `difficulty` | ✅ | `easy` `medium` `hard`. |
| `body` | ✅ | Question stem. |
| `marks` | — | Default `4`. Integer. |
| `negativeMarks` | — | Default `0`. Integer. |
| `explanation` | — | Solution text. |
| `tags` | — | String array. Questions whose answer looks doubtful are tagged `needs-review`. |
| `source` | — | `original` `textbook` `pyq`. |

### `answer` by type

| `type` | extra fields | `answer` value |
|---|---|---|
| `mcq_single` | `options: [{id,text}]` | the correct `id`, e.g. `"b"` |
| `mcq_multiple` | `options` | array of ids, e.g. `["a","c"]` |
| `integer` | — | a number, e.g. `6` |
| `numerical` | `decimalPlaces?`, `tolerance?` | a number |
| `subjective` | `wordLimit?` | sample answer string |
| `assertion_reason` | `assertion`, `reason` | `"A"`..`"E"` |
| `fill_blanks` | `blanks` | array of strings |
| `match` | `match: {left,right}` | array of `{leftId,rightId}` |
