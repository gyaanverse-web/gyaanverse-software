import PptxGenJS from 'pptxgenjs'

const pptx = new PptxGenJS()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'Gyanverse Engineering'
pptx.company = 'Gyanverse'
pptx.subject = 'Backend Architecture and Delivery Plan'
pptx.title = 'Gyanverse Backend Structure and Target Delivery Plan'
pptx.lang = 'en-US'
pptx.theme = {
  headFontFace: 'Calibri',
  bodyFontFace: 'Calibri',
  lang: 'en-US',
}

const palette = {
  navy: '0E1B3D',
  blue: '1F5EFF',
  teal: '0EA5A4',
  green: '16A34A',
  amber: 'F59E0B',
  red: 'DC2626',
  light: 'F6F8FC',
  dark: '111827',
  muted: '6B7280',
  white: 'FFFFFF',
}

const page = {
  marginX: 0.6,
  topBannerH: 0.9,
}

function addHeader(slide, title, subtitle = '') {
  slide.background = { color: palette.white }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: page.topBannerH,
    fill: { color: palette.navy },
    line: { color: palette.navy },
  })
  slide.addText(title, {
    x: page.marginX,
    y: 0.2,
    w: 8.6,
    h: 0.4,
    fontFace: 'Calibri',
    color: palette.white,
    bold: true,
    fontSize: 20,
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: page.marginX,
      y: 0.55,
      w: 9.8,
      h: 0.22,
      color: 'DDE5FF',
      fontSize: 11,
    })
  }
  slide.addText('Client Presentation', {
    x: 10.45,
    y: 0.33,
    w: 2.2,
    h: 0.3,
    align: 'right',
    color: 'DDE5FF',
    fontSize: 11,
    italic: true,
  })
}

function addFooter(slide, text = 'Gyanverse Backend Program') {
  slide.addShape(pptx.ShapeType.line, {
    x: page.marginX,
    y: 7.15,
    w: 12.1,
    h: 0,
    line: { color: 'D1D5DB', pt: 1 },
  })
  slide.addText(text, {
    x: page.marginX,
    y: 7.2,
    w: 12.1,
    h: 0.2,
    align: 'right',
    fontSize: 9,
    color: palette.muted,
  })
}

function addBullets(slide, items, x, y, w, h, size = 18) {
  const runs = items.map((item) => ({
    text: item,
    options: { bullet: { indent: 18 }, breakLine: true },
  }))
  slide.addText(runs, {
    x,
    y,
    w,
    h,
    fontSize: size,
    color: palette.dark,
    margin: 2,
    valign: 'top',
    paraSpaceAfterPt: 10,
  })
}

// Slide 1
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Gyanverse Backend Structure', 'How we are building today and how we will hit target outcomes')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.8,
    y: 1.4,
    w: 11.7,
    h: 4.5,
    fill: { color: palette.light },
    line: { color: 'DCE3F3', pt: 1 },
    radius: 0.08,
  })

  slide.addText('Architecture, Delivery Roadmap, Risk Controls, and KPI Targets', {
    x: 1.2,
    y: 2.2,
    w: 10.9,
    h: 1,
    fontSize: 30,
    bold: true,
    align: 'center',
    color: palette.navy,
  })

  slide.addText('Tech stack: Fastify + TypeScript + Drizzle + PostgreSQL + Redis + BullMQ', {
    x: 1.4,
    y: 3.5,
    w: 10.5,
    h: 0.5,
    align: 'center',
    fontSize: 15,
    color: palette.muted,
  })

  addFooter(slide, 'Prepared for client review | April 2026')
}

// Slide 2
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Agenda')
  addBullets(
    slide,
    [
      '1) Current backend structure and engineering approach',
      '2) Request lifecycle, security model, and tenancy strategy',
      '3) Database and infrastructure operating model',
      '4) Current maturity: strengths, open gaps, and risks',
      '5) 90-day target plan with milestones and measurable KPIs',
      '6) Client decisions and support needed to accelerate delivery',
    ],
    1.0,
    1.4,
    11.2,
    4.8,
    20,
  )
  addFooter(slide)
}

// Slide 3
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Current Backend Landscape')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.9,
    y: 1.35,
    w: 3.8,
    h: 4.9,
    fill: { color: 'EAF0FF' },
    line: { color: 'C8D8FF' },
    radius: 0.06,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 4.95,
    y: 1.35,
    w: 3.8,
    h: 4.9,
    fill: { color: 'EBFCFA' },
    line: { color: 'BBF2EC' },
    radius: 0.06,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.0,
    y: 1.35,
    w: 3.4,
    h: 4.9,
    fill: { color: 'F5F3FF' },
    line: { color: 'E7DEFF' },
    radius: 0.06,
  })

  slide.addText('Runtime Layer', { x: 1.2, y: 1.65, w: 3.2, h: 0.3, bold: true, color: palette.navy, fontSize: 16 })
  addBullets(slide, ['Fastify API server', 'Dedicated worker process', 'Environment-driven bootstrapping', 'Centralized error handling'], 1.15, 2.0, 3.3, 3.8, 14)

  slide.addText('Business Modules', { x: 5.25, y: 1.65, w: 3.2, h: 0.3, bold: true, color: palette.teal, fontSize: 16 })
  addBullets(slide, ['Auth, Tenant, Membership', 'Class, Exam, Evaluation', 'Invite, Billing, Payment', 'Admin, Analytics, Reports'], 5.2, 2.0, 3.3, 3.8, 14)

  slide.addText('Data + Infra', { x: 9.25, y: 1.65, w: 2.7, h: 0.3, bold: true, color: '5B21B6', fontSize: 16 })
  addBullets(slide, ['Drizzle ORM + SQL migrations', 'PostgreSQL as source of truth', 'Redis for queue/async', 'Dockerized local stack'], 9.2, 2.0, 2.9, 3.8, 14)

  addFooter(slide)
}

// Slide 4
{
  const slide = pptx.addSlide()
  addHeader(slide, 'How We Are Doing Things (Engineering Pattern)')

  slide.addShape(pptx.ShapeType.chevron, { x: 0.8, y: 2.3, w: 2.2, h: 1.5, fill: { color: 'DBEAFE' }, line: { color: 'BFDBFE' } })
  slide.addShape(pptx.ShapeType.chevron, { x: 3.0, y: 2.3, w: 2.2, h: 1.5, fill: { color: 'CFFAFE' }, line: { color: 'A5F3FC' } })
  slide.addShape(pptx.ShapeType.chevron, { x: 5.2, y: 2.3, w: 2.2, h: 1.5, fill: { color: 'DCFCE7' }, line: { color: 'BBF7D0' } })
  slide.addShape(pptx.ShapeType.chevron, { x: 7.4, y: 2.3, w: 2.2, h: 1.5, fill: { color: 'FEF3C7' }, line: { color: 'FDE68A' } })
  slide.addShape(pptx.ShapeType.chevron, { x: 9.6, y: 2.3, w: 2.6, h: 1.5, fill: { color: 'FEE2E2' }, line: { color: 'FECACA' } })

  slide.addText('Routes', { x: 1.35, y: 2.85, w: 1.1, h: 0.25, bold: true, align: 'center', fontSize: 14, color: palette.dark })
  slide.addText('Validation', { x: 3.5, y: 2.85, w: 1.2, h: 0.25, bold: true, align: 'center', fontSize: 14, color: palette.dark })
  slide.addText('Services', { x: 5.65, y: 2.85, w: 1.1, h: 0.25, bold: true, align: 'center', fontSize: 14, color: palette.dark })
  slide.addText('Data Access', { x: 7.75, y: 2.85, w: 1.4, h: 0.25, bold: true, align: 'center', fontSize: 14, color: palette.dark })
  slide.addText('Response + Errors', { x: 10.0, y: 2.85, w: 2.0, h: 0.25, bold: true, align: 'center', fontSize: 13, color: palette.dark })

  addBullets(
    slide,
    [
      'Each module follows the same pattern to reduce onboarding time and defects.',
      'Business logic stays in service layer, keeping endpoints thin and maintainable.',
      'Typed contracts (TypeScript + schema validation) improve reliability and speed.',
    ],
    0.95,
    4.35,
    11.9,
    2.2,
    15,
  )
  addFooter(slide)
}

// Slide 5
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Security and Multi-Tenant Control Model')

  slide.addShape(pptx.ShapeType.rect, {
    x: 1.0,
    y: 1.45,
    w: 11.2,
    h: 1.1,
    fill: { color: 'EFF6FF' },
    line: { color: 'BFDBFE' },
  })
  slide.addText('Identity and session management with role-aware access and tenant-aware routing', {
    x: 1.3,
    y: 1.85,
    w: 10.5,
    h: 0.5,
    fontSize: 15,
    bold: true,
    align: 'center',
    color: palette.navy,
  })

  addBullets(
    slide,
    [
      'Authentication: session-based with credential and OTP support.',
      'Authorization: global roles and tenant-level roles for scoped permissions.',
      'Tenant Resolution: subdomain-first approach with development fallback.',
      'Platform hardening: CORS, Helmet, cookies, and global rate-limiting.',
      'Error strategy: standardized app and validation error responses.',
    ],
    1.05,
    2.95,
    11.1,
    3.6,
    16,
  )
  addFooter(slide)
}

// Slide 6
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Data, Migrations, and Environment Strategy')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.85,
    y: 1.4,
    w: 5.9,
    h: 4.9,
    fill: { color: 'F8FAFC' },
    line: { color: 'E5E7EB' },
    radius: 0.05,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 6.85,
    y: 1.4,
    w: 5.6,
    h: 4.9,
    fill: { color: 'F0FDF4' },
    line: { color: 'BBF7D0' },
    radius: 0.05,
  })

  slide.addText('Current State', { x: 1.1, y: 1.75, w: 5.2, h: 0.3, fontSize: 16, bold: true, color: palette.dark })
  addBullets(
    slide,
    [
      'Typed ORM workflow with migration history under source control.',
      'PostgreSQL as transactional system of record.',
      'Redis-backed worker channel prepared for async flows.',
      'Config-driven runtime with strict environment checks.',
    ],
    1.05,
    2.1,
    5.4,
    3.8,
    14,
  )

  slide.addText('Target Enhancements', { x: 7.1, y: 1.75, w: 5.1, h: 0.3, fontSize: 16, bold: true, color: palette.green })
  addBullets(
    slide,
    [
      'Add migration guardrails to reduce deployment risk.',
      'Publish database index standards for high-traffic queries.',
      'Implement backup/restore drills and schema rollback runbooks.',
      'Expand queue usage for non-blocking background tasks.',
    ],
    7.05,
    2.1,
    5.2,
    3.8,
    14,
  )

  addFooter(slide)
}

// Slide 7
{
  const slide = pptx.addSlide()
  addHeader(slide, 'What Is Working Well')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.0,
    y: 1.55,
    w: 11.1,
    h: 4.8,
    fill: { color: 'ECFDF3' },
    line: { color: 'BBF7D0' },
    radius: 0.08,
  })

  addBullets(
    slide,
    [
      'Consistent module template keeps engineering velocity high.',
      'Type-safe stack reduces integration defects between API and data model.',
      'Security baseline already active across transport and request layers.',
      'Multi-tenant design is built into middleware and membership model.',
      'Clear split between API process and worker process supports scale.',
    ],
    1.35,
    2.0,
    10.5,
    3.9,
    17,
  )

  slide.addText('Outcome: strong foundation to scale features without rewriting core architecture.', {
    x: 1.35,
    y: 6.1,
    w: 10.6,
    h: 0.35,
    fontSize: 14,
    bold: true,
    color: palette.green,
    align: 'center',
  })

  addFooter(slide)
}

// Slide 8
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Current Gaps and Risks to Address')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.9,
    y: 1.4,
    w: 12.0,
    h: 5.2,
    fill: { color: 'FEF2F2' },
    line: { color: 'FECACA' },
    radius: 0.06,
  })

  addBullets(
    slide,
    [
      'Automated testing coverage is not yet at production target.',
      'Background worker pipeline is prepared but not fully operational.',
      'API documentation and integration playbooks need formalization.',
      'Observability depth (trace, audit, and KPI dashboards) is still maturing.',
      'Pagination and performance standards should be enforced consistently.',
    ],
    1.25,
    2.0,
    11.2,
    4.0,
    16,
  )

  slide.addText('Risk posture today: manageable, with high confidence once roadmap controls are delivered.', {
    x: 1.15,
    y: 6.15,
    w: 11.3,
    h: 0.3,
    fontSize: 13,
    bold: true,
    align: 'center',
    color: palette.red,
  })

  addFooter(slide)
}

// Slide 9
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Target Delivery Framework (Next 90 Days)')

  slide.addShape(pptx.ShapeType.rect, { x: 1.0, y: 1.7, w: 3.65, h: 4.6, fill: { color: 'EAF0FF' }, line: { color: 'C8D8FF' } })
  slide.addShape(pptx.ShapeType.rect, { x: 4.85, y: 1.7, w: 3.65, h: 4.6, fill: { color: 'EBFCFA' }, line: { color: 'BEEFEA' } })
  slide.addShape(pptx.ShapeType.rect, { x: 8.7, y: 1.7, w: 3.65, h: 4.6, fill: { color: 'F0FDF4' }, line: { color: 'BBF7D0' } })

  slide.addText('Phase 1\nStabilize', { x: 1.2, y: 2.0, w: 3.2, h: 0.7, align: 'center', bold: true, fontSize: 18, color: palette.navy })
  addBullets(slide, ['Test foundation', 'Security hardening', 'API baseline docs'], 1.15, 2.8, 3.2, 2.8, 13)

  slide.addText('Phase 2\nScale', { x: 5.05, y: 2.0, w: 3.2, h: 0.7, align: 'center', bold: true, fontSize: 18, color: palette.teal })
  addBullets(slide, ['Queue workflows live', 'Performance tuning', 'Tenant safeguards'], 5.0, 2.8, 3.2, 2.8, 13)

  slide.addText('Phase 3\nOptimize', { x: 8.9, y: 2.0, w: 3.2, h: 0.7, align: 'center', bold: true, fontSize: 18, color: palette.green })
  addBullets(slide, ['Observability dashboard', 'Release automation', 'Operational readiness'], 8.85, 2.8, 3.2, 2.8, 13)

  addFooter(slide)
}

// Slide 10
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Success Metrics We Will Report')

  slide.addShape(pptx.ShapeType.roundRect, { x: 0.95, y: 1.4, w: 5.9, h: 5.0, fill: { color: 'EFF6FF' }, line: { color: 'BFDBFE' }, radius: 0.05 })
  slide.addShape(pptx.ShapeType.roundRect, { x: 6.45, y: 1.4, w: 5.9, h: 5.0, fill: { color: 'F0FDF4' }, line: { color: 'BBF7D0' }, radius: 0.05 })

  slide.addText('Engineering KPIs', { x: 1.25, y: 1.8, w: 5.3, h: 0.3, fontSize: 16, bold: true, color: palette.navy })
  addBullets(slide, ['Automated test coverage > 70%', 'Critical API error rate < 1%', 'P95 latency < 300ms on priority endpoints', 'Deployment rollback readiness validated'], 1.2, 2.2, 5.3, 3.8, 14)

  slide.addText('Business-Facing KPIs', { x: 6.75, y: 1.8, w: 5.3, h: 0.3, fontSize: 16, bold: true, color: palette.green })
  addBullets(slide, ['Faster feature turnaround per sprint', 'Improved platform reliability for institutes', 'Reduced support incidents tied to backend defects', 'Transparent monthly status with trend charts'], 6.7, 2.2, 5.3, 3.8, 14)

  addFooter(slide)
}

// Slide 11
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Client Alignment Needed')

  addBullets(
    slide,
    [
      'Confirm milestone acceptance criteria for each phase.',
      'Prioritize top 5 business-critical API workflows for KPI tracking.',
      'Approve security/compliance checklist for production go-live.',
      'Nominate business and technical reviewers for bi-weekly demos.',
      'Agree on release window and change freeze protocol.',
    ],
    1.05,
    1.7,
    11.3,
    4.6,
    18,
  )

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.05,
    y: 5.95,
    w: 11.3,
    h: 0.7,
    fill: { color: 'DBEAFE' },
    line: { color: 'BFDBFE' },
    radius: 0.06,
  })
  slide.addText('Decision requested: approve 90-day framework so execution can begin immediately.', {
    x: 1.2,
    y: 6.18,
    w: 10.9,
    h: 0.28,
    align: 'center',
    bold: true,
    color: palette.navy,
    fontSize: 14,
  })

  addFooter(slide)
}

// Slide 12
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Thank You')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 2.2,
    y: 2.0,
    w: 8.9,
    h: 2.8,
    fill: { color: 'F8FAFC' },
    line: { color: 'E5E7EB' },
    radius: 0.08,
  })

  slide.addText('Questions and Discussion', {
    x: 2.5,
    y: 2.7,
    w: 8.3,
    h: 0.6,
    fontSize: 34,
    bold: true,
    align: 'center',
    color: palette.navy,
  })

  slide.addText('We are ready to proceed with milestone-based execution.', {
    x: 2.5,
    y: 3.55,
    w: 8.3,
    h: 0.35,
    align: 'center',
    fontSize: 15,
    color: palette.muted,
  })

  addFooter(slide, 'Gyanverse Engineering Team')
}

await pptx.writeFile({ fileName: 'artifacts/backend-structure-client-presentation.pptx' })
console.log('Created artifacts/backend-structure-client-presentation.pptx')
