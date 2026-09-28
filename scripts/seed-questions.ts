import '../src/config/env.js'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { db } from '../src/shared/db.js'
import { eq, and, sql } from 'drizzle-orm'
import { tenants } from '../src/modules/tenant/tenant.schema.js'
import {
  subjects, modules, chapters, questionBank,
} from '../src/modules/question-bank/question-bank.schema.js'
import type { QuestionType } from '../src/modules/exam/exam.types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Imports authored questions from scripts/seed-data/<grade>/<Subject>.json into
// the question_bank, creating any missing subject → module → chapter rows.
//
// Each data file carries its own `grade` + `subject` header, so questions only
// need to name their `chapter`. One file per grade-subject keeps the content
// browsable and lets you import a single subject at a time.
//
//   npm run db:seed:questions                        # import every data file
//   npm run db:seed:questions -- 9                   # only grade 9
//   npm run db:seed:questions -- 9 Physics           # only grade 9 Physics
//   npm run db:seed:questions -- --tenant niaz       # into a coaching you made
//
// Idempotent: a question whose `ref` already exists (stored in metadata.ref) is
// skipped, so you can keep appending and re-run safely.
//
// The question bank is tenant-scoped, so questions imported into `dev` are
// invisible from any other coaching — that is the isolation working, not a bug.
// If you signed up through the UI you are in your OWN coaching, and the default
// import lands somewhere you will never see. Pass --tenant <your-slug> for that.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  console.error('\n  ERROR: seed script is not allowed in production.\n')
  process.exit(1)
}

const DEFAULT_TENANT_SLUG = 'dev'

// ── Authoring shapes ─────────────────────────────────────────────────────────
interface AuthoredOption { id: string; text: string; imageUrl?: string }
interface AuthoredQuestion {
  ref: string                       // stable unique id for idempotency
  chapter: string                   // e.g. 'Force and Laws of Motion'
  module?: string                   // defaults to `Core <subject>`
  type: QuestionType
  difficulty: 'easy' | 'medium' | 'hard'
  body: string
  options?: AuthoredOption[]        // mcq_single / mcq_multiple
  answer: unknown                   // shape depends on type (see buildAnswer)
  assertion?: string               // assertion_reason
  reason?: string                  // assertion_reason
  match?: { left: AuthoredOption[]; right: AuthoredOption[] } // match
  blanks?: number                  // fill_blanks
  decimalPlaces?: number           // numerical
  tolerance?: number               // numerical
  wordLimit?: number               // subjective
  marks?: number
  negativeMarks?: number
  explanation?: string
  tags?: string[]
  language?: string
  source?: 'original' | 'textbook' | 'pyq'
}
interface DataFile {
  grade: string                     // '9' | '10' → subjects.gradeLevel
  subject: string                   // e.g. 'Physics'
  questions: AuthoredQuestion[]
}

// ── Per-type payload + answerKey builders ────────────────────────────────────
function buildPayloadAndAnswer(q: AuthoredQuestion): {
  payload: Record<string, unknown>
  answerKey: Record<string, unknown>
} {
  switch (q.type) {
    case 'mcq_single':
      return { payload: { options: q.options ?? [] }, answerKey: { optionId: q.answer } }
    case 'mcq_multiple':
      return { payload: { options: q.options ?? [] }, answerKey: { optionIds: q.answer } }
    case 'integer':
      return { payload: {}, answerKey: { value: q.answer } }
    case 'numerical':
      return {
        payload: q.decimalPlaces != null ? { decimalPlaces: q.decimalPlaces } : {},
        answerKey: q.tolerance != null ? { value: q.answer, tolerance: q.tolerance } : { value: q.answer },
      }
    case 'subjective':
      return {
        payload: q.wordLimit != null ? { wordLimit: q.wordLimit } : {},
        answerKey: { sampleAnswer: q.answer },
      }
    case 'assertion_reason':
      return {
        payload: { assertion: q.assertion ?? '', reason: q.reason ?? '' },
        answerKey: { option: q.answer },
      }
    case 'fill_blanks':
      return { payload: { blanks: q.blanks ?? 1 }, answerKey: { answers: q.answer } }
    case 'match':
      return {
        payload: { left: q.match?.left ?? [], right: q.match?.right ?? [] },
        answerKey: { pairs: q.answer },
      }
    default:
      throw new Error(`Unsupported question type: ${q.type as string}`)
  }
}

// ── Hierarchy upserts (scoped to the dev tenant) ─────────────────────────────
const subjectCache = new Map<string, string>()
const moduleCache = new Map<string, string>()
const chapterCache = new Map<string, string>()

async function getSubject(tenantId: string, name: string, grade: string): Promise<string> {
  const key = `${grade}::${name}`
  if (subjectCache.has(key)) return subjectCache.get(key)!
  const [existing] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(and(eq(subjects.tenantId, tenantId), eq(subjects.name, name), eq(subjects.gradeLevel, grade)))
  let id = existing?.id
  if (!id) {
    id = crypto.randomUUID()
    await db.insert(subjects).values({ id, tenantId, name, gradeLevel: grade })
    created.subjects++
  }
  subjectCache.set(key, id)
  return id
}

async function getModule(tenantId: string, subjectId: string, name: string): Promise<string> {
  const key = `${subjectId}::${name}`
  if (moduleCache.has(key)) return moduleCache.get(key)!
  const [existing] = await db
    .select({ id: modules.id })
    .from(modules)
    .where(and(eq(modules.subjectId, subjectId), eq(modules.name, name)))
  let id = existing?.id
  if (!id) {
    id = crypto.randomUUID()
    await db.insert(modules).values({ id, tenantId, subjectId, name, order: 0 })
    created.modules++
  }
  moduleCache.set(key, id)
  return id
}

async function getChapter(tenantId: string, moduleId: string, name: string): Promise<string> {
  const key = `${moduleId}::${name}`
  if (chapterCache.has(key)) return chapterCache.get(key)!
  const [existing] = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.moduleId, moduleId), eq(chapters.name, name)))
  let id = existing?.id
  if (!id) {
    id = crypto.randomUUID()
    await db.insert(chapters).values({ id, tenantId, moduleId, name, order: 0 })
    created.chapters++
  }
  chapterCache.set(key, id)
  return id
}

// ── Collect data files (seed-data/<grade>/<Subject>.json) ────────────────────
const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = join(here, 'seed-data')

/**
 * A grade folder is named for its grade — `seed-data/9/`, `seed-data/11/`.
 *
 * Matched positively rather than blocklisting the folders that are not grades,
 * because `seed-data/` is shared. `seed-data/packs/` holds Seed Studio content
 * packs, which are a different format entirely (a five-level
 * subject → module → chapter → section → concept tree) read by
 * `scripts/seed-studio.ts`. This script used to walk into it, parse a pack as a
 * flat DataFile, and die on `data.questions is not iterable` — after having
 * already imported the real files, so the run looked like a mid-import
 * corruption rather than a script reading someone else's data.
 *
 * Anything else that lands in here later — `_templates/`, `archive/`, a stray
 * `node_modules` — is excluded by the same rule without another edit.
 */
const isGradeFolder = (name: string) => /^\d{1,2}$/.test(name)

function collectFiles(): string[] {
  const out: string[] = []
  for (const gradeDir of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!gradeDir.isDirectory() || !isGradeFolder(gradeDir.name)) continue
    const dir = join(dataRoot, gradeDir.name)
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.json')) out.push(join(dir, f.name))
    }
  }
  return out
}

/**
 * Second net, for a file that IS in a grade folder but is not a data file.
 *
 * The folder rule above stops this script reading another tool's data; this
 * stops a typo in a hand-authored file presenting as a `TypeError` from deep in
 * the import loop. Named as a fatal error rather than a skip on purpose: a
 * malformed subject file means questions you believe you imported are silently
 * absent, which is discovered much later and much more expensively than a
 * failed seed.
 */
function assertDataFile(data: unknown, file: string): asserts data is DataFile {
  const d = data as Partial<DataFile>
  const problem =
    typeof d?.grade !== 'string' ? `"grade" must be a string, got ${JSON.stringify(d?.grade)}`
    : typeof d?.subject !== 'string' ? `"subject" must be a string, got ${JSON.stringify(d?.subject)}`
    : !Array.isArray(d?.questions) ? `"questions" must be an array, got ${JSON.stringify(d?.questions)}`
    : null

  if (problem) {
    console.error(`\n  ERROR: ${file} is not a question data file.`)
    console.error(`  ${problem}`)
    console.error('\n  Expected shape: { "grade": "9", "subject": "Physics", "questions": [ ... ] }')
    console.error('  (Seed Studio content packs are a different format and belong in seed-data/packs/.)\n')
    process.exit(1)
  }
}

// CLI: `-- [--tenant <slug>] [<grade> [<subject>]]`
// The flag is lifted out first so the grade/subject positions keep working
// regardless of where it appears.
const argv = process.argv.slice(2)
let tenantSlug = DEFAULT_TENANT_SLUG
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--tenant') {
    const next = argv[++i]
    if (!next) {
      console.error('\n  ERROR: --tenant needs a slug, e.g. --tenant niaz\n')
      process.exit(1)
    }
    tenantSlug = next
  } else if (a.startsWith('--tenant=')) {
    tenantSlug = a.slice('--tenant='.length)
  } else {
    positional.push(a)
  }
}
const [gradeFilter, subjectFilter] = positional

// ── Main ─────────────────────────────────────────────────────────────────────
const created = { subjects: 0, modules: 0, chapters: 0, questions: 0 }
let skipped = 0

const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, tenantSlug))
if (!tenant) {
  console.error(`\n  ERROR: tenant '${tenantSlug}' not found.`)
  // Listing them beats guessing: the slug you want is usually a coaching you
  // created in the UI, whose slug you never explicitly chose.
  const all = await db.select({ slug: tenants.slug, name: tenants.name }).from(tenants)
  if (all.length) {
    console.error('\n  Existing tenants:')
    for (const t of all) console.error(`    ${t.slug.padEnd(20)} ${t.name}`)
    console.error('\n  Pick one with --tenant <slug>.\n')
  } else {
    console.error('  No tenants exist at all. Run `npm run db:seed` first.\n')
  }
  process.exit(1)
}
const tenantId = tenant.id

const files = collectFiles()
console.log(`\nImporting into tenant '${tenantSlug}'`)
console.log(`Found ${files.length} data file(s)${gradeFilter ? ` (filter: grade ${gradeFilter}${subjectFilter ? ` / ${subjectFilter}` : ''})` : ''}\n`)

for (const file of files) {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  assertDataFile(data, file)
  if (gradeFilter && data.grade !== gradeFilter) continue
  if (subjectFilter && data.subject.toLowerCase() !== subjectFilter.toLowerCase()) continue

  let fileCreated = 0
  let fileSkipped = 0
  for (const q of data.questions) {
    const [dup] = await db
      .select({ id: questionBank.id })
      .from(questionBank)
      .where(and(eq(questionBank.tenantId, tenantId), sql`${questionBank.metadata}->>'ref' = ${q.ref}`))
    if (dup) { skipped++; fileSkipped++; continue }

    const subjectId = await getSubject(tenantId, data.subject, data.grade)
    const moduleId = await getModule(tenantId, subjectId, q.module ?? `Core ${data.subject}`)
    const chapterId = await getChapter(tenantId, moduleId, q.chapter)

    const { payload, answerKey } = buildPayloadAndAnswer(q)

    await db.insert(questionBank).values({
      id: crypto.randomUUID(),
      tenantId,
      subjectId,
      moduleId,
      chapterId,
      type: q.type,
      difficulty: q.difficulty,
      body: q.body,
      payload,
      answerKey,
      defaultMarks: q.marks ?? 4,
      defaultNegativeMarks: q.negativeMarks ?? 0,
      explanation: q.explanation ?? null,
      tags: q.tags ?? null,
      language: q.language ?? 'en',
      source: q.source ? { type: q.source } : null,
      isVerified: true,
      status: 'active',          // only 'active' rows enter exam generation
      metadata: { ref: q.ref },
    })
    created.questions++
    fileCreated++
  }
  const rel = file.slice(dataRoot.length + 1)
  console.log(`  ${rel.padEnd(22)} grade ${data.grade} ${data.subject.padEnd(10)} ${fileCreated} created, ${fileSkipped} skipped`)
}

const divider = '─'.repeat(50)
console.log(`\n${divider}`)
console.log('  Question import summary')
console.log(divider)
console.log(`  subjects   ${created.subjects} created`)
console.log(`  modules    ${created.modules} created`)
console.log(`  chapters   ${created.chapters} created`)
console.log(`  questions  ${created.questions} created, ${skipped} skipped (already imported)`)
console.log(divider + '\n')

process.exit(0)
