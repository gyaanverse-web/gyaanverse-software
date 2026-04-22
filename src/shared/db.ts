import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'
import { env } from '../config/env.js'

const pool = new Pool({ connectionString: env.DATABASE_URL })

export const db = drizzle(pool, { schema })

export type DB = typeof db
