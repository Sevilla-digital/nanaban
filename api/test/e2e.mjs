// Prueba end-to-end real: levanta Postgres (PGlite) por socket, arranca el server
// de verdad y hace peticiones HTTP reales contra la API.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raizApi = fileURLToPath(new URL('..', import.meta.url));

const db = new PGlite();
await db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
const servidorDb = new PGLiteSocketServer({ db, port: 5433, host: '127.0.0.1' });
await servidorDb.start();
console.log('Postgres de prueba en 127.0.0.1:5433\n');

const api = spawn(process.execPath, ['server.js'], {
  cwd: raizApi,
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://test@127.0.0.1:5433/template1',
    PGSSL: 'off',
    JWT_SECRET: 'x'.repeat(64),
    CORS_ORIGINS: 'https://goldcorp.online',
    ADMIN_BOOTSTRAP_TOKEN: 'clave-bootstrap-de-test',
    AUTH_RATE_LIMIT: '1000',
    PORT: '3999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
api.stderr.on('data', (d) => console.error('[api]', String(d).trim()));

const BASE = 'http://127.0.0.1:3999';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch {}
  await esperar(250);
}

let fallos = 0;
const check = (nombre, cond, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FALLO'} ${nombre}${extra ? ' -> ' + extra : ''}`);
  if (!cond) fallos++;
};
const post = (ruta, body, token) =>
  fetch(BASE + ruta, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (ruta, token) =>
  fetch(BASE + ruta, { headers: token ? { authorization: `Bearer ${token}` } : {} });

// health
const h = await get('/health');
check('GET /health responde 200', h.status === 200, `${h.status} ${JSON.stringify(await h.clone().json())}`);

// registro
const r1 = await post('/api/clientes/registro', {
  nombre: 'Ana',
  apellido: 'Torres',
  usuario: 'Ana.Torres',
  telefono: '600 11 22 33',
  password: 'unacontrasenalarga',
});
const reg = await r1.json();
check('registro con telefono con espacios -> 201', r1.status === 201, String(r1.status));
check('el registro guarda nombre y apellido', reg.cliente?.nombre === 'Ana' && reg.cliente?.apellido === 'Torres', `${reg.cliente?.nombre} ${reg.cliente?.apellido}`);
check('el usuario se guarda en minusculas', reg.cliente?.usuario === 'ana.torres', reg.cliente?.usuario);

// registro sin apellido -> 400
const rSinApellido = await post('/api/clientes/registro', {
  nombre: 'Solo',
  usuario: 'solo1',
  telefono: '611222333',
  password: 'unacontrasenalarga',
});
check('registro sin apellido -> 400', rSinApellido.status === 400, String(rSinApellido.status));

// registro sin usuario -> 400
const rSinUsuario = await post('/api/clientes/registro', {
  nombre: 'Sin',
  apellido: 'Usuario',
  telefono: '611222334',
  password: 'unacontrasenalarga',
});
check('registro sin usuario -> 400', rSinUsuario.status === 400, String(rSinUsuario.status));

// usuario con espacios -> 400
const rUsuarioMal = await post('/api/clientes/registro', {
  nombre: 'Mal',
  apellido: 'Usuario',
  usuario: 'ana torres',
  telefono: '611222335',
  password: 'unacontrasenalarga',
});
check('usuario con espacios -> 400', rUsuarioMal.status === 400, String(rUsuarioMal.status));
check('el telefono se normaliza a E.164', reg.cliente?.telefono === '+34600112233', reg.cliente?.telefono);
check('devuelve token', typeof reg.token === 'string' && reg.token.length > 20);
check('NO devuelve el hash de la contrasena', !JSON.stringify(reg).includes('scrypt'));

// duplicado (mismo numero, otro formato, distinto usuario)
const r2 = await post('/api/clientes/registro', {
  nombre: 'Impostor',
  apellido: 'Falso',
  usuario: 'impostor',
  telefono: '+34600112233',
  password: 'otracontrasena',
});
check('mismo telefono en otro formato -> 409', r2.status === 409, String(r2.status));
check('el 409 dice que es el telefono', (await r2.json()).error.includes('telefono'));

// mismo usuario (en otra capitalizacion), distinto telefono -> 409
const r2b = await post('/api/clientes/registro', {
  nombre: 'Clon',
  apellido: 'DeAna',
  usuario: 'ANA.TORRES',
  telefono: '+525512345678',
  password: 'otracontrasena',
});
check('mismo usuario con mayusculas -> 409', r2b.status === 409, String(r2b.status));
check('el 409 dice que es el usuario', (await r2b.json()).error.includes('usuario'));

// telefono internacional (Mexico) valido -> 201
const rMx = await post('/api/clientes/registro', {
  nombre: 'Luis',
  apellido: 'Gomez',
  usuario: 'luis.mx',
  telefono: '+52 55 1234 5678',
  password: 'unacontrasenalarga',
});
check('registro con telefono mexicano -> 201', rMx.status === 201, String(rMx.status));
check('conserva el prefijo +52', (await rMx.json()).cliente?.telefono === '+525512345678');

// contrasena corta
const r3 = await post('/api/clientes/registro', {
  nombre: 'Bob', apellido: 'Corto', usuario: 'bob', telefono: '600999888', password: 'corta',
});
check('contrasena corta -> 400', r3.status === 400, String(r3.status));

// login correcto por usuario, ignorando mayusculas
const r4 = await post('/api/clientes/login', { usuario: 'ANA.torres', password: 'unacontrasenalarga' });
const login = await r4.json();
check('login por usuario (mayusculas) -> 200', r4.status === 200, String(r4.status));
const token = login.token;

// login incorrecto
const r5 = await post('/api/clientes/login', { usuario: 'ana.torres', password: 'equivocada' });
check('contrasena incorrecta -> 401', r5.status === 401, String(r5.status));

// usuario inexistente -> 401 (mismo mensaje, no revela si existe)
const r5b = await post('/api/clientes/login', { usuario: 'nadie', password: 'loquesea123' });
check('usuario inexistente -> 401', r5b.status === 401, String(r5b.status));

// me
const r6 = await get('/api/clientes/me', token);
const me = await r6.json();
check('GET /me -> 200', r6.status === 200, String(r6.status));
check('saldo inicial 0.00', String(me.saldo) === '0.00', String(me.saldo));

// sin token
const r7 = await get('/api/clientes/me');
check('GET /me sin token -> 401', r7.status === 401, String(r7.status));

// token manipulado
const r8 = await get('/api/clientes/me', token.slice(0, -3) + 'aaa');
check('token manipulado -> 401', r8.status === 401, String(r8.status));

// un cliente normal NO puede crear movimientos
const r9 = await post('/api/clientes/movimientos', {
  clienteId: reg.cliente.id,
  tipo: 'deposito',
  importe: '1000000.00',
  descripcion: 'Me regalo un millon',
}, token);
check('cliente normal no puede crear movimientos -> 403', r9.status === 403, String(r9.status));

// --- bootstrap-admin: crear el primer admin ---
// clave incorrecta -> 403
const rBad = await post('/api/clientes/bootstrap-admin', { telefono: '600112233', clave: 'lo-que-sea' });
check('bootstrap con clave incorrecta -> 403', rBad.status === 403, String(rBad.status));
// telefono sin registrar -> 404
const rNadie = await post('/api/clientes/bootstrap-admin', { telefono: '699999999', clave: 'clave-bootstrap-de-test' });
check('bootstrap de un telefono inexistente -> 404', rNadie.status === 404, String(rNadie.status));
// clave correcta -> promueve
const rBoot = await post('/api/clientes/bootstrap-admin', { telefono: '600112233', clave: 'clave-bootstrap-de-test' });
check('bootstrap con clave correcta promueve a admin', rBoot.status === 200 && (await rBoot.json()).cliente.es_admin === true, String(rBoot.status));

// desde el login ya debe venir como admin
const rAdmin = await post('/api/clientes/login', { usuario: 'ana.torres', password: 'unacontrasenalarga' });
const adminLogin = await rAdmin.json();
check('el login refleja es_admin tras el bootstrap', adminLogin.cliente.esAdmin === true);
const tokenAdmin = adminLogin.token;

const r10 = await post('/api/clientes/movimientos', {
  clienteId: reg.cliente.id,
  tipo: 'deposito',
  importe: '1500.50',
  descripcion: 'Ingreso inicial',
}, tokenAdmin);
check('admin crea deposito -> 201', r10.status === 201, String(r10.status));

const r11 = await get('/api/clientes/me', tokenAdmin);
check('saldo refleja el deposito', String((await r11.json()).saldo) === '1500.50');

// retiro por encima del saldo
const r12 = await post('/api/clientes/movimientos', {
  clienteId: reg.cliente.id,
  tipo: 'retiro',
  importe: '-99999.00',
  descripcion: 'Vaciar cuenta',
}, tokenAdmin);
check('retiro sin fondos -> 400', r12.status === 400, String(r12.status));

const r13 = await get('/api/clientes/me', tokenAdmin);
check('saldo intacto tras retiro rechazado', String((await r13.json()).saldo) === '1500.50');

// movimientos
const r14 = await get('/api/clientes/me/movimientos', tokenAdmin);
check('lista de movimientos tiene 1 entrada', (await r14.json()).movimientos.length === 1);

// admin: listado de clientes
const rLista = await get('/api/clientes', tokenAdmin);
const lista = await rLista.json();
check('admin lista clientes -> 200', rLista.status === 200, String(rLista.status));
check('el listado incluye a Ana con su saldo', lista.clientes?.some((c) => c.nombre === 'Ana' && String(c.saldo) === '1500.50'));

// admin: buscar por telefono
const rBusca = await get('/api/clientes?buscar=600112233', tokenAdmin);
check('admin busca por telefono', (await rBusca.json()).clientes?.length === 1);

// admin: detalle de un cliente concreto
const rDetalle = await get(`/api/clientes/${reg.cliente.id}`, tokenAdmin);
const detalle = await rDetalle.json();
check('admin ve el detalle de un cliente -> 200', rDetalle.status === 200, String(rDetalle.status));
check('el detalle trae saldo y movimientos', String(detalle.saldo) === '1500.50' && detalle.movimientos.length === 1);

// un cliente normal NO puede listar clientes
const rClienteLista = await get('/api/clientes', token);
check('cliente normal no lista clientes -> 403', rClienteLista.status === 403, String(rClienteLista.status));

// --- Configuracion del sitio ---

// publica: cualquiera la lee, trae los valores por defecto
const rSitio = await get('/api/sitio');
const sitio = await rSitio.json();
check('GET /api/sitio publico -> 200', rSitio.status === 200, String(rSitio.status));
check('trae nombre del sitio por defecto', sitio.nombre_sitio === 'Gold Corp Financial', sitio.nombre_sitio);

// un cliente normal NO puede editarla
const rEditNoAdmin = await fetch(`${BASE}/api/sitio`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ nombre_sitio: 'Hackeado' }),
});
check('cliente normal no edita el sitio -> 403', rEditNoAdmin.status === 403, String(rEditNoAdmin.status));

// admin edita solo algunos campos
const rEdit = await fetch(`${BASE}/api/sitio`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenAdmin}` },
  body: JSON.stringify({ nombre_sitio: 'Gold Corp SL', eslogan: 'Tu oro, seguro', color_primario: '#ffcc00' }),
});
const editado = await rEdit.json();
check('admin edita el sitio -> 200', rEdit.status === 200, String(rEdit.status));
check('el cambio se guarda', editado.nombre_sitio === 'Gold Corp SL' && editado.color_primario === '#ffcc00', editado.nombre_sitio);

// y el cambio es visible publicamente
const rSitio2 = await get('/api/sitio');
check('el cambio se ve en el endpoint publico', (await rSitio2.json()).nombre_sitio === 'Gold Corp SL');

// color con formato invalido -> 400
const rColorMal = await fetch(`${BASE}/api/sitio`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenAdmin}` },
  body: JSON.stringify({ color_primario: 'rojo' }),
});
check('color invalido -> 400', rColorMal.status === 400, String(rColorMal.status));

// campo desconocido rechazado (strict)
const rCampoRaro = await fetch(`${BASE}/api/sitio`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenAdmin}` },
  body: JSON.stringify({ es_admin: true }),
});
check('campo desconocido rechazado -> 400', rCampoRaro.status === 400, String(rCampoRaro.status));

// --- Metodos de pago y recargas ---

// Un cliente de verdad (no admin) para el flujo de recarga.
await post('/api/clientes/registro', {
  nombre: 'Rita', apellido: 'Paga', usuario: 'rita.paga',
  telefono: '+34655443322', password: 'unacontrasenalarga',
});
const rRita = await post('/api/clientes/login', { usuario: 'rita.paga', password: 'unacontrasenalarga' });
const rita = await rRita.json();
const tokenRita = rita.token;
const ritaId = rita.cliente.id;

// cliente normal no puede gestionar metodos -> 403
const rGestNoAdmin = await get('/api/pagos/metodos/gestion', tokenRita);
check('cliente normal no gestiona metodos -> 403', rGestNoAdmin.status === 403, String(rGestNoAdmin.status));

// admin crea una cuenta bancaria
const rBanco = await post('/api/pagos/metodos', {
  tipo: 'banco', etiqueta: 'Banco Lafise', titular: 'Gold Corp SA',
  numero_cuenta: '1001-2002-3003', moneda: 'USD',
}, tokenAdmin);
const banco = await rBanco.json();
check('admin crea metodo banco -> 201', rBanco.status === 201, String(rBanco.status));

// admin crea una cripto
const rCripto = await post('/api/pagos/metodos', {
  tipo: 'cripto', etiqueta: 'USDT', red: 'TRC20',
  direccion: 'TXYZ1234567890abcdefghij',
}, tokenAdmin);
const cripto = await rCripto.json();
check('admin crea metodo cripto -> 201', rCripto.status === 201, String(rCripto.status));

// banco sin numero de cuenta -> 400
const rBancoMal = await post('/api/pagos/metodos', {
  tipo: 'banco', etiqueta: 'Sin cuenta', titular: 'X', moneda: 'USD',
}, tokenAdmin);
check('banco sin numero de cuenta -> 400', rBancoMal.status === 400, String(rBancoMal.status));

// tipo desconocido -> 400
const rTipoMal = await post('/api/pagos/metodos', { tipo: 'paypal', etiqueta: 'X' }, tokenAdmin);
check('tipo de metodo desconocido -> 400', rTipoMal.status === 400, String(rTipoMal.status));

// admin crea un metodo inactivo: el cliente NO debe verlo
const rInactivo = await post('/api/pagos/metodos', {
  tipo: 'banco', etiqueta: 'BAC (llena)', titular: 'Gold Corp SA',
  numero_cuenta: '9', moneda: 'USD', activo: false,
}, tokenAdmin);
const inactivo = await rInactivo.json();
check('admin crea metodo inactivo -> 201', rInactivo.status === 201, String(rInactivo.status));

// el cliente ve solo los activos (banco + cripto = 2)
const rMetCliente = await get('/api/pagos/metodos', tokenRita);
const metCliente = await rMetCliente.json();
check('cliente ve solo metodos activos (2)', metCliente.metodos?.length === 2, String(metCliente.metodos?.length));
check('el inactivo no aparece', !metCliente.metodos.some((m) => m.id === inactivo.id));

// recarga por debajo del minimo -> 400
const rMin = await post('/api/pagos/recargas', { metodoId: banco.id, monto: '9.99' }, tokenRita);
check('recarga por debajo de $10 -> 400', rMin.status === 400, String(rMin.status));

// recarga contra un metodo inactivo -> 400
const rContraInactivo = await post('/api/pagos/recargas', { metodoId: inactivo.id, monto: '50' }, tokenRita);
check('recarga contra metodo inactivo -> 400', rContraInactivo.status === 400, String(rContraInactivo.status));

// recarga valida -> 201
const rRecarga = await post('/api/pagos/recargas', { metodoId: banco.id, monto: '50.00' }, tokenRita);
const recarga = await rRecarga.json();
check('recarga valida -> 201', rRecarga.status === 201, String(rRecarga.status));
check('la recarga guarda la descripcion del metodo', /Lafise/.test(recarga.metodo_desc), recarga.metodo_desc);

// admin ve la recarga pendiente
const rPend = await get('/api/pagos/recargas?estado=pendiente', tokenAdmin);
const pend = await rPend.json();
check('admin ve la recarga pendiente', pend.recargas?.some((x) => x.id === recarga.id));

// cliente no puede confirmar -> 403
const rConfNoAdmin = await post(`/api/pagos/recargas/${recarga.id}/confirmar`, {}, tokenRita);
check('cliente no confirma recargas -> 403', rConfNoAdmin.status === 403, String(rConfNoAdmin.status));

// admin confirma -> 201 y abona el saldo
const rConf = await post(`/api/pagos/recargas/${recarga.id}/confirmar`, {}, tokenAdmin);
check('admin confirma la recarga -> 201', rConf.status === 201, String(rConf.status));

const rSaldoRita = await get('/api/clientes/me', tokenRita);
check('el saldo de Rita sube a 50.00', String((await rSaldoRita.json()).saldo) === '50.00');

// confirmar dos veces NO abona doble -> 409
const rDoble = await post(`/api/pagos/recargas/${recarga.id}/confirmar`, {}, tokenAdmin);
check('confirmar dos veces -> 409 (sin doble abono)', rDoble.status === 409, String(rDoble.status));
const rSaldoRita2 = await get('/api/clientes/me', tokenRita);
check('el saldo sigue en 50.00 tras el doble intento', String((await rSaldoRita2.json()).saldo) === '50.00');

// borrar un metodo -> el cliente deja de verlo
const rDel = await fetch(`${BASE}/api/pagos/metodos/${cripto.id}`, {
  method: 'DELETE', headers: { authorization: `Bearer ${tokenAdmin}` },
});
check('admin borra un metodo -> 200', rDel.status === 200, String(rDel.status));
const rMetTrasBorrar = await get('/api/pagos/metodos', tokenRita);
check('el metodo borrado ya no aparece', !(await rMetTrasBorrar.json()).metodos.some((m) => m.id === cripto.id));

// inyeccion SQL
const r15 = await post('/api/clientes/login', {
  usuario: "' OR '1'='1",
  password: "' OR '1'='1",
});
check('intento de inyeccion SQL -> 401, sin romper', r15.status === 401, String(r15.status));

// 404
const r16 = await get('/api/no-existe');
check('ruta inexistente -> 404', r16.status === 404, String(r16.status));

// CORS: el origen permitido recibe la cabecera
const r17 = await fetch(`${BASE}/health`, { headers: { Origin: 'https://goldcorp.online' } });
check(
  'CORS permite goldcorp.online',
  r17.headers.get('access-control-allow-origin') === 'https://goldcorp.online',
  String(r17.headers.get('access-control-allow-origin'))
);

// CORS: el origen no permitido NO recibe cabecera, pero tampoco provoca un 500.
// Un origen rechazado no es un error del servidor: si devuelve 500, cualquier bot
// que mande un Origin llena los logs de errores falsos.
const r18 = await fetch(`${BASE}/health`, { headers: { Origin: 'https://sitio-malicioso.com' } });
check('CORS no da cabecera a un origen ajeno', r18.headers.get('access-control-allow-origin') === null);
check('origen ajeno no provoca 500', r18.status === 200, String(r18.status));

console.log(fallos === 0 ? '\nTodo correcto.' : `\n${fallos} fallo(s).`);
api.kill();
await servidorDb.stop();
await db.close();
process.exit(fallos === 0 ? 0 : 1);
