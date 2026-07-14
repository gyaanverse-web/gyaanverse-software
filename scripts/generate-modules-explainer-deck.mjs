import PptxGenJS from 'pptxgenjs'

const pptx = new PptxGenJS()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'Gyanverse Engineering'
pptx.company = 'Gyanverse'
pptx.subject = 'Backend Module Explainer'
pptx.title = 'Gyanverse Backend Modules - Purpose and Simple Use'
pptx.lang = 'en-US'

const C = {
  navy: '0B1F3A',
  blue: '2563EB',
  green: '16A34A',
  amber: 'D97706',
  slate: '334155',
  soft: 'F8FAFC',
  line: 'E2E8F0',
  white: 'FFFFFF',
}

const modules = [
  {
    name: 'Auth',
    purpose: 'Handles sign-in, sessions, OTP, and identity verification.',
    use: 'User logs in with phone/email and gets access to the platform.',
  },
  {
    name: 'Tenant',
    purpose: 'Manages coaching institute identity and tenant-level settings.',
    use: 'Create a new coaching and route users into the right institute.',
  },
  {
    name: 'Membership',
    purpose: 'Controls who belongs to a coaching and with what role.',
    use: 'Student joins a coaching using a join code.',
  },
  {
    name: 'Invite',
    purpose: 'Sends and tracks invites for teachers and members.',
    use: 'Owner invites a teacher to join the coaching.',
  },
  {
    name: 'Class',
    purpose: 'Creates and manages batches/classes and enrollments.',
    use: 'Teacher creates Class 10 batch and adds students.',
  },
  {
    name: 'Exam',
    purpose: 'Creates test definitions, papers, and schedules.',
    use: 'Coaching publishes a weekly mock test for a class.',
  },
  {
    name: 'Exam Session',
    purpose: 'Runs individual student test attempts and timing state.',
    use: 'Student starts exam at 4:00 PM and submits before timeout.',
  },
  {
    name: 'Evaluation',
    purpose: 'Scores submissions and stores result breakdowns.',
    use: 'System auto-checks answers and generates marks section-wise.',
  },
  {
    name: 'Report',
    purpose: 'Builds progress reports for students, classes, and exams.',
    use: 'Teacher views monthly performance report for each student.',
  },
  {
    name: 'Analytics',
    purpose: 'Produces trend metrics, funnels, and performance insights.',
    use: 'Owner sees pass rate trend and attendance-performance correlation.',
  },
  {
    name: 'Notification',
    purpose: 'Delivers alerts and reminders across channels.',
    use: 'Students receive reminder 1 hour before exam starts.',
  },
  {
    name: 'Billing',
    purpose: 'Applies subscription plan rules and usage limits.',
    use: 'Free plan blocks creating more classes after plan limit.',
  },
  {
    name: 'Payment',
    purpose: 'Processes subscription payments and webhook confirmations.',
    use: 'Owner upgrades plan and payment status updates automatically.',
  },
  {
    name: 'Storage',
    purpose: 'Stores and serves files like documents and media.',
    use: 'Teacher uploads question PDF and it is linked to exam.',
  },
  {
    name: 'Admin',
    purpose: 'Provides platform-level oversight and control tools.',
    use: 'Super admin reviews tenant health and disables abuse accounts.',
  },
]

function addHeader(slide, title, subtitle = '') {
  slide.background = { color: C.white }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.9,
    fill: { color: C.navy },
    line: { color: C.navy },
  })
  slide.addText(title, {
    x: 0.6,
    y: 0.22,
    w: 8.8,
    h: 0.35,
    color: C.white,
    fontSize: 20,
    bold: true,
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.6,
      y: 0.56,
      w: 9.6,
      h: 0.2,
      color: 'DBEAFE',
      fontSize: 10,
    })
  }
}

function addFooter(slide, text = 'Gyanverse Module Overview') {
  slide.addShape(pptx.ShapeType.line, {
    x: 0.6,
    y: 7.15,
    w: 12.1,
    h: 0,
    line: { color: C.line, pt: 1 },
  })
  slide.addText(text, {
    x: 0.6,
    y: 7.2,
    w: 12.1,
    h: 0.2,
    align: 'right',
    color: '64748B',
    fontSize: 9,
  })
}

function addModuleCard(slide, module, x, y) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w: 3.95,
    h: 1.75,
    fill: { color: C.soft },
    line: { color: C.line },
    radius: 0.05,
  })

  slide.addText(module.name, {
    x: x + 0.18,
    y: y + 0.12,
    w: 3.5,
    h: 0.25,
    fontSize: 14,
    bold: true,
    color: C.blue,
  })

  slide.addText(module.purpose, {
    x: x + 0.18,
    y: y + 0.43,
    w: 3.55,
    h: 0.55,
    fontSize: 10,
    color: C.slate,
  })

  slide.addText(`Simple use: ${module.use}`, {
    x: x + 0.18,
    y: y + 1.05,
    w: 3.55,
    h: 0.55,
    fontSize: 10,
    color: C.green,
    bold: true,
  })
}

// Slide 1
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Gyanverse Backend Modules', 'What each module is for and simple client-facing use')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.95,
    y: 1.35,
    w: 11.4,
    h: 4.8,
    fill: { color: 'EFF6FF' },
    line: { color: 'BFDBFE' },
    radius: 0.06,
  })

  slide.addText('15 Core Modules', {
    x: 1.2,
    y: 2.2,
    w: 10.8,
    h: 0.8,
    align: 'center',
    fontSize: 44,
    bold: true,
    color: C.navy,
  })

  slide.addText('Simple purpose + simple use case for each module', {
    x: 1.4,
    y: 3.35,
    w: 10.4,
    h: 0.4,
    align: 'center',
    fontSize: 16,
    color: '475569',
  })

  addFooter(slide, 'Prepared for client walkthrough | April 2026')
}

// Slide 2
{
  const slide = pptx.addSlide()
  addHeader(slide, 'How To Read This Deck')

  const bullets = [
    'Each card explains one backend module.',
    'Purpose: what business problem it solves.',
    'Simple use: one real scenario the client can relate to.',
    'Together, these modules form the full coaching platform backbone.',
  ]

  const runs = bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, breakLine: true } }))
  slide.addText(runs, {
    x: 1.0,
    y: 1.8,
    w: 11.2,
    h: 3.8,
    fontSize: 20,
    color: C.slate,
    paraSpaceAfterPt: 12,
  })

  addFooter(slide)
}

function addModuleSlide(title, subset) {
  const slide = pptx.addSlide()
  addHeader(slide, title)

  addModuleCard(slide, subset[0], 0.7, 1.2)
  addModuleCard(slide, subset[1], 4.7, 1.2)
  addModuleCard(slide, subset[2], 8.7, 1.2)
  addModuleCard(slide, subset[3], 0.7, 3.15)
  addModuleCard(slide, subset[4], 4.7, 3.15)

  if (subset[5]) {
    addModuleCard(slide, subset[5], 8.7, 3.15)
  }

  addFooter(slide)
}

addModuleSlide('Core Access and Organization Modules', modules.slice(0, 5))
addModuleSlide('Learning and Assessment Modules', modules.slice(5, 10))
addModuleSlide('Operations, Revenue, and Platform Modules', modules.slice(10, 15))

// Slide 6
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Module Flow in One View')

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.8,
    y: 1.4,
    w: 3.9,
    h: 1.1,
    fill: { color: 'DBEAFE' },
    line: { color: 'BFDBFE' },
    radius: 0.05,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 4.95,
    y: 1.4,
    w: 3.9,
    h: 1.1,
    fill: { color: 'DCFCE7' },
    line: { color: 'BBF7D0' },
    radius: 0.05,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.1,
    y: 1.4,
    w: 3.3,
    h: 1.1,
    fill: { color: 'FEF3C7' },
    line: { color: 'FDE68A' },
    radius: 0.05,
  })

  slide.addText('Identity + Access', { x: 1.15, y: 1.78, w: 3.2, h: 0.3, align: 'center', bold: true, color: C.navy, fontSize: 15 })
  slide.addText('Learning Engine', { x: 5.35, y: 1.78, w: 3.1, h: 0.3, align: 'center', bold: true, color: C.green, fontSize: 15 })
  slide.addText('Business Engine', { x: 9.45, y: 1.78, w: 2.6, h: 0.3, align: 'center', bold: true, color: C.amber, fontSize: 15 })

  const list = [
    'Identity + Access: Auth, Tenant, Membership, Invite',
    'Learning Engine: Class, Exam, Exam Session, Evaluation, Report, Analytics',
    'Business Engine: Billing, Payment, Notification, Storage, Admin',
  ]

  const runs = list.map((b) => ({ text: b, options: { bullet: { indent: 18 }, breakLine: true } }))
  slide.addText(runs, {
    x: 1.0,
    y: 3.0,
    w: 11.3,
    h: 2.5,
    fontSize: 16,
    color: C.slate,
    paraSpaceAfterPt: 10,
  })

  addFooter(slide)
}

// Slide 7
{
  const slide = pptx.addSlide()
  addHeader(slide, 'Client Value Summary')

  const points = [
    'Clear module boundaries mean faster development and easier scaling.',
    'Each module maps directly to a client-visible business capability.',
    'This structure reduces risk when adding new features in future phases.',
    'The platform can grow institute-by-institute without architecture rewrites.',
  ]

  const runs = points.map((b) => ({ text: b, options: { bullet: { indent: 18 }, breakLine: true } }))

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.95,
    y: 1.5,
    w: 11.4,
    h: 4.9,
    fill: { color: 'F8FAFC' },
    line: { color: C.line },
    radius: 0.06,
  })

  slide.addText(runs, {
    x: 1.3,
    y: 2.0,
    w: 10.6,
    h: 3.6,
    fontSize: 18,
    color: C.slate,
    paraSpaceAfterPt: 12,
  })

  addFooter(slide, 'Gyanverse Backend Module Architecture')
}

await pptx.writeFile({ fileName: '../docs/decks/backend-modules-explainer-client-deck.pptx' })
console.log('Created docs/decks/backend-modules-explainer-client-deck.pptx')
