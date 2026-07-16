import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { router as clientes } from './routes/clientes.js';
import { router as sitio } from './routes/sitio.js';
import { router as inversiones } from './routes/inversiones.js';
import { router as pagos } from './routes/pagos.js';
import { iniciarCron } from './cron.js';

const app = express();

// Render termina el TLS en su proxy: sin esto, el rate limit veria la IP del proxy
// para todo el mundo y limitaria a todos los clientes juntos.
app.set('trust proxy', 1);

// Solo el dominio de la landing puede llamar a la API desde el navegador.
const origenes = (process.env.CORS_ORIGINS ?? 'https://goldcorp.online')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origen, cb) {
      // Sin cabecera Origin = peticion no-navegador (curl, health check): se permite.
      if (!origen || origenes.includes(origen)) return cb(null, true);
      // Origen no permitido: respondemos sin la cabecera CORS y el navegador lo bloquea.
      // No lanzamos un Error: eso lo convertiria en un 500 y llenaria los logs de
      // errores falsos con cada bot que mande un Origin cualquiera.
      cb(null, false);
    },
  })
);

// El comprobante de recarga viaja como data URL dentro del JSON, asi que esa ruta
// necesita un limite mayor. El primer parser que consume el body marca req._body,
// y el global de 100kb lo salta. El resto de la API se queda en 100kb.
app.use('/api/pagos/recargas', express.json({ limit: '7mb' }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'conectada' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'sin conexion', error: err.message });
  }
});

app.use('/api/clientes', clientes);
app.use('/api/sitio', sitio);
app.use('/api/inversiones', inversiones);
app.use('/api/pagos', pagos);

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  // Nunca devolvemos err.message al cliente: puede filtrar estructura de la BD.
  res.status(500).json({ error: 'Error interno del servidor' });
});

const puerto = process.env.PORT || 3000;
const servidor = app.listen(puerto, () => {
  console.log(`API de Gold Corp escuchando en el puerto ${puerto}`);
  
  // Iniciar la tarea programada (cron)
  iniciarCron();
});

// Render envia SIGTERM al desplegar: cerramos limpio para no cortar peticiones vivas.
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    servidor.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
