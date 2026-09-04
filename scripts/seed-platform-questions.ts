import { createInterface } from 'node:readline/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as dotenv from 'dotenv'
import { Pool } from 'pg'

// Deliberately NOT importing `src/config/env.js` / `src/shared/db.js` — same
// reasoning as ops-promote.ts. This script's whole purpose is loading the
// Gyaanverse platform content pool (`tenant_id IS NULL`) into PRODUCTION, so it
// must not hard-exit on NODE_ENV=production the way `seed-questions.ts` does,
// and it must not depend on every runtime secret (Resend, Razorpay, …) being
// configured locally. Point it at production by exporting DATABASE_URL to the
// Railway public proxy URl before running — dotenv.config() below never
// overrides an already-set env var.
dotenv.config()

// ─────────────────────────────────────────────────────────────────────────────
// Imports platform (tenant_id = NULL) questions from
// scripts/seed-data/platform/<grade>/<Subject>.json — same file shape as the
// tenant seed script's data files, but every hierarchy row and every question
// is written with tenant_id = NULL, so it is visible to every coaching
// (see docs/api/question-bank-content-contract.md §1.1).
//
//   DATABASE_URL=<public-proxy-url> npm run db:seed:platform
//   DATABASE_URL=<public-proxy-url> npm run db:seed:platform -- --yes
//   DATABASE_URL=<public-proxy-url> npm run db:seed:platform -- 9 Physics
//
// Idempotent: a question whose `ref` already exists among tenant_id IS NULL
// rows (stored in metadata.ref) is skipped, so a file can be re-run after
// appending more questions without creating duplicates.
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('\n  ERROR: DATABASE_URL is not set (checked the environment and backend/.env).\n')
  process.exit(1)
}

interface AuthoredQuestion {
  ref: string
  chapter: string
  module?: string
  section?: string | null
  concept?: string | null
  type: string
  difficulty: 'easy' | 'medium' | 'hard'
  body: string
  payload: Record<string, unknown>
  answerKey: Record<string, unknown>
  marks?: number
  negativeMarks?: number
  explanation?: string
  tags?: string[]
  source?: Record<string, unknown>
  metadata?: Record<string, unknown>
}
interface DataFile {
  grade: string
  subject: string
  language?: string
  questions: AuthoredQuestion[]
}

const argv = process.argv.slice(2)
const assumeYes = argv.includes('--yes') || argv.includes('-y')
const positional = argv.filter((a) => !a.startsWith('-'))
const [gradeFilter, subjectFilter] = positional

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = join(here, 'seed-data', 'platform')
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

const pool = new Pool({ connectionString: DATABASE_URL })
const dbUrl = new URL(DATABASE_URL)
const target = `${dbUrl.hostname}:${dbUrl.port || '5432'}${dbUrl.pathname}`

const subjectCache = new Map<string, string>()
const moduleCache = new Map<string, string>()
const chapterCache = new Map<string, string>()
const created = { subjects: 0, modules: 0, chapters: 0, questions: 0 }
let skipped = 0
let failed = 0
const errors: { ref: string; error: string }[] = []

async function getSubject(name: string, grade: string): Promise<string> {
  const key = `${grade}::${name}`
  if (subjectCache.has(key)) return subjectCache.get(key)!
  const { rows } = await pool.query<{ id: string }>(
    `select id from subjects where tenant_id is null and name = $1 and grade_level = $2`,
    [name, grade],
  )
  let id = rows[0]?.id
  if (!id) {
    const { rows: inserted } = await pool.query<{ id: string }>(
      `insert into subjects (tenant_id, name, grade_level) values (null, $1, $2) returning id`,
      [name, grade],
    )
    id = inserted[0].id
    created.subjects++
  }
  subjectCache.set(key, id)
  return id
}

async function getModule(subjectId: string, name: string): Promise<string> {
  const key = `${subjectId}::${name}`
  if (moduleCache.has(key)) return moduleCache.get(key)!
  const { rows } = await pool.query<{ id: string }>(
    `select id from modules where subject_id = $1 and name = $2`,
    [subjectId, name],
  )
  let id = rows[0]?.id
  if (!id) {
    const { rows: inserted } = await pool.query<{ id: string }>(
      `insert into modules (subject_id, tenant_id, name, "order") values ($1, null, $2, 0) returning id`,
      [subjectId, name],
    )
    id = inserted[0].id
    created.modules++
  }
  moduleCache.set(key, id)
  return id
}

async function getChapter(moduleId: string, name: string): Promise<string> {
  const key = `${moduleId}::${name}`
  if (chapterCache.has(key)) return chapterCache.get(key)!
  const { rows } = await pool.query<{ id: string }>(
    `select id from chapters where module_id = $1 and name = $2`,
    [moduleId, name],
  )
  let id = rows[0]?.id
  if (!id) {
    const { rows: inserted } = await pool.query<{ id: string }>(
      `insert into chapters (module_id, tenant_id, name, "order") values ($1, null, $2, 0) returning id`,
      [moduleId, name],
    )
    id = inserted[0].id
    created.chapters++
  }
  chapterCache.set(key, id)
  return id
}

async function main(): Promise<void> {
  const files = collectFiles()
  const totalQuestions = files.reduce((n, f) => {
    const d = JSON.parse(readFileSync(f, 'utf8')) as DataFile
    return n + d.questions.length
  }, 0)

  console.log(`\n  Target database: ${target}`)
  console.log(`  Found ${files.length} platform data file(s), ${totalQuestions} question(s) total${gradeFilter ? ` (filter: grade ${gradeFilter}${subjectFilter ? ` / ${subjectFilter}` : ''})` : ''}`)
  console.log('  Writing with tenant_id = NULL — visible to every coaching.\n')

  if (!assumeYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('  Type "yes" to continue: ')
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('\n  Aborted. Nothing was written.\n')
      process.exitCode = 1
      return
    }
  }

  for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as DataFile
    if (gradeFilter && data.grade !== gradeFilter) continue
    if (subjectFilter && data.subject.toLowerCase() !== subjectFilter.toLowerCase()) continue

    let fileCreated = 0
    let fileSkipped = 0
    for (const q of data.questions) {
      try {
        const { rows: dup } = await pool.query(
          `select id from question_bank where tenant_id is null and metadata->>'ref' = $1`,
          [q.ref],
        )
        if (dup.length) { skipped++; fileSkipped++; continue }

        const subjectId = await getSubject(data.subject, data.grade)
        const moduleId = await getModule(subjectId, q.module ?? `Core ${data.subject}`)
        const chapterId = await getChapter(moduleId, q.chapter)

        await pool.query(
          `insert into question_bank (
             tenant_id, subject_id, module_id, chapter_id,
             type, difficulty, body, payload, answer_key,
             default_marks, default_negative_marks,
             explanation, tags, language, source,
             is_verified, status, metadata
           ) values (
             null, $1, $2, $3,
             $4, $5, $6, $7, $8,
             $9, $10,
             $11, $12, $13, $14,
             true, 'active', $15
           )`,
          [
            subjectId, moduleId, chapterId,
            q.type, q.difficulty, q.body, JSON.stringify(q.payload), JSON.stringify(q.answerKey),
            q.marks ?? 4, q.negativeMarks ?? 0,
            q.explanation ?? null, q.tags ?? null, data.language ?? 'en', q.source ? JSON.stringify(q.source) : null,
            JSON.stringify({ ...q.metadata, ref: q.ref }),
          ],
        )
        created.questions++
        fileCreated++
      } catch (err) {
        failed++
        errors.push({ ref: q.ref, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const rel = file.slice(dataRoot.length + 1)
    console.log(`  ${rel.padEnd(28)} grade ${data.grade} ${data.subject.padEnd(10)} ${fileCreated} created, ${fileSkipped} skipped`)
  }

  const divider = '─'.repeat(50)
  console.log(`\n${divider}`)
  console.log('  Platform question import summary')
  console.log(divider)
  console.log(`  subjects   ${created.subjects} created`)
  console.log(`  modules    ${created.modules} created`)
  console.log(`  chapters   ${created.chapters} created`)
  console.log(`  questions  ${created.questions} created, ${skipped} skipped (already imported), ${failed} failed`)
  if (errors.length) {
    console.log('\n  Errors:')
    for (const e of errors) console.log(`    ${e.ref}: ${e.error}`)
  }
  console.log(divider + '\n')
}

try {
  await main()
} catch (err) {
  console.error('\n  ERROR:', err instanceof Error ? err.message : err, '\n')
  process.exitCode = 1
} finally {
  await pool.end()
}
