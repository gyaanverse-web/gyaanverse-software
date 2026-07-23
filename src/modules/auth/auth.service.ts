import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { users } from './auth.schema.js'

export async function getCurrentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw Errors.NOT_FOUND('User')
  return user
}

export const updateProfileSchema = z.object({
  name: z.string().min(2).max(255),
  email: z.string().email().optional(),
})

export async function updateProfile(
  userId: string,
  data: z.infer<typeof updateProfileSchema>,
) {
  if (data.email?.endsWith('@phone.gyanverse.app')) {
    throw Errors.VALIDATION('Invalid email address')
  }

  const updates: Partial<typeof users.$inferInsert> = {
    name: data.name,
    isProfileComplete: true,
    updatedAt: new Date(),
    // Reset verification so the new address must be confirmed
    ...(data.email ? { email: data.email, emailVerified: false } : {}),
  }

  const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning()
  if (!updated) throw Errors.NOT_FOUND('User')
  return updated
}
