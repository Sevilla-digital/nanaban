import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requiereAuth, requiereAdmin } from '../auth.js';

export const router = Router();

// =================== Métodos de Retiro (Cliente) ===================

/** Obtener métodos de retiro del cliente autenticado */
router.get('/metodos', requiereAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tipo, banco_nombre, titular, numero_cuenta, cripto_red, cripto_direccion, telefono_movil, creado_en
       FROM metodos_retiro_cliente
       WHERE cliente_id = $1 AND activo = TRUE
       ORDER BY creado_en DESC`,
      [req.cliente.id]
    );
    res.json({ metodos: rows });
  } catch (err) {
    next(err);
  }
});

const nuevoMetodoEsquema = z.object({
  tipo: z.enum(['banco', 'movil', 'cripto']),
  banco_nombre: z.string().trim().optional(),
  titular: z.string().trim().min(3).max(100).optional(),
  numero_cuenta: z.string().trim().min(5).max(50).optional(),
  cripto_red: z.string().trim().optional(),
  cripto_direccion: z.string().trim().optional(),
  telefono_movil: z.string().trim().optional()
});

/** Agregar un nuevo método de retiro */
router.post('/metodos', requiereAuth, async (req, res, next) => {
  try {
    const d = nuevoMetodoEsquema.parse(req.body);
    
    // Validación según el tipo
    if (d.tipo === 'banco' && (!d.banco_nombre || !d.titular || !d.numero_cuenta)) {
      return res.status(400).json({ error: 'Faltan datos del banco' });
    }
    if (d.tipo === 'movil' && (!d.banco_nombre || !d.titular || !d.telefono_movil)) {
      return res.status(400).json({ error: 'Faltan datos de la billetera móvil' });
    }
    if (d.tipo === 'cripto' && (!d.cripto_red || !d.cripto_direccion)) {
      return res.status(400).json({ error: 'Faltan datos de criptomoneda' });
    }

    const { rows } = await query(
      `INSERT INTO metodos_retiro_cliente 
       (cliente_id, tipo, banco_nombre, titular, numero_cuenta, cripto_red, cripto_direccion, telefono_movil)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [req.cliente.id, d.tipo, d.banco_nombre, d.titular, d.numero_cuenta, d.cripto_red, d.cripto_direccion, d.telefono_movil]
    );
    res.status(201).json({ id: rows[0].id, mensaje: 'Método agregado' });
  } catch (err) {
    next(err);
  }
});

// =================== Retiros (Cliente) ===================

const solicitarRetiroEsquema = z.object({
  monto: z.number().positive().min(30),
  metodo_retiro_id: z.number().int().positive()
});

/** Solicitar un retiro */
router.post('/', requiereAuth, async (req, res, next) => {
  try {
    const d = solicitarRetiroEsquema.parse(req.body);
    const COMISION_PCT = 0.05; // 5%
    const comision = d.monto * COMISION_PCT;
    const total_recibir = d.monto - comision;

    await withTransaction(async (client) => {
      // 1. Validar método de retiro
      const mrc = await client.query(
        `SELECT id FROM metodos_retiro_cliente WHERE id = $1 AND cliente_id = $2 AND activo = TRUE`,
        [d.metodo_retiro_id, req.cliente.id]
      );
      if (mrc.rowCount === 0) throw new Error('Método de retiro inválido o inactivo');

      // 2. Verificar saldo
      const saldos = await client.query(
        `SELECT saldo FROM saldos WHERE cliente_id = $1`,
        [req.cliente.id]
      );
      const saldo = saldos.rows[0]?.saldo || 0;
      if (Number(saldo) < d.monto) throw new Error('Saldo insuficiente');

      // 3. Crear solicitud de retiro
      const { rows } = await client.query(
        `INSERT INTO retiros (cliente_id, metodo_retiro_id, monto, comision, total_recibir, estado)
         VALUES ($1, $2, $3, $4, $5, 'pendiente')
         RETURNING id`,
        [req.cliente.id, d.metodo_retiro_id, d.monto, comision, total_recibir]
      );
      const retiro_id = rows[0].id;

      // 4. Crear movimiento de tipo 'retiro' para descontar el saldo inmediatamente
      await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, retiro_id, creado_por)
         VALUES ($1, 'retiro', $2, $3, $4, $1)`,
        [req.cliente.id, -d.monto, 'Solicitud de retiro', retiro_id]
      );
    });

    res.status(201).json({ mensaje: 'Retiro solicitado. Procesamiento en 24h.' });
  } catch (err) {
    if (err.message === 'Saldo insuficiente' || err.message === 'Método de retiro inválido o inactivo') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// =================== Retiros (Admin) ===================

/** Obtener lista de retiros (Admin) */
router.get('/admin/lista', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.monto, r.comision, r.total_recibir, r.estado, r.creado_en,
              c.nombre, c.apellido, c.usuario, c.telefono,
              mrc.tipo AS metodo_tipo, mrc.banco_nombre, mrc.titular, mrc.numero_cuenta, 
              mrc.cripto_red, mrc.cripto_direccion, mrc.telefono_movil
       FROM retiros r
       JOIN clientes c ON r.cliente_id = c.id
       JOIN metodos_retiro_cliente mrc ON r.metodo_retiro_id = mrc.id
       ORDER BY r.creado_en DESC LIMIT 100`
    );
    res.json({ retiros: rows });
  } catch (err) {
    next(err);
  }
});

const procesarRetiroEsquema = z.object({
  accion: z.enum(['completar', 'rechazar'])
});

/** Procesar retiro (Admin) */
router.post('/admin/:id/procesar', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const retiroId = Number(req.params.id);
    const { accion } = procesarRetiroEsquema.parse(req.body);
    
    await withTransaction(async (client) => {
      // Bloquear la fila del retiro para concurrencia
      const { rows } = await client.query(
        `SELECT id, cliente_id, monto, estado FROM retiros WHERE id = $1 FOR UPDATE`,
        [retiroId]
      );
      if (rows.length === 0) throw new Error('Retiro no encontrado');
      
      const r = rows[0];
      if (r.estado !== 'pendiente') throw new Error('El retiro ya fue procesado');

      if (accion === 'completar') {
        // Actualizar el estado del retiro a completado
        await client.query(
          `UPDATE retiros SET estado = 'completado', procesado_en = now(), procesado_por = $1 WHERE id = $2`,
          [req.cliente.id, retiroId]
        );
      } else if (accion === 'rechazar') {
        // Actualizar el estado del retiro
        await client.query(
          `UPDATE retiros SET estado = 'rechazado', procesado_en = now(), procesado_por = $1 WHERE id = $2`,
          [req.cliente.id, retiroId]
        );
        
        // Reembolsar el dinero descontado previamente
        await client.query(
          `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, retiro_id, creado_por)
           VALUES ($1, 'ajuste', $2, 'Reembolso por retiro rechazado', $3, $4)`,
          [r.cliente_id, r.monto, retiroId, req.cliente.id]
        );
      }
    });

    res.json({ mensaje: 'Retiro procesado correctamente' });
  } catch (err) {
    if (err.message === 'Retiro no encontrado' || err.message === 'El retiro ya fue procesado') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});
