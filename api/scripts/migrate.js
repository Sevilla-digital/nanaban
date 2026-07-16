import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const schema = fileURLToPath(new URL('../schema.sql', import.meta.url));

try {
  await pool.query(await readFile(schema, 'utf8'));
  console.log('Esquema aplicado correctamente.');
} catch (err) {
  console.error('Fallo al aplicar el esquema:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
