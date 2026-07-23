import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger'

export const swaggerConfig: FastifyDynamicSwaggerOptions = {
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

| Role | Who |
|------|-----|
| \`coaching_owner\` | Owner of a coaching institute |
| \`teacher\` | Teacher within a coaching |
| \`student\` | Student enrolled in a coaching |
| \`super_admin\` | Platform administrator |
      `.trim(),
      version: '1.0.0',
    },
    servers: [
      {
        url: 'http://localhost:8000',
        description: 'Local development',
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
}
