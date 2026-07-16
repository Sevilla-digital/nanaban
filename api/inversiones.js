import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { requiereAuth } from '../auth.js';

export const router = Router();

// Precio del oro por gramo (placeholder). En un sistema real, esto vendría de
// una API externa y se actualizaría periódicamente.
const PRECIO_ORO_GRAMO = 75.0;

const nuevaInversionSchema = z.object({
  plan: z.enum(['10 Kilates', '14 Kilates', '18 Kilates', '22 Kilates', '24 Kilates']),
  importe: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Importe con formato "100.00"'),
});

/**
 * Cliente: Crea una nueva inversión.
 * 1. Valida que el cliente tenga saldo suficiente.
 * 2. Crea la fila en la tabla `inversiones`.
 * 3. Crea el movimiento de 'compra_oro' que descuenta el saldo.
 * Todo esto ocurre en una transacción para garantizar la consistencia.
 */
router.post('/', requiereAuth, async (req, res, next) => {
  try {
    const datos = nuevaInversionSchema.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos inválidos', detalle: datos.error.flatten() });
    }

    const { plan, importe } = datos.data;
    const importeNum = Number(importe);
    const clienteId = req.cliente.id;

    if (importeNum <= 0) {
      return res.status(400).json({ error: 'El importe debe ser mayor a cero.' });
    }

    const resultado = await withTransaction(async (client) => {
      // 1. Comprobar saldo del cliente
      const { rows: saldos } = await client.query('SELECT saldo FROM saldos WHERE cliente_id = $1', [clienteId]);
      const saldoActual = Number(saldos[0]?.saldo ?? 0);

      if (saldoActual < importeNum) {
        return { error: 400, mensaje: 'Fondos insuficientes para realizar esta inversión.' };
      }

      // 2. Calcular gramos y crear la inversión
      const gramosOro = (importeNum / PRECIO_ORO_GRAMO).toFixed(4);
      const inv = await client.query(
        `INSERT INTO inversiones (cliente_id, gramos_oro, importe, plan)
         VALUES ($1, $2, $3, $4)
         RETURNING id, gramos_oro, importe, plan, abierta_en`,
        [clienteId, gramosOro, importe, plan]
      );
      const inversionCreada = inv.rows[0];

      // 3. Crear el movimiento de débito ('compra_oro')
      await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, inversion_id, creado_por)
         VALUES ($1, 'compra_oro', $2, $3, $4, $5)`,
        [clienteId, -importeNum, `Inversión en ${plan}`, inversionCreada.id, clienteId]
      );

      return { inversion: inversionCreada };
    });

    if (resultado.error) {
      return res.status(resultado.error).json({ error: resultado.mensaje });
    }

    res.status(201).json(resultado.inversion);
  } catch (err) {
    next(err);
  }
});