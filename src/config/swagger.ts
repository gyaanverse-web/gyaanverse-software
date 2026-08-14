import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger'
import { env } from './env.js'

// A function, not a constant: the `servers` block below has to name the host the
// reader is actually talking to. Hard-coded `http://localhost:8000` meant every
// "Try it out" button in staging fired at the reader's own machine and failed
// with a connection error that looks exactly like the API being down.
//
// BETTER_AUTH_URL is the API's own public base URL by definition — better-auth
// builds its callback URLs from it — so it is the one variable that is already
// guaranteed correct per environment. No new variable needed for this.
export const swaggerConfig = (): FastifyDynamicSwaggerOptions => ({
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Gyanverse API',
      description: `
## Multi-tenant coaching platform API

Powers Gyanverse — a SaaS platform for coaching institutes.

### Authentication

Pass either:
- **Bearer token** → \`Authorization: Bearer <token>\` (returned by sign-in)
- **Session cookie** → set automatically on sign-in (works cross-subdomain)

Click **Authorize** (🔒) at the top of this page and paste your token there to test authenticated routes.

### Multi-tenancy

Routes prefixed with \`/tenant/\` require a tenant context resolved from:
- Subdomain in production: \`sharma.gyanverse.app\`
- Query param in development: \`?tenant=sharma\`

### Roles

There are two independent role layers. **Tenant roles** are per-coaching and
live in the \`memberships\` table (checked by \`requireTenantRole\`); the
**platform role** is a single value on the user account (checked by
\`requireRole\`). The same person can own one coaching and teach at another, so
never infer a tenant role from the platform role.

| Tenant role | Who |
|------|-----|
| \`coaching_owner\` | Owner of a coaching institute. The PRD calls this role "Admin" — it approves, schedules and runs exams (see the **Exam Review** tag). |
| \`teacher\` | Teacher within a coaching |
| \`student\` | Student enrolled in a coaching |

| Platform role | Who |
|------|-----|
| \`super_admin\` | Gyanverse platform operator, above all coachings. Currently used only for the global question-bank catalog — there is no super-admin portal. |
      `.trim(),
      version: '1.0.0',
    },
    servers: [
      {
        url: env.BETTER_AUTH_URL,
        description: env.NODE_ENV === 'production' ? 'This deployment' : 'Local development',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Session token returned by `/api/auth/sign-in/email` or `/api/auth/phone-number/verify`',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description: 'Session cookie set automatically on sign-in',
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Authentication, sessions, and profile management' },
      { name: 'Tenants', description: 'Coaching institute registration and management' },
      { name: 'Membership', description: 'Coaching-level join codes and student enrollment' },
      { name: 'Invites', description: 'Teacher invitation flow via email or SMS' },
      { name: 'Classes', description: 'Class CRUD, join codes, and student enrollment within a class' },
      { name: 'Exams', description: 'Exam authoring, subject/chapter catalog, and public discovery' },
      { name: 'Questions', description: 'Question management within exams' },
      { name: 'Exam Sessions', description: 'Student exam attempts, answer saving, and results' },
      { name: 'Billing', description: 'Plan info, usage limits, and invoice history' },
      { name: 'Payments', description: 'Exam purchase flow via Razorpay' },
      { name: 'Storage', description: 'Signed upload URLs for Cloudinary (answers, question images, branding)' },
      { name: 'Notifications', description: 'In-app notifications, SSE stream, and preferences' },
      { name: 'Evaluation', description: 'AI evaluation of subjective answers' },
      { name: 'Reports', description: 'Exam and student performance reports' },
    ],
  },
})
