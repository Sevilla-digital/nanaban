import pg from 'pg';

// Render entrega el saldo y los importes como NUMERIC. El driver los devuelve como
// string por defecto para no perder precision; los dejamos asi y formateamos arriba.
// Nunca convertir dinero a Number en JS: 0.1 + 0.2 !== 0.3.

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL. Copia api/.env.example a api/.env y rellenala.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render exige TLS en las conexiones externas a Postgres.
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Ejecuta fn dentro de una transaccion, con rollback automatico si lanza. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
