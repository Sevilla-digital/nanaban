// Verifica el esquema y las consultas clave contra un Postgres real (PGlite/WASM).
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const leerSql = (nombre) => readFile(new URL(`../${nombre}`, import.meta.url), 'utf8');
const db = new PGlite();
let fallos = 0;

const check = (nombre, cond, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FALLO'} ${nombre}${extra ? ' -> ' + extra : ''}`);
  if (!cond) fallos++;
};

// 1. El esquema aplica limpio
await db.exec(await leerSql('schema.sql'));
check('schema.sql aplica sin errores', true);

// 2. Y es idempotente (se puede reejecutar en cada deploy)
await db.exec(await leerSql('schema.sql'));
check('schema.sql es idempotente', true);

// 3. Alta de cliente
const { rows: [cliente] } = await db.query(
  `INSERT INTO clientes (nombre, telefono, password_hash) VALUES ($1,$2,$3)
   ON CONFLICT (telefono) DO NOTHING RETURNING id, nombre, es_admin`,
  ['Ana Torres', '+34600112233', 'scrypt$32768$8$1$aa$bb']
);
check('inserta cliente', cliente?.nombre === 'Ana Torres');

// 4. Telefono duplicado -> DO NOTHING devuelve 0 filas (lo que espera /registro)
const dup = await db.query(
  `INSERT INTO clientes (nombre, telefono, password_hash) VALUES ($1,$2,$3)
   ON CONFLICT (telefono) DO NOTHING RETURNING id`,
  ['Otro', '+34600112233', 'x']
);
check('telefono duplicado devuelve 0 filas', dup.rows.length === 0);

// 5. Saldo inicial cero
const s0 = await db.query('SELECT saldo FROM saldos WHERE cliente_id=$1', [cliente.id]);
check('saldo inicial = 0', String(s0.rows[0].saldo) === '0.00', String(s0.rows[0]?.saldo));

// 6. Deposito + retiro suman bien con NUMERIC (aqui es donde float fallaria)
await db.query(
  `INSERT INTO movimientos (cliente_id,tipo,importe,descripcion) VALUES ($1,'deposito',$2,'Ingreso inicial')`,
  [cliente.id, '0.10']
);
await db.query(
  `INSERT INTO movimientos (cliente_id,tipo,importe,descripcion) VALUES ($1,'deposito',$2,'Segundo ingreso')`,
  [cliente.id, '0.20']
);
const s1 = await db.query('SELECT saldo FROM saldos WHERE cliente_id=$1', [cliente.id]);
check('0.10 + 0.20 = 0.30 exacto', String(s1.rows[0].saldo) === '0.30', String(s1.rows[0].saldo));

// 7. Los movimientos son inmutables
await db.query(`UPDATE movimientos SET importe = 999999 WHERE cliente_id=$1`, [cliente.id]);
const s2 = await db.query('SELECT saldo FROM saldos WHERE cliente_id=$1', [cliente.id]);
check('UPDATE sobre movimientos no cambia nada', String(s2.rows[0].saldo) === '0.30', String(s2.rows[0].saldo));

await db.query(`DELETE FROM movimientos WHERE cliente_id=$1`, [cliente.id]);
const s3 = await db.query('SELECT saldo FROM saldos WHERE cliente_id=$1', [cliente.id]);
check('DELETE sobre movimientos no borra nada', String(s3.rows[0].saldo) === '0.30', String(s3.rows[0].saldo));

// 8. Importe 0 rechazado
try {
  await db.query(
    `INSERT INTO movimientos (cliente_id,tipo,importe,descripcion) VALUES ($1,'ajuste',0,'nada')`,
    [cliente.id]
  );
  check('rechaza importe 0', false, 'lo acepto');
} catch {
  check('rechaza importe 0', true);
}

// 9. Tipo invalido rechazado
try {
  await db.query(
    `INSERT INTO movimientos (cliente_id,tipo,importe,descripcion) VALUES ($1,'regalo',10,'x')`,
    [cliente.id]
  );
  check('rechaza tipo de movimiento invalido', false, 'lo acepto');
} catch {
  check('rechaza tipo de movimiento invalido', true);
}

// 10. No se puede borrar un cliente con movimientos (RESTRICT)
try {
  await db.query('DELETE FROM clientes WHERE id=$1', [cliente.id]);
  check('no deja borrar cliente con historial', false, 'lo borro');
} catch {
  check('no deja borrar cliente con historial', true);
}

// 11. La comprobacion de saldo insuficiente de /movimientos
const saldo = await db.query('SELECT COALESCE(SUM(importe),0) AS s FROM movimientos WHERE cliente_id=$1', [cliente.id]);
const ok = await db.query('SELECT ($1::numeric + $2::numeric) >= 0 AS ok', [saldo.rows[0].s, '-100.00']);
check('detecta saldo insuficiente (0.30 - 100)', ok.rows[0].ok === false, String(ok.rows[0].ok));
const ok2 = await db.query('SELECT ($1::numeric + $2::numeric) >= 0 AS ok', [saldo.rows[0].s, '-0.30']);
check('permite retiro exacto del saldo (0.30 - 0.30)', ok2.rows[0].ok === true, String(ok2.rows[0].ok));

// 12. Inversion con gramos negativos rechazada
try {
  await db.query(
    `INSERT INTO inversiones (cliente_id,gramos_oro,importe) VALUES ($1,-5,100)`,
    [cliente.id]
  );
  check('rechaza inversion con gramos negativos', false, 'la acepto');
} catch {
  check('rechaza inversion con gramos negativos', true);
}

// 13. Migracion desde el esquema viejo (columnas importe_eur, vista saldo_eur):
// simula la base de produccion creada cuando la plataforma era en euros, con
// datos dentro, y comprueba que aplicar el esquema actual renombra sin perder nada.
const dbVieja = new PGlite();
await dbVieja.exec(`
  CREATE TABLE clientes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre TEXT NOT NULL, apellido TEXT NOT NULL DEFAULT '', usuario TEXT,
    telefono TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    es_admin BOOLEAN NOT NULL DEFAULT FALSE, activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE inversiones (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id BIGINT NOT NULL REFERENCES clientes(id),
    gramos_oro NUMERIC(14,4) NOT NULL, importe_eur NUMERIC(18,2) NOT NULL,
    estado TEXT NOT NULL DEFAULT 'abierta',
    abierta_en TIMESTAMPTZ NOT NULL DEFAULT now(), cerrada_en TIMESTAMPTZ
  );
  CREATE TABLE movimientos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id BIGINT NOT NULL REFERENCES clientes(id),
    tipo TEXT NOT NULL, importe_eur NUMERIC(18,2) NOT NULL, descripcion TEXT NOT NULL,
    inversion_id BIGINT, creado_por BIGINT, creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE VIEW saldos AS
    SELECT c.id AS cliente_id, COALESCE(SUM(m.importe_eur),0)::NUMERIC(18,2) AS saldo_eur
    FROM clientes c LEFT JOIN movimientos m ON m.cliente_id = c.id GROUP BY c.id;
  INSERT INTO clientes (nombre, telefono, password_hash) VALUES ('Viejo Cliente', '+34611111111', 'x');
  INSERT INTO movimientos (cliente_id, tipo, importe_eur, descripcion) VALUES (1, 'deposito', 250.75, 'saldo previo');
`);
try {
  await dbVieja.exec(await leerSql('schema.sql'));
  const mig = await dbVieja.query('SELECT saldo FROM saldos WHERE cliente_id = 1');
  check(
    'la migracion renombra las columnas y conserva el saldo',
    String(mig.rows[0]?.saldo) === '250.75',
    String(mig.rows[0]?.saldo)
  );
} catch (err) {
  check('la migracion aplica sobre la base vieja', false, err.message);
}
await dbVieja.close();

console.log(fallos === 0 ? '\nTodo correcto.' : `\n${fallos} fallo(s).`);
await db.close();
process.exit(fallos === 0 ? 0 : 1);
