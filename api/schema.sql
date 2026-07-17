-- Esquema de clientes de Gold Corp.
-- Idempotente: se puede ejecutar varias veces sin romper nada.

-- El cliente inicia sesion con su nombre de usuario. El telefono sigue siendo
-- unico (una cuenta por numero), pero es un dato de contacto, no la credencial.
CREATE TABLE IF NOT EXISTS clientes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre         TEXT        NOT NULL CHECK (length(trim(nombre)) BETWEEN 2 AND 120),
  apellido       TEXT        NOT NULL DEFAULT '',
  -- Se guarda en minusculas (lo normaliza la API). Nullable porque las cuentas
  -- creadas antes de existir esta columna no tienen usuario.
  usuario        TEXT,
  telefono       TEXT        NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  es_admin       BOOLEAN     NOT NULL DEFAULT FALSE,
  activo         BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La tabla ya existia en Render sin estas columnas; los ALTER son las migraciones.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apellido TEXT NOT NULL DEFAULT '';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS usuario TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS referido_por BIGINT REFERENCES clientes(id) ON DELETE SET NULL;

-- La unicidad del usuario vive SOLO en este indice (no en la columna) para que
-- el nombre del constraint sea el mismo en instalaciones nuevas y migradas:
-- la API distingue por ese nombre que UNIQUE fallo al registrar.
CREATE UNIQUE INDEX IF NOT EXISTS clientes_usuario_key ON clientes (usuario);

-- Una inversion es una posicion abierta por el cliente.
-- La moneda de la plataforma es el dolar estadounidense (USD).
CREATE TABLE IF NOT EXISTS inversiones (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id    BIGINT        NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  gramos_oro    NUMERIC(14,4) NOT NULL CHECK (gramos_oro > 0),
  importe       NUMERIC(18,2) NOT NULL CHECK (importe > 0),
  plan          TEXT          NOT NULL,
  estado        TEXT          NOT NULL DEFAULT 'abierta'
                              CHECK (estado IN ('abierta', 'cerrada', 'cancelada')),
  abierta_en    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  cerrada_en    TIMESTAMPTZ,
  CHECK (cerrada_en IS NULL OR cerrada_en >= abierta_en),
  CHECK (plan IN ('10 Kilates', '14 Kilates', '18 Kilates', '22 Kilates', '24 Kilates'))
);

CREATE INDEX IF NOT EXISTS idx_inversiones_cliente ON inversiones (cliente_id, abierta_en DESC);

-- Libro de movimientos: fuente de verdad del saldo, solo se anade (nunca UPDATE/DELETE).
-- El saldo de un cliente es SUM(importe) sobre esta tabla. Asi no hay dos numeros
-- que puedan desincronizarse entre si.
CREATE TABLE IF NOT EXISTS movimientos (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id    BIGINT        NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  tipo          TEXT          NOT NULL
                              CHECK (tipo IN ('deposito', 'retiro', 'compra_oro', 'venta_oro', 'ajuste', 'comision_referido')),
  importe       NUMERIC(18,2) NOT NULL CHECK (importe <> 0),
  descripcion   TEXT          NOT NULL CHECK (length(trim(descripcion)) > 0),
  inversion_id  BIGINT        REFERENCES inversiones(id) ON DELETE RESTRICT,
  -- Quien registro el movimiento. Deja rastro para auditoria.
  creado_por    BIGINT        REFERENCES clientes(id) ON DELETE RESTRICT,
  creado_en     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movimientos_cliente ON movimientos (cliente_id, creado_en DESC);

-- Migracion: las columnas se llamaban importe_eur cuando la plataforma era en
-- euros. Ahora la moneda es el dolar y el nombre paso a ser neutro (importe).
-- El RENAME solo corre si la columna vieja sigue existiendo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'movimientos' AND column_name = 'importe_eur') THEN
    ALTER TABLE movimientos RENAME COLUMN importe_eur TO importe;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'inversiones' AND column_name = 'importe_eur') THEN
    ALTER TABLE inversiones RENAME COLUMN importe_eur TO importe;
  END IF;
END $$;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'movimientos'::regclass AND (conname LIKE 'movimientos_tipo_check%' OR conname LIKE 'movimientos_tipo_check');
  
  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE movimientos DROP CONSTRAINT ' || constraint_name;
    EXECUTE 'ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (''deposito'', ''retiro'', ''compra_oro'', ''venta_oro'', ''ajuste'', ''comision_referido''))';
  END IF;
END $$;

-- Migracion para añadir el plan a inversiones existentes (si las hubiera).
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS plan TEXT;

-- Los movimientos no se editan ni se borran: un libro contable que se puede reescribir
-- no sirve como prueba de nada.
CREATE OR REPLACE RULE movimientos_no_update AS ON UPDATE TO movimientos DO INSTEAD NOTHING;
CREATE OR REPLACE RULE movimientos_no_delete AS ON DELETE TO movimientos DO INSTEAD NOTHING;

-- DROP + CREATE (y no OR REPLACE) porque la columna de salida cambio de nombre
-- (saldo_eur -> saldo) y OR REPLACE no permite renombrar columnas de una vista.
DROP VIEW IF EXISTS saldos;
CREATE VIEW saldos AS
  SELECT c.id AS cliente_id,
         COALESCE(SUM(m.importe), 0)::NUMERIC(18,2) AS saldo
  FROM clientes c
  LEFT JOIN movimientos m ON m.cliente_id = c.id
  GROUP BY c.id;

-- Configuracion editable del sitio: lo que el admin cambia desde el panel y la web
-- publica lee al cargar. Una sola fila (id fijo = 1), asi no hay que decidir "cual".
CREATE TABLE IF NOT EXISTS configuracion_sitio (
  id              SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nombre_sitio    TEXT        NOT NULL DEFAULT 'Gold Corp Financial',
  eslogan         TEXT        NOT NULL DEFAULT 'Inversion en Oro - Segura y Rentable',
  texto_header    TEXT        NOT NULL DEFAULT '',
  texto_footer    TEXT        NOT NULL DEFAULT '',
  logo_url        TEXT        NOT NULL DEFAULT '',
  color_primario  TEXT        NOT NULL DEFAULT '#ffd700',
  color_fondo     TEXT        NOT NULL DEFAULT '#1a1a1a',
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Garantiza que la fila unica exista siempre, sin duplicarla en re-ejecuciones.
INSERT INTO configuracion_sitio (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Metodos de pago para recargar saldo. Los gestiona el admin desde el panel y el
-- cliente los ve al recargar. Una sola tabla para bancos y cripto: la columna 'tipo'
-- decide que campos aplican (la API valida cada tipo con un esquema distinto).
CREATE TABLE IF NOT EXISTS metodos_pago (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo           TEXT        NOT NULL CHECK (tipo IN ('banco', 'cripto')),
  etiqueta       TEXT        NOT NULL CHECK (length(trim(etiqueta)) > 0),
  -- Campos de banco (obligatorios solo cuando tipo='banco', lo exige la API).
  titular        TEXT,
  numero_cuenta  TEXT,
  moneda         TEXT,
  -- Campos de cripto.
  red            TEXT,
  direccion      TEXT,
  -- Comision de red que paga el cliente ADEMAS del monto (solo cripto). El cliente
  -- envia monto + comision; se le acredita el monto. En banco es 0.
  comision       NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Comunes.
  notas          TEXT        NOT NULL DEFAULT '',
  activo         BOOLEAN     NOT NULL DEFAULT TRUE,
  orden          INT         NOT NULL DEFAULT 0,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metodos_pago ON metodos_pago (tipo, activo, orden, id);

-- Migracion: la comision se añadio despues. En las filas que ya existian (p. ej. la
-- cripto creada antes) se rellena con 0.50 por defecto, que es lo pactado.
ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS comision NUMERIC(18,2) NOT NULL DEFAULT 0.50;

-- Solicitudes de recarga: cuando el cliente pulsa "ya realice el pago", queda una
-- fila pendiente que el admin ve y confirma. Al confirmar se crea el deposito.
-- El minimo son 10 dolares (lo exige tambien la API antes de insertar).
CREATE TABLE IF NOT EXISTS recargas (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id     BIGINT        NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  monto          NUMERIC(18,2) NOT NULL CHECK (monto >= 10),
  -- Si se borra el metodo, la recarga sobrevive con su descripcion congelada.
  metodo_id      BIGINT        REFERENCES metodos_pago(id) ON DELETE SET NULL,
  metodo_desc    TEXT          NOT NULL,
  referencia     TEXT          NOT NULL DEFAULT '',
  estado         TEXT          NOT NULL DEFAULT 'pendiente'
                               CHECK (estado IN ('pendiente', 'confirmada', 'rechazada')),
  -- Comprobante de pago (obligatorio en banco, no en cripto). Se guarda el binario
  -- y su tipo MIME. Cripto se verificara mas adelante contra la API de la exchange.
  comprobante      BYTEA,
  comprobante_mime TEXT,
  -- Deposito creado al confirmar. Enlaza la recarga con el movimiento del libro.
  movimiento_id  BIGINT        REFERENCES movimientos(id) ON DELETE RESTRICT,
  atendida_por   BIGINT        REFERENCES clientes(id) ON DELETE RESTRICT,
  atendida_en    TIMESTAMPTZ,
  creada_en      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recargas_estado ON recargas (estado, creada_en DESC);
CREATE INDEX IF NOT EXISTS idx_recargas_cliente ON recargas (cliente_id, creada_en DESC);

-- Migraciones de las columnas de comprobante (se añadieron despues).
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS comprobante BYTEA;
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS comprobante_mime TEXT;
