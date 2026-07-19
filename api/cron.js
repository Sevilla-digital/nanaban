import cron from 'node-cron';
import { pool } from './db.js';
import { kucoinConfigurado, revisarDepositosKuCoin } from './kucoin.js';

const PORCENTAJES = {
  '10 Kilates': 0.012, // 1.2%
  '14 Kilates': 0.014, // 1.4%
  '18 Kilates': 0.018, // 1.8%
  '22 Kilates': 0.020, // 2.0%
  '24 Kilates': 0.024, // 2.4%
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

    // Obtener todas las inversiones abiertas
    const { rows: inversionesAbiertas } = await client.query(
      "SELECT id, cliente_id, importe, plan FROM inversiones WHERE estado = 'abierta'"
    );

    if (inversionesAbiertas.length === 0) {
      console.log('[CRON] No hay inversiones abiertas en este momento.');
      await client.query('ROLLBACK');
      return;
    }

    let pagosRealizados = 0;

    for (const inv of inversionesAbiertas) {
      const porcentaje = PORCENTAJES[inv.plan];
      if (!porcentaje) {
        console.warn(`[CRON] Plan desconocido: ${inv.plan} en inversión ID: ${inv.id}`);
        continue;
      }

      // Calcular ganancia del dia
      const importeInversion = parseFloat(inv.importe);
      const ganancia = (importeInversion * porcentaje).toFixed(2);
      
      const descripcion = `Ganancia diaria - ${inv.plan} (${(porcentaje * 100).toFixed(1)}%)`;

      // Registrar la ganancia en la tabla movimientos
      await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, inversion_id)
         VALUES ($1, 'deposito', $2, $3, $4)`,
        [inv.cliente_id, ganancia, descripcion, inv.id]
      );
      
      pagosRealizados++;
    }

    await client.query('COMMIT');
    console.log(`[CRON] Proceso completado exitosamente. Se realizaron ${pagosRealizados} pagos.`);
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
