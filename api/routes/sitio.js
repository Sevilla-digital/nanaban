import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requiereAdmin, requiereAuth } from '../auth.js';

export const router = Router();

const CAMPOS = `nombre_sitio, eslogan, texto_header, texto_footer,
                logo_url, color_primario, color_fondo,
                legal_terminos, legal_privacidad, legal_cumplimiento,
                tasa_cordoba, actualizado_en`;

/** Configuracion del sitio. Publica: la landing la lee para pintarse. */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${CAMPOS} FROM configuracion_sitio WHERE id = 1`);
    res.json(rows[0] ?? {});
  } catch (err) {
    next(err);
  }
});

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #rrggbb');

// Todos opcionales: el panel puede mandar solo lo que cambia.
const actualizacion = z
  .object({
    nombre_sitio: z.string().trim().min(1).max(120),
    eslogan: z.string().trim().max(300),
    texto_header: z.string().max(2000),
    texto_footer: z.string().max(2000),
    // El logo es una URL http(s); no aceptamos data URIs para no inflar la fila
    // ni servir contenido arbitrario embebido.
    logo_url: z.union([z.string().url().max(1000), z.literal('')]),
    color_primario: color,
    color_fondo: color,
    // Textos legales (pueden ser largos). Se guardan como texto plano.
    legal_terminos: z.string().max(20000),
    legal_privacidad: z.string().max(20000),
    legal_cumplimiento: z.string().max(20000),
    // Tasa Cordoba/Dolar (cordobas por 1 USD). Entre 1 y 100000 por seguridad.
    tasa_cordoba: z.coerce.number().positive().max(100000),
  })
  .partial()
  .strict();

/** Actualiza la configuracion. Solo admin. Es lo que ve todo visitante del sitio. */
router.put('/', requiereAuth, requiereAdmin, async (req, res, next) => {
  try {
    const datos = actualizacion.safeParse(req.body);
    if (!datos.success) {
      return res.status(400).json({ error: 'Datos invalidos', detalle: datos.error.flatten() });
    }
    const campos = Object.keys(datos.data);
    if (campos.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    // SET dinamico pero seguro: los nombres de columna salen de un conjunto cerrado
    // (las claves del esquema zod), nunca del texto del cliente. Los valores van
    // parametrizados. Sin concatenar datos del usuario en el SQL.
    const set = campos.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const valores = campos.map((c) => datos.data[c]);

    const { rows } = await query(
      `UPDATE configuracion_sitio
       SET ${set}, actualizado_en = now()
       WHERE id = 1
       RETURNING ${CAMPOS}`,
      valores
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
