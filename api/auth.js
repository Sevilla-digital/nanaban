import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';

const scrypt = promisify(scryptCb);

// Parametros de scrypt. N alto = mas caro de romper por fuerza bruta, pero tambien
// mas CPU y RAM por login. N=2^15 con r=8 consume ~34 MB por hash, asumible en el
// plan free de Render. Si algun dia se sube N, los hashes viejos siguen validos:
// cada hash guarda los parametros con los que se genero.
const N = 2 ** 15;
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;
const VALIDEZ_TOKEN = '7d';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET debe existir y tener al menos 32 caracteres. Generala con: openssl rand -hex 32'
  );
}

/** Devuelve "scrypt$N$r$p$salt$hash", todo lo necesario para verificar despues. */
export async function hashPassword(plano) {
  const salt = randomBytes(16);
  const hash = await scrypt(plano.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verificarPassword(plano, almacenado) {
  try {
    const [alg, nStr, rStr, pStr, saltHex, hashHex] = String(almacenado).split('$');
    if (alg !== 'scrypt') return false;

    const salt = Buffer.from(saltHex, 'hex');
    const esperado = Buffer.from(hashHex, 'hex');
    const calculado = await scrypt(plano.normalize('NFKC'), salt, esperado.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: MAXMEM,
    });
    // timingSafeEqual, no ===: comparar byte a byte filtra cuantos coinciden.
    return timingSafeEqual(calculado, esperado);
  } catch {
    return false;
  }
}

/** Hash valido de una contrasena imposible, para gastar tiempo en logins fallidos. */
export const HASH_SENUELO = await hashPassword(randomBytes(32).toString('hex'));

export const firmarToken = (cliente) =>
  jwt.sign({ sub: String(cliente.id), admin: cliente.es_admin === true }, process.env.JWT_SECRET, {
    expiresIn: VALIDEZ_TOKEN,
  });

/**
 * Normaliza el telefono a formato E.164 para que "600 11 22 33", "600112233"
 * y "+34600112233" sean el mismo cliente y el UNIQUE de la tabla funcione.
 */
export function normalizarTelefono(entrada) {
  const limpio = String(entrada).replace(/[\s.\-()]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(limpio)) return limpio;
  // Sin prefijo internacional asumimos Espana (9 digitos).
  if (/^[6-9]\d{8}$/.test(limpio)) return `+34${limpio}`;
  return null;
}

/** Exige un token valido. Deja el cliente en req.cliente. */
export function requiereAuth(req, res, next) {
  const cabecera = req.get('authorization') ?? '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de sesion' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.cliente = { id: Number(payload.sub), esAdmin: payload.admin === true };
    next();
  } catch {
    res.status(401).json({ error: 'Sesion invalida o caducada' });
  }
}

export function requiereAdmin(req, res, next) {
  if (!req.cliente?.esAdmin) return res.status(403).json({ error: 'Solo administradores' });
  next();
}
