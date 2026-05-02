import { eq, and } from 'drizzle-orm'
import { Resend } from 'resend'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { env } from '../../config/env.js'
import { invites } from './invite.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { users } from '../auth/auth.schema.js'
import { tenants } from '../tenant/tenant.schema.js'
import { assertWithinLimit } from '../billing/billing.service.js'

const resend = new Resend(env.RESEND_API_KEY)

const INVITE_TTL_HOURS = 48

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function inviteAcceptUrl(token: string): string {
  const base =
    env.NODE_ENV !== 'production' ? env.FRONTEND_URL : `https://${env.APP_DOMAIN}`
  return `${base}/accept-invite?token=${token}`
}

async function sendInviteEmail(to: string, tenantName: string, url: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    const divider = '-'.repeat(72)
    console.log(
      `\n${divider}\n` +
        `TEACHER INVITE (dev - not sent)\n` +
        `To:       ${to}\n` +
        `Coaching: ${tenantName}\n` +
        `URL:      ${url}\n` +
        `${divider}\n`,
    )
    return
  }
  const { error } = await resend.emails.send({
    from: `Gyanverse <noreply@${env.APP_DOMAIN}>`,
    to,
    subject: `You've been invited to join ${tenantName} on Gyanverse`,
    html: `<p>You've been invited to join <strong>${tenantName}</strong> as a teacher on Gyanverse.</p><p><a href="${url}">Accept Invitation</a></p><p>This link expires in 48 hours. If you didn't expect this, ignore it.</p>`,
  })
  if (error) console.error('[Resend] Failed to send invite email:', error)
}

async function sendInvitePhone(phone: string, tenantName: string, url: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    const divider = '-'.repeat(72)
    console.log(
      `\n${divider}\n` +
        `TEACHER INVITE SMS (dev - not sent)\n` +
        `To:       ${phone}\n` +
        `Coaching: ${tenantName}\n` +
        `URL:      ${url}\n` +
        `${divider}\n`,
    )
    return
  }
  // TODO: configure MSG91 transactional SMS template for invites and implement delivery
  console.warn(`[Invite] SMS delivery not configured — token for ${phone} not sent`)
}

// ── Public service functions ────────────────────────────────────────────────

export async function createInvite(
  tenantId: string,
  invitedBy: string,
  contact: string,
  contactType: 'email' | 'phone',
) {
  const [existing] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.tenantId, tenantId),
        eq(invites.contact, contact),
        eq(invites.status, 'pending'),
      ),
    )
    .limit(1)

  if (existing) {
    throw new AppError('INVITE_EXISTS', 'A pending invite already exists for this contact', 409)
  }

  await assertWithinLimit(tenantId, 'teachers')

  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!tenant) throw Errors.NOT_FOUND('Tenant')

  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000)

  const [invite] = await db
    .insert(invites)
    .values({ tenantId, invitedBy, contact, contactType, role: 'teacher', token, expiresAt })
    .returning()

  const url = inviteAcceptUrl(token)
  if (contactType === 'email') {
    await sendInviteEmail(contact, tenant.name, url)
  } else {
    await sendInvitePhone(contact, tenant.name, url)
  }

  return invite
}

export async function listInvites(tenantId: string, status?: string) {
  const condition = status
    ? and(eq(invites.tenantId, tenantId), eq(invites.status, status))
    : eq(invites.tenantId, tenantId)

  return db
    .select({
      id: invites.id,
      contact: invites.contact,
      contactType: invites.contactType,
      role: invites.role,
      status: invites.status,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .where(condition)
    .orderBy(invites.createdAt)
}

export async function revokeInvite(tenantId: string, inviteId: string) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.tenantId, tenantId)))
    .limit(1)

  if (!invite) throw Errors.NOT_FOUND('Invite')
  if (invite.status !== 'pending') {
    throw new AppError('INVITE_NOT_PENDING', 'Only pending invites can be revoked', 400)
  }

  await db.update(invites).set({ status: 'revoked' }).where(eq(invites.id, inviteId))
  return { success: true }
}

export async function acceptInvite(userId: string, token: string) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1)

  if (!invite) throw Errors.NOT_FOUND('Invite')

  if (invite.status !== 'pending') {
    throw new AppError('INVITE_ALREADY_USED', 'This invite has already been used or revoked', 400)
  }
  if (new Date() > invite.expiresAt) {
    throw new AppError('INVITE_EXPIRED', 'This invite link has expired', 400)
  }

  const [user] = await db
    .select({ email: users.email, phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) throw Errors.NOT_FOUND('User')

  const userContact = invite.contactType === 'email' ? user.email : user.phoneNumber
  if (userContact !== invite.contact) {
    throw new AppError('INVITE_CONTACT_MISMATCH', 'This invite was not issued to your account', 403)
  }

  const [existingMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, invite.tenantId)))
    .limit(1)

  if (existingMembership) {
    throw new AppError('ALREADY_MEMBER', 'You are already a member of this coaching', 409)
  }

  await assertWithinLimit(invite.tenantId, 'teachers')

  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ userId, tenantId: invite.tenantId, role: 'teacher' })
    await tx.update(users).set({ role: 'teacher', tenantId: invite.tenantId }).where(eq(users.id, userId))
    await tx.update(invites).set({ status: 'accepted' }).where(eq(invites.id, invite.id))
  })

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, invite.tenantId))
    .limit(1)

  return { success: true, role: 'teacher', tenant }
}
