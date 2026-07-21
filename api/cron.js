import cron from 'node-cron';
import { pool } from './db.js';
import { kucoinConfigurado, revisarDepositosKuCoin } from './kucoin.js';

// Rentabilidad diaria de cada plan (se paga solo en dias habiles L-V).
const PORCENTAJES = {
  '10 Kilates': 0.0455, // 4.55%
  '14 Kilates': 0.0303, // 3.03%
  '18 Kilates': 0.0181, // 1.81%
  '22 Kilates': 0.0151, // 1.51%
  '24 Kilates': 0.0076, // 0.76%
};

// Numero de pagos (dias habiles) de cada plan. Al llegar a este tope la inversion
// se cierra: %diario x diasPago da ~200%, o sea el capital duplicado.
const DIAS_PAGO = {
  '10 Kilates': 44,  // 2 meses
  '14 Kilates': 66,  // 3 meses
  '18 Kilates': 110, // 5 meses
  '22 Kilates': 132, // 6 meses
  '24 Kilates': 264, // 12 meses
};

/**
 * Función que se encarga de pagar las ganancias diarias a todas
 * las inversiones que se encuentren "abiertas".
 */
export async function procesarPagosDiarios() {
  console.log('[CRON] Iniciando proceso de pagos de ganancias diarias...');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Inversiones abiertas con sus ganancias acumuladas
    const { rows: inversionesAbiertas } = await client.query(
      "SELECT id, cliente_id, importe, plan, pagos_realizados, ganancias_acumuladas, tope_ganancias FROM inversiones WHERE estado = 'abierta'"
    );

    if (inversionesAbiertas.length === 0) {
      console.log('[CRON] No hay inversiones abiertas en este momento.');
      await client.query('ROLLBACK');
      return;
    }

    let pagosRealizados = 0;
    let cerradas = 0;

    for (const inv of inversionesAbiertas) {
      const porcentaje = PORCENTAJES[inv.plan];
      if (!porcentaje || inv.tope_ganancias <= 0) {
        console.warn(`[CRON] Plan desconocido o tope inválido: ${inv.plan} en inversión ID: ${inv.id}`);
        continue;
      }

      // Ya alcanzó su tope: se cierra sin pagar mas (ya duplico el capital).
      if (Number(inv.ganancias_acumuladas) >= Number(inv.tope_ganancias)) {
        await client.query(
          "UPDATE inversiones SET estado = 'cerrada', cerrada_en = now() WHERE id = $1 AND estado = 'abierta'",
          [inv.id]
        );
        cerradas++;
        continue;
      }

      // Pago del dia
      const ganancia = (parseFloat(inv.importe) * porcentaje).toFixed(2);
      const descripcion = `Ganancia diaria - ${inv.plan} (${(porcentaje * 100).toFixed(2)}%)`;
      await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, inversion_id)
         VALUES ($1, 'deposito', $2, $3, $4)`,
        [inv.cliente_id, ganancia, descripcion, inv.id]
      );
      pagosRealizados++;

      // Sumar al acumulado y chequear si con este pago se termina el contrato
      const nuevoTotal = Number(inv.ganancias_acumuladas) + Number(ganancia);
      const nuevosPagos = inv.pagos_realizados + 1;
      if (nuevoTotal >= Number(inv.tope_ganancias)) {
        await client.query(
          "UPDATE inversiones SET pagos_realizados = $1, ganancias_acumuladas = $2, estado = 'cerrada', cerrada_en = now() WHERE id = $3",
          [nuevosPagos, nuevoTotal, inv.id]
        );
        cerradas++;
      } else {
        await client.query('UPDATE inversiones SET pagos_realizados = $1, ganancias_acumuladas = $2 WHERE id = $3', [nuevosPagos, nuevoTotal, inv.id]);
      }
    }

    await client.query('COMMIT');
    console.log(`[CRON] Proceso completado. Pagos: ${pagosRealizados}. Inversiones cerradas (duplicadas): ${cerradas}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[CRON] Error al procesar los pagos diarios:', error);
  } finally {
    client.release();
  }
}

/**
 * Configurar e iniciar el cron job.
 * Se ejecutará de Lunes (1) a Viernes (5) a las 20:00 (8:00 PM)
 * en el huso horario de Centroamérica (America/Managua o America/Costa_Rica).
 */
export function iniciarCron() {
  // '0 20 * * 1-5' => A las 20:00, cada día de la semana de lunes a viernes.
  cron.schedule('0 20 * * 1-5', () => {
    procesarPagosDiarios();
  }, {
    scheduled: true,
    timezone: "America/Managua"
  });
  
  console.log('[CRON] Tarea programada iniciada: Pagos diarios a las 8:00 PM CST (L-V)');

  // Auto-confirmacion de recargas cripto: revisa los depositos de KuCoin cada
  // 2 minutos. Si faltan las claves (Render > Environment), queda desactivada y
  // el flujo manual del admin sigue funcionando igual.
  if (kucoinConfigurado()) {
    cron.schedule('*/2 * * * *', () => {
      revisarDepositosKuCoin().catch((e) => console.error('[KUCOIN]', e.message));
    });
    console.log('[CRON] Auto-confirmacion de recargas cripto (KuCoin): ACTIVA, cada 2 minutos');
  } else {
    console.log('[CRON] Auto-confirmacion KuCoin desactivada: faltan KUCOIN_API_KEY / KUCOIN_API_SECRET / KUCOIN_API_PASSPHRASE');
  }
}
