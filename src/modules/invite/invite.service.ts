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
import { dispatch } from '@modules/notification/index.js'
import { appUrl } from '../../shared/urls.js'

const resend = new Resend(env.RESEND_API_KEY)

const INVITE_TTL_HOURS = 48

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function inviteAcceptUrl(token: string): string {
  return appUrl(`/accept-invite?token=${token}`)
}

// Minimal HTML escaping — tenant names are owner-supplied free text and land
// inside the email body, so they must never be interpolated raw.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inviteEmailHtml(tenantName: string, url: string): string {
  const name = esc(tenantName)
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FBFCFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;padding:40px;border:1px solid #E5E8F0;max-width:600px">
        <tr><td>
          <p style="margin:0 0 28px;font-size:20px;font-weight:700;color:#0B1020;letter-spacing:-0.01em">Gyanverse</p>
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#2B50F5;letter-spacing:0.08em;text-transform:uppercase">Teacher invitation</p>
          <p style="margin:0 0 16px;font-size:24px;font-weight:700;color:#0B1020;line-height:1.3">
            You've been invited to join ${name}
          </p>
          <p style="margin:0 0 8px;font-size:16px;color:#3A4257;line-height:1.6">
            ${name} has invited you to join their coaching on Gyanverse as a <strong>teacher</strong>.
            Accept below to set up your account and get access.
          </p>
          <p style="margin:28px 0">
            <a href="${url}" style="background:#2B50F5;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Accept invitation</a>
          </p>
          <p style="margin:0 0 4px;font-size:13px;color:#8A93A8">Or paste this link into your browser:</p>
          <p style="margin:0;font-size:13px;word-break:break-all"><a href="${url}" style="color:#2B50F5">${url}</a></p>
          <hr style="border:none;border-top:1px solid #E5E8F0;margin:32px 0">
          <p style="margin:0;font-size:13px;color:#8A93A8;line-height:1.6">
            This invitation expires in ${INVITE_TTL_HOURS} hours. If you weren't expecting it, you can safely ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
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
    html: inviteEmailHtml(tenantName, url),
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

  // Best-effort in-app notification if the invitee already has an account
  void db
    .select({ id: users.id })
    .from(users)
    .where(contactType === 'email' ? eq(users.email, contact) : eq(users.phoneNumber, contact))
    .limit(1)
    .then(([invitee]) => {
      if (!invitee) return
      return dispatch({
        type: 'invite_received',
        recipients: { userIds: [invitee.id] },
        tenantId,
        data: {
          title: `You've been invited to join ${tenant.name}`,
          body: `You have a pending invitation to join ${tenant.name} as a teacher on Gyanverse.`,
          link: url,
          metadata: { coachingName: tenant.name },
        },
      })
    })

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
    .select({ name: users.name, email: users.email, phoneNumber: users.phoneNumber })
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

  void dispatch({
    type: 'invite_accepted',
    recipients: { userIds: [invite.invitedBy] },
    tenantId: invite.tenantId,
    data: {
      title: 'Invite accepted',
      body: `${user.name} accepted your teacher invite for ${tenant?.name ?? 'your coaching'}.`,
      link: `/coaching/teachers`,
      metadata: { memberName: user.name },
    },
  })

  return { success: true, role: 'teacher', tenant }
}

// ── Public (unauthenticated) invite preview ─────────────────────────────────

export type InvitePreviewState = 'pending' | 'accepted' | 'revoked' | 'expired' | 'not_found'

export interface InvitePreview {
  state: InvitePreviewState
  coachingName: string | null
  coachingSlug: string | null
  role: string | null
  contactType: 'email' | 'phone' | null
  /** Partially masked so a leaked link doesn't hand over the full address. */
  contactMasked: string | null
  expiresAt: string | null
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@')
  const head = local.slice(0, 2)
  const masked = local.length <= 2 ? `${head}•••` : `${head}${'•'.repeat(Math.min(local.length - 2, 6))}`
  return domain ? `${masked}@${domain}` : masked
}

function maskPhone(value: string): string {
  const tail = value.slice(-4)
  return `${'•'.repeat(Math.max(value.length - 4, 3))}${tail}`
}

/**
 * Resolves an invite token for the accept-invite landing page, which runs before
 * the invitee has a session. Returns only what the page needs to explain itself
 * — never the raw contact, the tenant id, or who sent it.
 */
export async function getInvitePreview(token: string): Promise<InvitePreview> {
  const empty: InvitePreview = {
    state: 'not_found',
    coachingName: null,
    coachingSlug: null,
    role: null,
    contactType: null,
    contactMasked: null,
    expiresAt: null,
  }

  if (!token) return empty

  const [row] = await db
    .select({
      contact: invites.contact,
      contactType: invites.contactType,
      role: invites.role,
      status: invites.status,
      expiresAt: invites.expiresAt,
      coachingName: tenants.name,
      coachingSlug: tenants.slug,
    })
    .from(invites)
    .innerJoin(tenants, eq(tenants.id, invites.tenantId))
    .where(eq(invites.token, token))
    .limit(1)

  if (!row) return empty

  const contactType = row.contactType === 'phone' ? 'phone' : 'email'
  const state: InvitePreviewState =
    row.status === 'accepted' ? 'accepted'
      : row.status === 'revoked' ? 'revoked'
      : new Date() > row.expiresAt ? 'expired'
      : 'pending'

  return {
    state,
    coachingName: row.coachingName,
    coachingSlug: row.coachingSlug,
    role: row.role,
    contactType,
    contactMasked: contactType === 'email' ? maskEmail(row.contact) : maskPhone(row.contact),
    expiresAt: row.expiresAt.toISOString(),
  }
}
