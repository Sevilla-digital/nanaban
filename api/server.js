import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { router as clientes } from './routes/clientes.js';

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
      cb(new Error(`Origen no permitido: ${origen}`));
    },
  })
);

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

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  // Nunca devolvemos err.message al cliente: puede filtrar estructura de la BD.
  res.status(500).json({ error: 'Error interno del servidor' });
});

const puerto = process.env.PORT || 3000;
const servidor = app.listen(puerto, () => {
  console.log(`API de Gold Corp escuchando en el puerto ${puerto}`);
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
