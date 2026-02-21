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

  for (const file of files) {
    console.log(`  Running ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await query(sql);
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file}:`, err);
      throw err;
    }
  }

  console.log('All migrations complete.');
  await closePool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
