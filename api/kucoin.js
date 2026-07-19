import { createHmac } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { confirmarRecargaEnTx } from './routes/pagos.js';

// Auto-confirmacion de recargas cripto contra la API de KuCoin.
//
// Como todos los clientes pagan USDT (BEP20) a la MISMA direccion de deposito,
// la identidad del pago es su MONTO EXACTO: cada recarga cripto reserva un monto
// unico (ver /recargas/iniciar). Aqui se consultan los depositos acreditados en
// KuCoin y, si uno coincide al centavo con una recarga pendiente, se confirma
// automaticamente (deposito + regalia + comisiones de referidos, igual que si
// la confirmara el admin).
//
// Las claves NUNCA viven en el repo: solo en variables de entorno (Render >
// Environment). La API key de KuCoin debe tener SOLO permiso "General"
// (lectura); sin retiros ni trading.

const BASE = 'https://api.kucoin.com';

function credenciales() {
  const { KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE } = process.env;
  if (!KUCOIN_API_KEY || !KUCOIN_API_SECRET || !KUCOIN_API_PASSPHRASE) return null;
  return { key: KUCOIN_API_KEY, secret: KUCOIN_API_SECRET, passphrase: KUCOIN_API_PASSPHRASE };
}

export const kucoinConfigurado = () => credenciales() !== null;

/** GET firmado (esquema v2 de KuCoin: firma y passphrase en HMAC-SHA256 base64). */
async function kucoinGet(rutaConQuery) {
  const c = credenciales();
  const ts = Date.now().toString();
  const firma = createHmac('sha256', c.secret).update(ts + 'GET' + rutaConQuery).digest('base64');
  const passFirmada = createHmac('sha256', c.secret).update(c.passphrase).digest('base64');

  const resp = await fetch(BASE + rutaConQuery, {
    headers: {
      'KC-API-KEY': c.key,
      'KC-API-SIGN': firma,
      'KC-API-TIMESTAMP': ts,
      'KC-API-PASSPHRASE': passFirmada,
      'KC-API-KEY-VERSION': '2',
    },
  });
  const datos = await resp.json().catch(() => null);
  if (!resp.ok || datos?.code !== '200000') {
    throw new Error(`KuCoin ${resp.status}: ${datos?.msg ?? 'respuesta invalida'}`);
  }
  return datos.data;
}

/**
 * Revisa los depositos USDT acreditados en KuCoin (ultimas 48h) y confirma las
 * recargas pendientes cuyo monto esperado coincide al centavo. Un deposito solo
 * puede confirmar una recarga (indice unico sobre tx_id).
 */
export async function revisarDepositosKuCoin() {
  if (!kucoinConfigurado()) return;
  const desde = Date.now() - 48 * 3600 * 1000;
  const data = await kucoinGet(`/api/v1/deposits?currency=USDT&status=SUCCESS&startAt=${desde}&pageSize=50`);
  for (const dep of data?.items ?? []) {
    try {
      await procesarDeposito(dep);
    } catch (e) {
      console.error('[KUCOIN] Error procesando deposito', dep?.walletTxId, '-', e.message);
    }
  }
}

async function procesarDeposito(dep) {
  if (dep.isInner) return; // transferencias internas de KuCoin, no pagos de clientes
  const chain = String(dep.chain ?? '').toLowerCase();
  if (chain && !/bsc|bep/.test(chain)) return; // solo la red BEP20 (BSC)
  const txId = dep.walletTxId || null;
  if (!txId) return;
  const cents = Math.round(Number(dep.amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return;

  // ¿Este deposito ya confirmo una recarga?
  const ya = await query('SELECT 1 FROM recargas WHERE tx_id = $1', [txId]);
  if (ya.rows.length > 0) return;

  // El monto exacto identifica la recarga. El indice unico de pendientes
  // garantiza que hay como mucho una candidata.
  const cand = await query(
    `SELECT id FROM recargas
     WHERE estado = 'pendiente' AND tx_id IS NULL AND monto_esperado IS NOT NULL
       AND ROUND(monto_esperado * 100) = $1
       AND creada_en > now() - interval '48 hours'`,
    [cents]
  );
  if (cand.rows.length !== 1) return; // sin coincidencia exacta: lo resuelve el admin

  const resultado = await withTransaction((client) =>
    confirmarRecargaEnTx(client, cand.rows[0].id, null, {
      txId,
      nota: `Pago detectado automáticamente en KuCoin (USDT · BEP20) · tx ${txId}`,
    })
  );
  if (resultado.error) {
    console.warn(`[KUCOIN] Recarga #${cand.rows[0].id} no confirmada: ${resultado.mensaje}`);
  } else {
    console.log(`[KUCOIN] Recarga #${cand.rows[0].id} confirmada automaticamente ($${(cents / 100).toFixed(2)}, tx ${txId})`);
  }
}
