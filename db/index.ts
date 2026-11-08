import { getDatabase } from '@netlify/database';
import { drizzle } from 'drizzle-orm/netlify-db';
import * as schema from './schema';

/**
 * Creates a Drizzle client. Connection string: NETLIFY_DB_URL (injected on Netlify)
 * or DATABASE_URL (GitHub Actions, local). This is the only place that touches the DB driver.
 */
export function createDb(connectionString = process.env.NETLIFY_DB_URL ?? process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('Missing database connection string: set NETLIFY_DB_URL or DATABASE_URL.');
  }
  return drizzle({ client: getDatabase({ connectionString }), schema });
}

export type Db = ReturnType<typeof createDb>;
