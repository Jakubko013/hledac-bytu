import { adapters } from '../src/crawler/portals/index';
import { runAll } from '../src/crawler/run';
import { createDb } from '../db/index';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const results = await runAll(createDb(url), adapters, { runner: 'github', maxPages: 30 });
for (const r of results) {
  console.log(`${r.portal}: ${r.status} fetched=${r.fetched} new=${r.newCount} updated=${r.updatedCount}${r.error ? ` error=${r.error}` : ''}`);
}
const allFailed = results.length === 0 || results.every((r) => r.status === 'failed');
process.exit(allFailed ? 1 : 0);
