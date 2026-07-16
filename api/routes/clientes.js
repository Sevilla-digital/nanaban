import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import {
  HASH_SENUELO,
  firmarToken,
  hashPassword,
  normalizarTelefono,
  requiereAdmin,
  requiereAuth,
  verificarPassword,
} from '../auth.js';

export const router = Router();

// Limita la fuerza bruta contra login/registro. Sin esto, un telefono de 9 digitos
// y una contrasena debil se revientan en minutos.
const limiteAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 10 intentos por IP cada 15 min en produccion. Configurable para los tests, que
  // hacen muchas llamadas legitimas seguidas desde la misma IP.
  limit: Number(process.env.AUTH_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Prueba de nuevo en 15 minutos.' },
});

const login = z.object({
  usuario: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(200),
});

const registro = z.object({
  nombre: z.string().trim().min(2).max(120),
  apellido: z.string().trim().min(2).max(120),
  usuario: z
    .string()
    .trim()
    .min(3, 'El usuario debe tener al menos 3 caracteres')
    .max(30)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Solo letras, numeros y . _ - (sin espacios)'),
  telefono: z.string().min(6).max(20),
  password: z.string().min(8, 'La contrasena debe tener al menos 8 caracteres').max(200),
});

router.post('/registro', limiteAuth, async (req, res, next) => {
  try {
    const datos = registro.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }

    const telefono = normalizarTelefono(datos.data.telefono);
    if (!telefono) return res.status(400).json({ error: 'Numero de telefono no valido' });

    // Minusculas siempre: "Ana" y "ana" son el mismo usuario.
    const usuario = datos.data.usuario.toLowerCase();
    const hash = await hashPassword(datos.data.password);
    const { rows } = await query(
      `INSERT INTO clientes (nombre, apellido, usuario, telefono, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nombre, apellido, usuario, telefono, es_admin, creado_en`,
      [datos.data.nombre, datos.data.apellido, usuario, telefono, hash]
    );

    res.status(201).json({ token: firmarToken(rows[0]), cliente: rows[0] });
  } catch (err) {
    // 23505 = violacion de UNIQUE. El nombre del constraint dice cual de los dos.
    if (err.code === '23505') {
      const mensaje =
        err.constraint === 'clientes_usuario_key'
          ? 'Ese nombre de usuario ya existe'
          : 'Ese telefono ya esta registrado';
      return res.status(409).json({ error: mensaje });
    }
    next(err);
  }
});

router.post('/login', limiteAuth, async (req, res, next) => {
  try {
    const datos = login.safeParse(req.body);
    if (!datos.success) return res.status(400).json({ error: 'Datos invalidos' });

    const { rows } = await query(
      `SELECT id, nombre, apellido, usuario, telefono, password_hash, es_admin, activo
       FROM clientes WHERE usuario = $1`,
      [datos.data.usuario.toLowerCase()]
    );
    const cliente = rows[0];

    // Comparamos siempre contra un hash aunque el cliente no exista, para que el tiempo
    // de respuesta no revele que usuarios estan registrados.
    const ok = await verificarPassword(datos.data.password, cliente?.password_hash ?? HASH_SENUELO);

    if (!cliente || !ok) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    if (!cliente.activo) return res.status(403).json({ error: 'Cuenta desactivada' });

    res.json({
      token: firmarToken(cliente),
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre,
        apellido: cliente.apellido,
        usuario: cliente.usuario,
        telefono: cliente.telefono,
        esAdmin: cliente.es_admin,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Convierte a un cliente ya registrado en administrador, una sola vez, para crear
 * el primer admin (no se puede desde el panel porque aun no hay ningun admin).
 *
 * Se activa solo si existe la variable de entorno ADMIN_BOOTSTRAP_TOKEN, y exige
 * ese mismo valor como 'clave'. Sin la variable, el endpoint no existe (404).
 * En cuanto tengas tu admin, borra la variable en Render y esto queda desactivado.
 */
router.post('/bootstrap-admin', limiteAuth, async (req, res, next) => {
  try {
    const secreto = process.env.ADMIN_BOOTSTRAP_TOKEN;
    if (!secreto) return res.status(404).json({ error: 'Ruta no encontrada' });

    const clave = String(req.body?.clave ?? '');
    const a = Buffer.from(clave);
    const b = Buffer.from(secreto);
    // timingSafeEqual exige misma longitud; si difieren, no coincide y punto.
    const coincide = a.length === b.length && timingSafeEqual(a, b);
    if (!coincide) return res.status(403).json({ error: 'Clave de arranque incorrecta' });

    const telefono = normalizarTelefono(req.body?.telefono);
    if (!telefono) return res.status(400).json({ error: 'Telefono no valido' });

    const { rows } = await query(
      `UPDATE clientes SET es_admin = TRUE WHERE telefono = $1
       RETURNING id, nombre, apellido, telefono, es_admin`,
      [telefono]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No hay ningun cliente con ese telefono. Registrate primero.' });
    }
    res.json({ ok: true, cliente: rows[0] });
  } catch (err) {
    next(err);
  }
});

/** Perfil del cliente autenticado, con su saldo y sus inversiones abiertas. */
router.get('/me', requiereAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.nombre, c.apellido, c.usuario, c.telefono, c.es_admin, c.creado_en, s.saldo_eur
       FROM clientes c
       JOIN saldos s ON s.cliente_id = c.id
       WHERE c.id = $1`,
      [req.cliente.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const inversiones = await query(
      `SELECT id, gramos_oro, importe_eur, estado, abierta_en, cerrada_en
       FROM inversiones WHERE cliente_id = $1 ORDER BY abierta_en DESC`,
      [req.cliente.id]
    );

    res.json({ ...rows[0], inversiones: inversiones.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/me/movimientos', requiereAuth, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const { rows } = await query(
      `SELECT id, tipo, importe_eur, descripcion, inversion_id, creado_en
       FROM movimientos WHERE cliente_id = $1
       ORDER BY creado_en DESC, id DESC
       LIMIT $2`,
      [req.cliente.id, limite]
    );
    res.json({ movimientos: rows });
  } catch (err) {
    next(err);
  }
});

/** Listado de clientes con su saldo. Solo admin. Para el panel de gestion. */
router.get('/', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const busqueda = String(req.query.buscar ?? '').trim();
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    const { rows } = await query(
      `SELECT c.id, c.nombre, c.apellido, c.usuario, c.telefono, c.es_admin, c.activo,
              c.creado_en, s.saldo_eur
       FROM clientes c
       JOIN saldos s ON s.cliente_id = c.id
       WHERE ($1 = '' OR c.nombre ILIKE '%'||$1||'%' OR c.apellido ILIKE '%'||$1||'%'
              OR c.usuario ILIKE '%'||$1||'%' OR c.telefono ILIKE '%'||$1||'%')
       ORDER BY c.creado_en DESC
       LIMIT $2`,
      [busqueda, limite]
    );
    res.json({ clientes: rows });
  } catch (err) {
    next(err);
  }
});

/** Detalle de un cliente cualquiera: perfil, saldo, inversiones y movimientos. Solo admin. */
router.get('/:id', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });

    const { rows } = await query(
      `SELECT c.id, c.nombre, c.apellido, c.usuario, c.telefono, c.es_admin, c.activo,
              c.creado_en, s.saldo_eur
       FROM clientes c
       JOIN saldos s ON s.cliente_id = c.id
       WHERE c.id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Dos lecturas independientes, pero secuenciales a proposito: es un endpoint de
    // admin puntual, la latencia extra es un round-trip, y asi no dependemos de que
    // haya varias conexiones libres en el pool.
    const inversiones = await query(
      `SELECT id, gramos_oro, importe_eur, estado, abierta_en, cerrada_en
       FROM inversiones WHERE cliente_id = $1 ORDER BY abierta_en DESC`,
      [id]
    );
    const movimientos = await query(
      `SELECT id, tipo, importe_eur, descripcion, inversion_id, creado_en
       FROM movimientos WHERE cliente_id = $1 ORDER BY creado_en DESC, id DESC LIMIT 200`,
      [id]
    );

    res.json({ ...rows[0], inversiones: inversiones.rows, movimientos: movimientos.rows });
  } catch (err) {
    next(err);
  }
});

const nuevoMovimiento = z.object({
  // El driver pg devuelve los BIGINT como string, asi que los ids viajan como "12"
  // en el JSON que sale de la API y vuelven como string. Aceptamos ambos.
  clienteId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tipo: z.enum(['deposito', 'retiro', 'compra_oro', 'venta_oro', 'ajuste']),
  // Importe en euros con 2 decimales como string, para no perder precision al parsear.
  importeEur: z.string().regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'Importe con formato "123.45"'),
  descripcion: z.string().trim().min(1).max(500),
});

/**
 * Alta de movimiento. Solo admin: es lo que mueve el saldo que ve el cliente,
 * asi que queda registrado quien lo hizo y cuando.
 */
router.post('/movimientos', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const datos = nuevoMovimiento.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const { clienteId, tipo, importeEur, descripcion } = datos.data;

    const resultado = await withTransaction(async (client) => {
      // Bloquea la fila del cliente para que dos retiros simultaneos no puedan
      // dejar el saldo en negativo cada uno creyendo que hay fondos.
      const cliente = await client.query('SELECT id FROM clientes WHERE id = $1 FOR UPDATE', [
        clienteId,
      ]);
      if (cliente.rows.length === 0) return { error: 404, mensaje: 'Cliente no encontrado' };

      if (tipo === 'retiro' || tipo === 'compra_oro') {
        const saldo = await client.query(
          'SELECT COALESCE(SUM(importe_eur), 0) AS saldo FROM movimientos WHERE cliente_id = $1',
          [clienteId]
        );
        // Comparamos en Postgres, no en JS, para respetar la aritmetica NUMERIC.
        const suficiente = await client.query('SELECT ($1::numeric + $2::numeric) >= 0 AS ok', [
          saldo.rows[0].saldo,
          importeEur,
        ]);
        if (!suficiente.rows[0].ok) return { error: 400, mensaje: 'Saldo insuficiente' };
      }

      const { rows } = await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe_eur, descripcion, creado_por)
         VALUES ($1, $2, $3::numeric, $4, $5)
         RETURNING id, cliente_id, tipo, importe_eur, descripcion, creado_en`,
        [clienteId, tipo, importeEur, descripcion, req.cliente.id]
      );
      return { movimiento: rows[0] };
    });

    if (resultado.error) return res.status(resultado.error).json({ error: resultado.mensaje });
    res.status(201).json(resultado.movimiento);
  } catch (err) {
    next(err);
  }
});
