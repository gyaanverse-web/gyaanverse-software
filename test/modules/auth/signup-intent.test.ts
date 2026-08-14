import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { auth } from '@config/auth.js'
import { users } from '@modules/auth/auth.schema.js'

// `signupIntent` is the only role-shaped field a client may write, so what it
// accepts is worth pinning down. It grants nothing — every permission is
// authorised off the `memberships` row by requireTenantRole — but a value
// outside the whitelist would leak into routing decisions and, via
// resolveDisplayRole, into which navigation a user is shown.
//
// These go through Better Auth's real sign-up handler rather than the fixture
// factories, because the whitelist lives in the field's `transform.input` and
// the fixtures insert into the table directly, bypassing it entirely.

let _n = 0
const freshEmail = () => `intent-${Date.now()}-${_n++}@example.com`

async function signUp(extra: Record<string, unknown>) {
  const email = freshEmail()
  await auth.api.signUpEmail({
    body: { name: 'Test Person', email, password: 'password1234', ...extra },
  })
  const [row] = await db
    .select({ signupIntent: users.signupIntent, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row
}

describe('signupIntent on sign-up', () => {
  it('records a coaching owner who asked to be one', async () => {
    const row = await signUp({ signupIntent: 'coaching_owner' })
    expect(row.signupIntent).toBe('coaching_owner')
  })

  it('records a student who asked to be one', async () => {
    const row = await signUp({ signupIntent: 'student' })
    expect(row.signupIntent).toBe('student')
  })

  it('defaults to student when the field is omitted', async () => {
    // The phone-OTP flow and any older client send nothing at all.
    const row = await signUp({})
    expect(row.signupIntent).toBe('student')
  })

  it('CRITICAL: coerces an unrecognised value to student rather than storing it', async () => {
    // Better Auth maps an array `type` to z.any(), so an enum on the field
    // would NOT validate — the transform is the only thing standing here.
    for (const hostile of ['super_admin', 'teacher', 'COACHING_OWNER', '', 'null']) {
      const row = await signUp({ signupIntent: hostile })
      expect(row.signupIntent).toBe('student')
    }
  })

  it('coerces a non-string to student instead of writing a bad type', async () => {
    for (const hostile of [true, 42, null, { role: 'coaching_owner' }, ['coaching_owner']]) {
      const row = await signUp({ signupIntent: hostile })
      expect(row.signupIntent).toBe('student')
    }
  })

  it('CRITICAL: intent never becomes the account role', async () => {
    // The whole point of the split. Owning a coaching is earned by creating
    // one (registerCoaching); asking for it at signup must grant nothing.
    const row = await signUp({ signupIntent: 'coaching_owner' })
    expect(row.role).toBe('student')
  })

  it('CRITICAL: ignores a direct attempt to set the account role', async () => {
    // `role` is input: false, so the submitted value is dropped. Note it is
    // dropped SILENTLY, not rejected: Better Auth only raises FIELD_NOT_ALLOWED
    // for an input:false field with no defaultValue, and `role` has one, so it
    // is overwritten with the default instead (dist/db/schema.mjs). Either way
    // the caller gains nothing — which is the guarantee that matters, and the
    // one adding a writable intent field must not have loosened.
    const row = await signUp({ role: 'coaching_owner', signupIntent: 'coaching_owner' })
    expect(row.role).toBe('student')
    expect(row.signupIntent).toBe('coaching_owner')
  })

  it('CRITICAL: refuses a direct attempt to set tenantId', async () => {
    // `tenantId` is input: false with NO defaultValue, so this is the branch
    // that really does reject. Being able to set it at signup would place an
    // account inside someone else's coaching, so it must never become writable.
    await expect(
      signUp({ tenantId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow()
  })
})
