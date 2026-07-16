# API de clientes de Gold Corp

Backend Node + Express sobre PostgreSQL. La landing (`../index.html`) esta en GitHub
Pages y no puede hablar con Postgres directamente: llama a esta API, que es la unica
que conoce las credenciales de la base de datos.

## Puesta en marcha en Render

Nada de esto esta hecho todavia — hay que hacerlo desde el panel de Render.

1. **Sube el codigo a GitHub** (`git push`). Render despliega desde el repo.
2. En Render: **New > Blueprint**, elige el repo `Sevilla-digital/nanaban`.
   Render lee `../render.yaml` y crea las dos piezas: la base de datos `goldcorp-db`
   y el servicio web `goldcorp-api`.
3. `DATABASE_URL` y `JWT_SECRET` se rellenan solas (ver `render.yaml`). No hay que
   copiar credenciales a mano.
4. Al arrancar, el servicio aplica `schema.sql` y crea las tablas.
5. Comprueba que vive: `curl https://goldcorp-api.onrender.com/health`
   -> `{"ok":true,"db":"conectada"}`

### Avisos del plan free

- **La base de datos free de Render se borra a los 30 dias.** Para datos de clientes
  reales hay que pasar a un plan de pago antes de esa fecha, o se pierde todo.
- El servicio web free se duerme tras 15 min sin trafico: la primera peticion
  despues tarda ~30 s.
- El free no incluye backups automaticos. Con saldos de clientes dentro, esto no
  es opcional.

## Desarrollo local

```bash
cp .env.example .env      # y rellena JWT_SECRET con: openssl rand -hex 32
npm install
npm run migrate
npm run dev
```

Para `DATABASE_URL` en local, usa la **External Database URL** de Render.

## Pruebas

```bash
npm test
```

Levanta un Postgres real en memoria (PGlite), arranca el servidor y hace peticiones
HTTP de verdad. No necesita base de datos ni red.

## Endpoints

| Metodo | Ruta                          | Quien        |
|--------|-------------------------------|--------------|
| GET    | `/health`                     | publico      |
| POST   | `/api/clientes/registro`      | publico      |
| POST   | `/api/clientes/login`         | publico      |
| GET    | `/api/clientes/me`            | cliente      |
| GET    | `/api/clientes/me/movimientos`| cliente      |
| POST   | `/api/clientes/movimientos`   | **solo admin** |

Auth por token JWT: `Authorization: Bearer <token>`.

## Decisiones que conviene conocer

- **El dinero es `NUMERIC(18,2)`, nunca float.** En coma flotante `0.1 + 0.2` no da
  `0.3`, y en saldos de clientes eso son descuadres reales. Los importes viajan como
  string (`"1500.50"`) por el mismo motivo: `pg` los devuelve asi para no perder
  precision.
- **`movimientos` es un libro append-only.** Hay reglas en la base de datos que
  ignoran `UPDATE` y `DELETE` sobre esa tabla: el saldo es `SUM(importe_eur)`, y un
  libro que se puede reescribir no prueba nada. Para corregir un error se anade un
  movimiento de tipo `ajuste`, no se edita el anterior.
- **El saldo no se guarda, se calcula** (vista `saldos`). Asi no hay dos numeros que
  puedan desincronizarse.
- **Solo un admin puede crear movimientos**, y queda grabado en `creado_por` quien
  lo hizo.
- **Contrasenas con scrypt** (integrado en Node, sin dependencias nativas). El hash
  guarda sus propios parametros, asi que se pueden endurecer mas adelante sin
  invalidar los hashes existentes.

## Pendiente antes de tener clientes reales

- **Recuperacion de contrasena.** Con solo nombre + telefono, quien la olvida no
  tiene como recuperarla. Lo natural es verificacion por SMS (Twilio o similar).
- **Verificacion del telefono en el registro.** Ahora mismo cualquiera puede
  registrar un numero que no es suyo.
- **Backups** de la base de datos (no incluidos en el plan free).
- **RGPD**: politica de privacidad, consentimiento y borrado de datos.
- **CNMV**: captar fondos de clientes para invertir requiere autorizacion.
