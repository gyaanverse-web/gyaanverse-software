import { env } from '@config/env.js'

// Dev: console.log (same pattern as MSG91 OTP in auth module)
// Prod: MSG91 Flow API

export async function sendSms(params: {
  to: string      // phone number with country code e.g. 919876543210
  body: string
  templateId: string
  vars?: Record<string, string>
}): Promise<void> {
  if (!env.MSG91_AUTH_KEY) {
    console.log(`[SMS DEV] To: ${params.to} | ${params.body}`)
    return
  }

  const response = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: env.MSG91_AUTH_KEY,
    },
    body: JSON.stringify({
      flow_id: params.templateId,
      sender: env.MSG91_SENDER_ID,
      recipients: [
        {
          mobiles: params.to,
          ...params.vars,
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`MSG91 error ${response.status}: ${text}`)
  }
}
