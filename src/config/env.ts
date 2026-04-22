import * as dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

export const env = {
  DATABASE_URL: requireEnv('DATABASE_URL'),
  REDIS_URL: requireEnv('REDIS_URL'),
  BETTER_AUTH_SECRET: requireEnv('BETTER_AUTH_SECRET'),
  BETTER_AUTH_URL: requireEnv('BETTER_AUTH_URL'),
  R2_ACCOUNT_ID: requireEnv('R2_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: requireEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requireEnv('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_NAME: requireEnv('R2_BUCKET_NAME'),
  R2_PUBLIC_URL: requireEnv('R2_PUBLIC_URL'),
  RESEND_API_KEY: requireEnv('RESEND_API_KEY'),
  MSG91_AUTH_KEY: requireEnv('MSG91_AUTH_KEY'),
  MSG91_TEMPLATE_ID: requireEnv('MSG91_TEMPLATE_ID'),
  RAZORPAY_KEY_ID: requireEnv('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: requireEnv('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: requireEnv('RAZORPAY_WEBHOOK_SECRET'),
  APP_DOMAIN: requireEnv('APP_DOMAIN'),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '3000', 10),
}
