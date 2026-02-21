import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '../../migrations');

async function migrate() {
  console.log('Running migrations...');

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let failures = 0;
  for (const file of files) {
    console.log(`  Running ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await query(sql);
      console.log(`  ✓ ${file}`);
    } catch (err: any) {
      // Non-fatal: extension not available (Railway doesn't have pgvector)
      // or "already exists" errors on re-run
      const code = err?.code;
      if (code === '0A000' || code === '42710' || code === '42P07') {
        console.warn(`  ⚠ ${file}: non-fatal (${err.message?.slice(0, 80)}), continuing...`);
      } else {
        console.error(`  ✗ ${file}:`, err);
        failures++;
      }
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} migration(s) had fatal errors`);
  }

  console.log('All migrations complete.');
  await closePool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
