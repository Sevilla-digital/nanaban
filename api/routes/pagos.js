import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requiereAdmin, requiereAuth } from '../auth.js';

export const router = Router();

// Minimo para recargar, en dolares. Tambien lo garantiza el CHECK de la tabla.
const MIN_RECARGA = 10;

const CAMPOS_METODO = `id, tipo, etiqueta, titular, numero_cuenta, moneda, red,
                       direccion, notas, activo, orden`;

// =================== Metodos de pago ===================

/** Cliente autenticado: solo los metodos activos. Los pinta la pantalla de recarga. */
router.get('/metodos', requiereAuth, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${CAMPOS_METODO} FROM metodos_pago WHERE activo = TRUE
       ORDER BY tipo, orden, id`
    );
    res.json({ metodos: rows });
  } catch (err) {
    next(err);
  }
});

/** Admin: todos, incluidos los inactivos, para gestionarlos desde el panel. */
router.get('/metodos/gestion', requiereAuth, requiereAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${CAMPOS_METODO} FROM metodos_pago ORDER BY tipo, orden, id`
    );
    res.json({ metodos: rows });
  } catch (err) {
    next(err);
  }
});

const banco = z.object({
  tipo: z.literal('banco'),
  etiqueta: z.string().trim().min(1).max(120),
  titular: z.string().trim().min(1).max(160),
  numero_cuenta: z.string().trim().min(1).max(80),
  moneda: z.string().trim().min(1).max(10),
  notas: z.string().trim().max(500).optional().default(''),
  activo: z.boolean().optional().default(true),
  orden: z.number().int().min(0).max(9999).optional().default(0),
});

const cripto = z.object({
  tipo: z.literal('cripto'),
  etiqueta: z.string().trim().min(1).max(120), // p. ej. "USDT"
  red: z.string().trim().min(1).max(60), // p. ej. "TRC20"
  direccion: z.string().trim().min(6).max(200),
  notas: z.string().trim().max(500).optional().default(''),
  activo: z.boolean().optional().default(true),
  orden: z.number().int().min(0).max(9999).optional().default(0),
});

const metodo = z.discriminatedUnion('tipo', [banco, cripto]);

// Aplana el objeto validado a los 10 valores de la fila, con null en los campos
// que no aplican al tipo. Un unico sitio donde decidir eso.
const valoresMetodo = (d) => [
  d.tipo,
  d.etiqueta,
  d.tipo === 'banco' ? d.titular : null,
  d.tipo === 'banco' ? d.numero_cuenta : null,
  d.tipo === 'banco' ? d.moneda : null,
  d.tipo === 'cripto' ? d.red : null,
  d.tipo === 'cripto' ? d.direccion : null,
  d.notas,
  d.activo,
  d.orden,
];

router.post('/metodos', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const datos = metodo.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const { rows } = await query(
      `INSERT INTO metodos_pago
         (tipo, etiqueta, titular, numero_cuenta, moneda, red, direccion, notas, activo, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${CAMPOS_METODO}`,
      valoresMetodo(datos.data)
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/metodos/:id', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const datos = metodo.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const { rows } = await query(
      `UPDATE metodos_pago SET
         tipo=$1, etiqueta=$2, titular=$3, numero_cuenta=$4, moneda=$5,
         red=$6, direccion=$7, notas=$8, activo=$9, orden=$10, actualizado_en=now()
       WHERE id=$11 RETURNING ${CAMPOS_METODO}`,
      [...valoresMetodo(datos.data), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Metodo no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/metodos/:id', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const { rowCount } = await query('DELETE FROM metodos_pago WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Metodo no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// =================== Recargas ===================

// Evita que un cliente inunde de solicitudes. 20 cada 15 min es de sobra para un uso real.
const limiteRecargas = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RECARGA_RATE_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de recarga. Prueba de nuevo en unos minutos.' },
});

const nuevaRecarga = z.object({
  metodoId: z.coerce.number().int().positive(),
  monto: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Monto con formato "100.00"'),
  referencia: z.string().trim().max(200).optional().default(''),
});

/** Cliente: registra una solicitud de recarga ("ya realice el pago"). */
router.post('/recargas', requiereAuth, limiteRecargas, async (req, res, next) => {
  try {
    const datos = nuevaRecarga.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const { metodoId, monto, referencia } = datos.data;
    if (Number(monto) < MIN_RECARGA) {
      return res.status(400).json({ error: `El mínimo para recargar es $${MIN_RECARGA}.` });
    }

    // El metodo debe existir y estar activo: no se registra un pago contra una cuenta
    // que el admin ya retiro.
    const m = await query(
      `SELECT ${CAMPOS_METODO} FROM metodos_pago WHERE id = $1 AND activo = TRUE`,
      [metodoId]
    );
    if (m.rows.length === 0) return res.status(400).json({ error: 'Método de pago no disponible' });
    const met = m.rows[0];
    const desc =
      met.tipo === 'banco'
        ? `${met.etiqueta} · ${met.numero_cuenta} (${met.moneda})`
        : `${met.etiqueta} · ${met.red} · ${met.direccion}`;

    const { rows } = await query(
      `INSERT INTO recargas (cliente_id, monto, metodo_id, metodo_desc, referencia)
       VALUES ($1, $2::numeric, $3, $4, $5)
       RETURNING id, monto, metodo_desc, estado, creada_en`,
      [req.cliente.id, monto, metodoId, desc, referencia]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/** Admin: listado de solicitudes, las pendientes primero. */
router.get('/recargas', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const estado = req.query.estado;
    const params = [];
    let where = '';
    if (['pendiente', 'confirmada', 'rechazada'].includes(estado)) {
      params.push(estado);
      where = 'WHERE r.estado = $1';
    }
    const { rows } = await query(
      `SELECT r.id, r.monto, r.metodo_desc, r.referencia, r.estado, r.creada_en, r.atendida_en,
              c.id AS cliente_id, c.nombre, c.apellido, c.usuario
       FROM recargas r
       JOIN clientes c ON c.id = r.cliente_id
       ${where}
       ORDER BY (r.estado = 'pendiente') DESC, r.creada_en DESC
       LIMIT 200`,
      params
    );
    res.json({ recargas: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Admin: confirma una recarga y abona el saldo. Crea un deposito por el monto y
 * enlaza recarga y movimiento. Idempotente: bloquea la fila y comprueba que siga
 * pendiente, para que dos confirmaciones simultaneas no abonen dos veces.
 */
router.post('/recargas/:id/confirmar', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });

    const resultado = await withTransaction(async (client) => {
      const r = await client.query('SELECT * FROM recargas WHERE id = $1 FOR UPDATE', [id]);
      if (r.rows.length === 0) return { error: 404, mensaje: 'Recarga no encontrada' };
      const recarga = r.rows[0];
      if (recarga.estado !== 'pendiente') {
        return { error: 409, mensaje: 'Esta recarga ya fue atendida' };
      }

      const mov = await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, creado_por)
         VALUES ($1, 'deposito', $2::numeric, $3, $4)
         RETURNING id, cliente_id, tipo, importe, descripcion, creado_en`,
        [recarga.cliente_id, recarga.monto, `Recarga confirmada · ${recarga.metodo_desc}`, req.cliente.id]
      );
      await client.query(
        `UPDATE recargas SET estado='confirmada', movimiento_id=$1, atendida_por=$2, atendida_en=now()
         WHERE id=$3`,
        [mov.rows[0].id, req.cliente.id, id]
      );
      return { movimiento: mov.rows[0] };
    });

    if (resultado.error) return res.status(resultado.error).json({ error: resultado.mensaje });
    res.status(201).json(resultado.movimiento);
  } catch (err) {
    next(err);
  }
});

/** Admin: rechaza una recarga pendiente (no abona nada). */
router.post('/recargas/:id/rechazar', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const { rows } = await query(
      `UPDATE recargas SET estado='rechazada', atendida_por=$1, atendida_en=now()
       WHERE id=$2 AND estado='pendiente'
       RETURNING id, estado`,
      [req.cliente.id, id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'La recarga no está pendiente' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
