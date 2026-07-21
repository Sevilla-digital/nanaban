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
import { enviarEmail, mailerConfigurado } from '../mailer.js';

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
  ref: z.string().trim().max(30).optional(),
});

// Hitos del programa de afiliacion: al llegar a N referidos directos se regala el
// premio, una sola vez por hito (lo garantiza el UNIQUE de recompensas_afiliacion).
const HITOS_AFILIACION = [
  [20, 100],
  [50, 200],
  [100, 1000],
];

/**
 * Comprueba si el referidor alcanzo un hito del programa de afiliacion y, si es
 * asi, abona el premio como movimiento ("Recompensa del programa de afiliacion").
 * Idempotente: el INSERT ... ON CONFLICT DO NOTHING evita pagar dos veces.
 */
async function otorgarRecompensasAfiliacion(clienteId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM clientes WHERE referido_por = $1',
      [clienteId]
    );
    const n = rows[0].n;
    for (const [hito, premio] of HITOS_AFILIACION) {
      if (n < hito) continue;
      const r = await client.query(
        `INSERT INTO recompensas_afiliacion (cliente_id, hito, premio)
         VALUES ($1, $2, $3)
         ON CONFLICT (cliente_id, hito) DO NOTHING
         RETURNING id`,
        [clienteId, hito, premio]
      );
      if (r.rows.length > 0) {
        await client.query(
          `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, creado_por)
           VALUES ($1, 'comision_referido', $2::numeric, $3, $1)`,
          [clienteId, premio, `Recompensa del programa de afiliación (${hito} referidos)`]
        );
      }
    }
  });
}

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
    
    let referidoPorId = null;
    if (datos.data.ref) {
      const refRes = await query('SELECT id FROM clientes WHERE usuario = $1', [datos.data.ref.toLowerCase()]);
      if (refRes.rows.length > 0) {
        referidoPorId = refRes.rows[0].id;
      }
    }

    const { rows } = await query(
      `INSERT INTO clientes (nombre, apellido, usuario, telefono, password_hash, referido_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nombre, apellido, usuario, telefono, es_admin, creado_en`,
      [datos.data.nombre, datos.data.apellido, usuario, telefono, hash, referidoPorId]
    );

    // Programa de afiliacion: el nuevo registro puede hacer que su referidor
    // alcance un hito (20/50/100). Nunca debe tumbar el registro si falla.
    if (referidoPorId) {
      try {
        await otorgarRecompensasAfiliacion(referidoPorId);
      } catch (e) {
        console.error('Recompensa de afiliacion fallida (se reintentara con el proximo registro):', e);
      }
    }

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
      `SELECT id, nombre, apellido, usuario, telefono, password_hash, es_admin, activo, ban_razon
       FROM clientes WHERE usuario = $1`,
      [datos.data.usuario.toLowerCase()]
    );
    const cliente = rows[0];

    // Comparamos siempre contra un hash aunque el cliente no exista, para que el tiempo
    // de respuesta no revele que usuarios estan registrados.
    const ok = await verificarPassword(datos.data.password, cliente?.password_hash ?? HASH_SENUELO);

    if (!cliente || !ok) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    if (!cliente.activo) {
      // Cuenta baneada: se devuelve la razon que escribio el admin para que el
      // cliente la vea en la pantalla de "Cuenta baneada".
      return res.status(403).json({ error: 'Cuenta baneada', baneado: true, razon: cliente.ban_razon || '' });
    }

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

// ---------- Olvide mi contrasena ----------

const olvideVerificarSchema = z.object({
  usuario: z.string().trim().min(1).max(60),
  telefono: z.string().min(6).max(25),
});

const olvideSchema = olvideVerificarSchema.extend({
  password: z.string().min(8, 'La contrasena debe tener al menos 8 caracteres').max(200),
  email: z.string().trim().toLowerCase().email('Correo no valido').max(160).optional(),
});

/** Busca al cliente por usuario y exige que el telefono guardado coincida. */
async function buscarClienteOlvide(usuarioRaw, telefonoRaw) {
  const telefono = normalizarTelefono(telefonoRaw);
  if (!telefono) return null;
  const { rows } = await query(
    'SELECT id, nombre, usuario, telefono, email, activo FROM clientes WHERE usuario = $1',
    [usuarioRaw.toLowerCase()]
  );
  const c = rows[0];
  if (!c || c.telefono !== telefono) return null;
  return c;
}

/**
 * Paso 1 del "olvide mi contrasena": valida usuario + telefono y dice si la
 * cuenta tiene correo (el paso 2 se lo pedira como verificacion extra).
 */
router.post('/password/olvide/verificar', limiteAuth, async (req, res, next) => {
  try {
    const datos = olvideVerificarSchema.safeParse(req.body);
    if (!datos.success) return res.status(400).json({ error: 'Datos invalidos' });
    const c = await buscarClienteOlvide(datos.data.usuario, datos.data.telefono);
    if (!c) return res.status(400).json({ error: 'Los datos no coinciden con ninguna cuenta.' });
    if (!c.activo) return res.status(403).json({ error: 'Esta cuenta está suspendida. Contacta con soporte.' });
    res.json({ ok: true, requiere_email: !!c.email });
  } catch (err) {
    next(err);
  }
});

/**
 * Paso 2: registra la solicitud con la nueva contrasena elegida.
 * - Cuenta CON correo: el correo escrito debe coincidir con el guardado. Con SMTP
 *   configurado se aplica al momento y la confirmacion (con la nueva contrasena)
 *   llega a su bandeja. Sin SMTP, cae al camino del supervisor.
 * - Cuenta SIN correo: queda 'pendiente' hasta que un supervisor la apruebe en el
 *   panel de admin. Solo se guarda el HASH de la nueva contrasena, nunca en claro.
 */
router.post('/password/olvide', limiteAuth, async (req, res, next) => {
  try {
    const datos = olvideSchema.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: datos.error.issues?.[0]?.message ?? 'Datos invalidos' });
    }
    const c = await buscarClienteOlvide(datos.data.usuario, datos.data.telefono);
    if (!c) return res.status(400).json({ error: 'Los datos no coinciden con ninguna cuenta.' });
    if (!c.activo) return res.status(403).json({ error: 'Esta cuenta está suspendida. Contacta con soporte.' });

    if (c.email && (!datos.data.email || datos.data.email !== String(c.email).toLowerCase())) {
      return res.status(400).json({ error: 'El correo no coincide con el registrado en la cuenta.' });
    }

    const hash = await hashPassword(datos.data.password);

    if (c.email && mailerConfigurado()) {
      // Identidad verificada por correo: se aplica al momento y se le notifica.
      await withTransaction(async (client) => {
        await client.query('UPDATE clientes SET password_hash = $1 WHERE id = $2', [hash, c.id]);
        await client.query(
          `UPDATE solicitudes_password SET estado = 'rechazada', atendida_en = now()
           WHERE cliente_id = $1 AND estado = 'pendiente'`,
          [c.id]
        );
        await client.query(
          `INSERT INTO solicitudes_password (cliente_id, password_hash, via, estado, atendida_en)
           VALUES ($1, $2, 'email', 'aprobada', now())`,
          [c.id, hash]
        );
      });
      try {
        await enviarEmail({
          para: c.email,
          asunto: 'Tu contraseña ha sido restablecida · Gold Corp Financial',
          texto:
            `Hola ${c.nombre},\n\n` +
            `Tu contraseña se restableció correctamente tras verificar tu correo.\n\n` +
            `Tu nueva contraseña es: ${datos.data.password}\n\n` +
            `Guárdala en un lugar seguro. Si no fuiste tú, escríbenos de inmediato a support@goldcorp.online.\n\n` +
            `— Gold Corp Financial`,
        });
      } catch (e) {
        // El cambio ya se aplico; el correo es informativo. Se registra y seguimos.
        console.error('Fallo el correo de restablecimiento:', e.message);
      }
      return res.json({
        via: 'email',
        mensaje: 'Listo: tu contraseña fue restablecida. Revisa tu bandeja de entrada, te enviamos la confirmación con tu nueva contraseña.',
      });
    }

    // Sin correo (o sin SMTP): pendiente de aprobacion del supervisor.
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE solicitudes_password SET estado = 'rechazada', atendida_en = now()
         WHERE cliente_id = $1 AND estado = 'pendiente'`,
        [c.id]
      );
      await client.query(
        'INSERT INTO solicitudes_password (cliente_id, password_hash) VALUES ($1, $2)',
        [c.id, hash]
      );
    });
    res.json({
      via: 'supervisor',
      mensaje: 'Solicitud recibida. Un supervisor la aprobará en unos minutos y podrás entrar con tu nueva contraseña.',
    });
  } catch (err) {
    next(err);
  }
});

/** Admin: solicitudes de restablecimiento, pendientes primero. */
router.get('/password/solicitudes', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.via, s.estado, s.creada_en, s.atendida_en,
              c.id AS cliente_id, c.nombre, c.apellido, c.usuario, c.telefono, c.email
       FROM solicitudes_password s
       JOIN clientes c ON c.id = s.cliente_id
       ORDER BY (s.estado = 'pendiente') DESC, s.creada_en DESC
       LIMIT 100`
    );
    res.json({ solicitudes: rows });
  } catch (err) {
    next(err);
  }
});

/** Admin: aprueba una solicitud pendiente (aplica la nueva contrasena). */
router.post('/password/solicitudes/:id/aprobar', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });

    const resultado = await withTransaction(async (client) => {
      const r = await client.query('SELECT * FROM solicitudes_password WHERE id = $1 FOR UPDATE', [id]);
      if (r.rows.length === 0) return { error: 404, mensaje: 'Solicitud no encontrada' };
      const s = r.rows[0];
      if (s.estado !== 'pendiente') return { error: 409, mensaje: 'Esta solicitud ya fue atendida' };

      await client.query('UPDATE clientes SET password_hash = $1 WHERE id = $2', [s.password_hash, s.cliente_id]);
      await client.query(
        `UPDATE solicitudes_password SET estado = 'aprobada', atendida_por = $1, atendida_en = now() WHERE id = $2`,
        [req.cliente.id, id]
      );
      return { ok: true };
    });

    if (resultado.error) return res.status(resultado.error).json({ error: resultado.mensaje });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Admin: rechaza una solicitud pendiente (la contrasena no cambia). */
router.post('/password/solicitudes/:id/rechazar', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const { rows } = await query(
      `UPDATE solicitudes_password SET estado = 'rechazada', atendida_por = $1, atendida_en = now()
       WHERE id = $2 AND estado = 'pendiente'
       RETURNING id, estado`,
      [req.cliente.id, id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'La solicitud no está pendiente' });
    res.json(rows[0]);
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
      `SELECT c.id, c.nombre, c.apellido, c.usuario, c.telefono, c.avatar, c.email, c.es_admin, c.premium,
              c.activo, c.ban_razon, c.creado_en, s.saldo,
              (EXISTS (SELECT 1 FROM recargas r WHERE r.cliente_id = c.id AND r.estado = 'confirmada')
               OR EXISTS (SELECT 1 FROM movimientos m WHERE m.cliente_id = c.id AND m.tipo = 'deposito')
              ) AS ha_recargado
       FROM clientes c
       JOIN saldos s ON s.cliente_id = c.id
       WHERE c.id = $1`,
      [req.cliente.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (rows[0].activo === false) {
      // Baneado con la sesion abierta: el panel lo detecta (sondea /me) y muestra
      // la pantalla de cuenta baneada con la razon.
      return res.status(403).json({ error: 'Cuenta baneada', baneado: true, razon: rows[0].ban_razon || '' });
    }

    const inversiones = await query(
      `SELECT id, gramos_oro, importe, plan, estado, abierta_en, cerrada_en,
              rentabilidad_diaria, plazo_dias, ganancias_acumuladas, tope_ganancias,
              (abierta_en + (plazo_dias || ' days')::interval) AS vencimiento
       FROM inversiones WHERE cliente_id = $1 ORDER BY abierta_en DESC`,
      [req.cliente.id]
    );

    res.json({ ...rows[0], inversiones: inversiones.rows });
  } catch (err) {
    next(err);
  }
});

// El cliente solo puede cambiar su nombre, apellido y foto. El usuario y el telefono
// son credenciales institucionales: se validan aparte y no se editan desde aqui.
const actualizarPerfilSchema = z.object({
  nombre: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
  apellido: z.string().trim().max(120).optional().default(''),
  // Foto como data URL (o null para quitarla). Se acota el tamaño; el cliente ya
  // redimensiona antes de enviar, esto es solo un tope de seguridad (~1.5MB).
  avatar: z
    .string()
    .regex(/^data:image\/(png|jpe?g|gif|webp);base64,/, 'Formato de imagen no valido')
    .max(1_500_000, 'La imagen es demasiado grande')
    .nullable()
    .optional(),
  // Correo del cliente ('' = quitarlo). Se usa para verificar su identidad al
  // restablecer la contrasena.
  email: z.union([z.string().trim().toLowerCase().email('Correo no valido').max(160), z.literal('')]).optional(),
});

router.patch('/me', requiereAuth, async (req, res, next) => {
  try {
    const datos = actualizarPerfilSchema.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const { nombre, apellido } = datos.data;

    // Solo tocamos el avatar/email si vinieron en la peticion: asi un guardado
    // parcial no borra la foto o el correo por accidente.
    const tocarAvatar = Object.prototype.hasOwnProperty.call(req.body, 'avatar');
    const tocarEmail = Object.prototype.hasOwnProperty.call(req.body, 'email');

    const sets = ['nombre = $1', 'apellido = $2'];
    const params = [nombre, apellido];
    if (tocarAvatar) { params.push(datos.data.avatar ?? null); sets.push(`avatar = $${params.length}`); }
    if (tocarEmail) { params.push(datos.data.email || null); sets.push(`email = $${params.length}`); }
    params.push(req.cliente.id);

    const { rows } = await query(
      `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, nombre, apellido, usuario, telefono, avatar, email`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/me/movimientos', requiereAuth, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const { rows } = await query(
      `SELECT m.id, m.tipo, m.importe, m.descripcion, m.inversion_id, m.creado_en, r.estado AS retiro_estado
       FROM movimientos m
       LEFT JOIN retiros r ON m.retiro_id = r.id
       WHERE m.cliente_id = $1
       ORDER BY m.creado_en DESC, m.id DESC
       LIMIT $2`,
      [req.cliente.id, limite]
    );
    res.json({ movimientos: rows });
  } catch (err) {
    next(err);
  }
});

/** Referidos directos del cliente actual, con su estado (activo = ya recargo). */
router.get('/referidos', requiereAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.nombre, c.apellido, c.usuario, c.creado_en,
              EXISTS (SELECT 1 FROM recargas r
                      WHERE r.cliente_id = c.id AND r.estado = 'confirmada') AS activo
       FROM clientes c
       WHERE c.referido_por = $1
       ORDER BY c.creado_en DESC`,
      [req.cliente.id]
    );
    res.json({ referidos: rows });
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
              c.premium, c.ban_razon, c.creado_en, s.saldo
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

/**
 * Admin: marca o desmarca una cuenta como premium. Las cuentas premium quedan
 * exentas de la comision del 5% al retirar, cobran en 24h (sin esperar al dia 25)
 * y ganan el 6% por las recargas de toda su cadena de referidos sin limite de nivel.
 */
router.patch('/:id/premium', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const datos = z.object({ premium: z.boolean() }).safeParse(req.body);
    if (!datos.success) return res.status(400).json({ error: 'Datos invalidos' });

    const { rows } = await query(
      `UPDATE clientes SET premium = $1 WHERE id = $2
       RETURNING id, nombre, apellido, usuario, premium`,
      [datos.data.premium, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const banSchema = z.object({
  baneado: z.boolean(),
  // La razon es obligatoria al banear (es lo que vera el cliente); al quitar el baneo no.
  razon: z.string().trim().max(500).optional().default(''),
});

/**
 * Admin: banea o desbanea una cuenta. Al banear se guarda la razon y el cliente
 * la vera al intentar entrar (o en el momento, si tiene la sesion abierta).
 * No se puede banear a un administrador ni a uno mismo.
 */
router.patch('/:id/ban', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    const datos = banSchema.safeParse(req.body);
    if (!datos.success) return res.status(400).json({ error: 'Datos invalidos' });
    const { baneado, razon } = datos.data;

    if (baneado && razon.length < 3) {
      return res.status(400).json({ error: 'Escribe la razon del baneo (minimo 3 caracteres).' });
    }
    if (id === req.cliente.id) {
      return res.status(400).json({ error: 'No puedes banearte a ti mismo.' });
    }

    const objetivo = await query('SELECT es_admin FROM clientes WHERE id = $1', [id]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (baneado && objetivo.rows[0].es_admin) {
      return res.status(400).json({ error: 'No se puede banear a un administrador.' });
    }

    const { rows } = await query(
      baneado
        ? `UPDATE clientes SET activo = FALSE, ban_razon = $2, baneado_en = now() WHERE id = $1
           RETURNING id, nombre, apellido, usuario, activo, ban_razon`
        : `UPDATE clientes SET activo = TRUE, ban_razon = NULL, baneado_en = NULL WHERE id = $1
           RETURNING id, nombre, apellido, usuario, activo, ban_razon`,
      baneado ? [id, razon] : [id]
    );
    res.json(rows[0]);
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
              c.premium, c.ban_razon, c.creado_en, s.saldo
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
      `SELECT id, gramos_oro, importe, plan, estado, abierta_en, cerrada_en,
              rentabilidad_diaria, plazo_dias, ganancias_acumuladas, tope_ganancias,
              (abierta_en + (plazo_dias || ' days')::interval) AS vencimiento
       FROM inversiones WHERE cliente_id = $1 ORDER BY abierta_en DESC`,
      [id]
    );
    const movimientos = await query(
      `SELECT m.id, m.tipo, m.importe, m.descripcion, m.inversion_id, m.creado_en, r.estado AS retiro_estado
       FROM movimientos m
       LEFT JOIN retiros r ON m.retiro_id = r.id
       WHERE m.cliente_id = $1
       ORDER BY m.creado_en DESC, m.id DESC LIMIT 200`,
      [id]
    );

    res.json({ ...rows[0], inversiones: inversiones.rows, movimientos: movimientos.rows });
  } catch (err) {
    next(err);
  }
});

/** Admin: forzar el cambio de clave de un cliente */
router.patch('/:id/password', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const hash = await hashPassword(password);
    const { rowCount } = await query('UPDATE clientes SET password_hash = $1 WHERE id = $2', [hash, id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    next(err);
  }
});

/** Eliminar un cliente por completo y todo su historial. Solo admin. */
router.delete('/:id', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id invalido' });
    if (req.cliente.id === id) return res.status(403).json({ error: 'No puedes eliminarte a ti mismo' });

    await withTransaction(async (client) => {
      // Postgres RULES prevent DELETE and UPDATE on movimientos. We must temporarily disable them.
      await client.query('ALTER TABLE movimientos DISABLE RULE movimientos_no_delete');
      await client.query('ALTER TABLE movimientos DISABLE RULE movimientos_no_update');
      
      // Nullify references that point to this client to prevent foreign key errors
      await client.query('UPDATE movimientos SET creado_por = NULL WHERE creado_por = $1', [id]);
      await client.query('UPDATE recargas SET atendida_por = NULL WHERE atendida_por = $1', [id]);
      await client.query('UPDATE clientes SET referido_por = NULL WHERE referido_por = $1', [id]);
      
      // Delete rows belonging to this client
      await client.query('DELETE FROM recargas WHERE cliente_id = $1', [id]);
      await client.query('DELETE FROM movimientos WHERE cliente_id = $1', [id]);
      await client.query('DELETE FROM inversiones WHERE cliente_id = $1', [id]);
      
      // Delete the client
      const r = await client.query('DELETE FROM clientes WHERE id = $1', [id]);
      
      // Re-enable the rules
      await client.query('ALTER TABLE movimientos ENABLE RULE movimientos_no_delete');
      await client.query('ALTER TABLE movimientos ENABLE RULE movimientos_no_update');

      if (r.rowCount === 0) {
        throw new Error('Cliente no encontrado');
      }
    });

    res.json({ mensaje: 'Cliente eliminado' });
  } catch (err) {
    if (err.message === 'Cliente no encontrado') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

const nuevoMovimiento = z.object({
  // El driver pg devuelve los BIGINT como string, asi que los ids viajan como "12"
  // en el JSON que sale de la API y vuelven como string. Aceptamos ambos.
  clienteId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tipo: z.enum(['deposito', 'retiro', 'compra_oro', 'venta_oro', 'ajuste']),
  // Importe en dolares con 2 decimales como string, para no perder precision al parsear.
  importe: z.string().regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'Importe con formato "123.45"'),
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
    const { clienteId, tipo, importe, descripcion } = datos.data;

    const resultado = await withTransaction(async (client) => {
      // Bloquea la fila del cliente para que dos retiros simultaneos no puedan
      // dejar el saldo en negativo cada uno creyendo que hay fondos.
      const cliente = await client.query('SELECT id FROM clientes WHERE id = $1 FOR UPDATE', [
        clienteId,
      ]);
      if (cliente.rows.length === 0) return { error: 404, mensaje: 'Cliente no encontrado' };

      if (tipo === 'retiro' || tipo === 'compra_oro') {
        const saldo = await client.query(
          'SELECT COALESCE(SUM(importe), 0) AS saldo FROM movimientos WHERE cliente_id = $1',
          [clienteId]
        );
        // Comparamos en Postgres, no en JS, para respetar la aritmetica NUMERIC.
        const suficiente = await client.query('SELECT ($1::numeric + $2::numeric) >= 0 AS ok', [
          saldo.rows[0].saldo,
          importe,
        ]);
        if (!suficiente.rows[0].ok) return { error: 400, mensaje: 'Saldo insuficiente' };
      }

      const { rows } = await client.query(
        `INSERT INTO movimientos (cliente_id, tipo, importe, descripcion, creado_por)
         VALUES ($1, $2, $3::numeric, $4, $5)
         RETURNING id, cliente_id, tipo, importe, descripcion, creado_en`,
        [clienteId, tipo, importe, descripcion, req.cliente.id]
      );
      return { movimiento: rows[0] };
    });

    if (resultado.error) return res.status(resultado.error).json({ error: resultado.mensaje });
    res.status(201).json(resultado.movimiento);
  } catch (err) {
    next(err);
  }
});
