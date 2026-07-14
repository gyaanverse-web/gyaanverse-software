import * as dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

function devOptional(key: string): string {
  if (process.env.NODE_ENV === 'production') return requireEnv(key)
  return process.env[key] ?? ''
}

export const env = {
  DATABASE_URL: requireEnv('DATABASE_URL'),
  REDIS_URL: requireEnv('REDIS_URL'),
  BETTER_AUTH_SECRET: requireEnv('BETTER_AUTH_SECRET'),
  BETTER_AUTH_URL: requireEnv('BETTER_AUTH_URL'),
  CLOUDINARY_CLOUD_NAME: requireEnv('CLOUDINARY_CLOUD_NAME'),
  CLOUDINARY_API_KEY: requireEnv('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: requireEnv('CLOUDINARY_API_SECRET'),
  CLOUDINARY_UPLOAD_FOLDER: process.env.CLOUDINARY_UPLOAD_FOLDER ?? 'gyanverse',
  STORAGE_MAX_UPLOAD_BYTES: parseInt(process.env.STORAGE_MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024), 10),
  RESEND_API_KEY: requireEnv('RESEND_API_KEY'),
  MSG91_AUTH_KEY: devOptional('MSG91_AUTH_KEY'),
  MSG91_TEMPLATE_ID: devOptional('MSG91_TEMPLATE_ID'),
  MSG91_SENDER_ID: devOptional('MSG91_SENDER_ID'),
  MAILPIT_HOST: process.env.MAILPIT_HOST ?? 'localhost',
  MAILPIT_PORT: parseInt(process.env.MAILPIT_PORT ?? '1025', 10),
  FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  RAZORPAY_KEY_ID: requireEnv('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: requireEnv('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: requireEnv('RAZORPAY_WEBHOOK_SECRET'),
  APP_DOMAIN: requireEnv('APP_DOMAIN'),
  EVAL_ENGINE_URL: process.env.EVAL_ENGINE_URL ?? 'http://localhost:5000',
  EVAL_ENGINE_TIMEOUT_MS: parseInt(process.env.EVAL_ENGINE_TIMEOUT_MS ?? '120000', 10),
  EVAL_DEFAULT_COLLECTION: process.env.EVAL_DEFAULT_COLLECTION ?? '',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '3000', 10),
}
