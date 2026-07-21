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
-- Foto de perfil opcional, guardada como data URL (base64). El cliente la puede
-- subir o quitar desde su perfil; se limita el tamaño al subirla (redimension en cliente).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS avatar TEXT;

-- Cuentas premium (las marca el admin): exentas de la comision del 5% al retirar,
-- exentas de la regla de pago el dia 25 (retiran a diario, 24h) y ganan siempre el
-- 6% de comision por las recargas de TODA su cadena de referidos, sin limite de nivel.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS premium BOOLEAN NOT NULL DEFAULT FALSE;

-- Baneo de cuentas: el flag es `activo = FALSE` (ya existia). El admin escribe la
-- razon al banear y el cliente la ve al intentar entrar ("Cuenta baneada: <razon>").
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ban_razon TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS baneado_en TIMESTAMPTZ;

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
  pagos_realizados INT        NOT NULL DEFAULT 0,
  ganancias_acumuladas NUMERIC(18,2) NOT NULL DEFAULT 0,
  tope_ganancias NUMERIC(18,2) NOT NULL DEFAULT 0,
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
  retiro_id     BIGINT,       -- Migracion posterior para enlazar con la tabla retiros
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
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT conname 
    FROM pg_constraint 
    WHERE conrelid = 'movimientos'::regclass 
      AND contype = 'c' 
      AND (conname LIKE '%tipo_check%' OR conname LIKE 'movimientos_%_check')
  LOOP
    EXECUTE 'ALTER TABLE movimientos DROP CONSTRAINT ' || rec.conname;
  END LOOP;
  
  EXECUTE 'ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (''deposito'', ''retiro'', ''compra_oro'', ''venta_oro'', ''ajuste'', ''comision_referido''))';
END $$;

-- Migracion para añadir el plan a inversiones existentes (si las hubiera).
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS plan TEXT;

-- Rentabilidad diaria (en %, ej. 1.20) y plazo del contrato (en dias) con los que
-- se firmo la inversion. Se guardan al contratar para que queden "congelados": si
-- en el futuro cambian las ofertas, las inversiones ya abiertas conservan lo pactado.
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS rentabilidad_diaria NUMERIC(6,4);
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS plazo_dias INTEGER;

-- Cuantos pagos de ganancia diaria (dias habiles L-V) ha recibido cada inversion.
-- El cron paga hasta el tope del plan (44/66/110/132/264) y ahi cierra la inversion:
-- cada plan esta calibrado para duplicar el capital en esos dias y luego parar.
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS pagos_realizados INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS ganancias_acumuladas NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE inversiones ADD COLUMN IF NOT EXISTS tope_ganancias NUMERIC(18,2) NOT NULL DEFAULT 0;

-- Migrar datos antiguos: configurar tope_ganancias al 200% del importe si esta en 0
UPDATE inversiones SET tope_ganancias = importe * 2 WHERE tope_ganancias = 0;

-- Actualiza TODOS los paquetes (incluidos los ya abiertos) a las nuevas condiciones.
-- Idempotente: cada plan se re-fija a su valor canonico en cada arranque.
UPDATE inversiones SET rentabilidad_diaria = 4.55, plazo_dias = 60  WHERE plan = '10 Kilates';
UPDATE inversiones SET rentabilidad_diaria = 3.03, plazo_dias = 90  WHERE plan = '14 Kilates';
UPDATE inversiones SET rentabilidad_diaria = 1.81, plazo_dias = 150 WHERE plan = '18 Kilates';
UPDATE inversiones SET rentabilidad_diaria = 1.51, plazo_dias = 180 WHERE plan = '22 Kilates';
UPDATE inversiones SET rentabilidad_diaria = 0.76, plazo_dias = 365 WHERE plan = '24 Kilates';

-- Invariante: pagos_realizados = numero de movimientos de "Ganancia diaria" de esa
-- inversion. Esto lo recalcula por si el cron se colgo a medias (nunca deberia).
UPDATE inversiones i SET pagos_realizados = COALESCE((
    SELECT count(*) FROM movimientos m 
    WHERE m.inversion_id = i.id AND m.tipo = 'deposito' AND m.descripcion LIKE 'Ganancia diaria%'
), 0) WHERE estado = 'abierta';

-- Calcular las ganancias acumuladas historicas basandonos en los pagos_realizados y el porcentaje del plan
-- Esto asegura que los contratos activos tengan la base de progreso correcta.
DO $$
DECLARE
  rec RECORD;
  porcentaje NUMERIC(14,4);
BEGIN
  FOR rec IN SELECT id, plan, pagos_realizados, importe FROM inversiones WHERE estado = 'abierta' AND ganancias_acumuladas = 0 LOOP
    IF rec.plan = '10 Kilates' THEN porcentaje := 0.0455;
    ELSIF rec.plan = '14 Kilates' THEN porcentaje := 0.0303;
    ELSIF rec.plan = '18 Kilates' THEN porcentaje := 0.0181;
    ELSIF rec.plan = '22 Kilates' THEN porcentaje := 0.0151;
    ELSIF rec.plan = '24 Kilates' THEN porcentaje := 0.0076;
    ELSE porcentaje := 0;
    END IF;
    
    UPDATE inversiones 
    SET ganancias_acumuladas = ROUND((rec.importe * porcentaje * rec.pagos_realizados)::numeric, 2)
    WHERE id = rec.id;
  END LOOP;
END $$;

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

-- Textos legales editables desde el panel de admin. Cada uno se muestra en su
-- propia pagina (legal.html?doc=...) enlazada desde el pie del sitio.
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS legal_terminos     TEXT NOT NULL DEFAULT '';
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS legal_privacidad   TEXT NOT NULL DEFAULT '';
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS legal_cumplimiento TEXT NOT NULL DEFAULT '';

-- Tasa de cambio Cordoba/Dolar (cuantos cordobas por 1 USD) que fija el admin segun
-- la tasa de LAFISE. Se usa para convertir el monto en la pantalla de recarga para
-- clientes con numero de Nicaragua (+505). Por defecto ~36.80.
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS tasa_cordoba NUMERIC(10,4) NOT NULL DEFAULT 36.80;

-- Recompensas del programa de afiliacion: al llegar a 20/50/100 referidos directos
-- se abona un premio unico ($100/$200/$1000) como movimiento. El UNIQUE garantiza
-- que cada hito se paga una sola vez aunque dos registros lleguen a la vez.
CREATE TABLE IF NOT EXISTS recompensas_afiliacion (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id  BIGINT        NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  hito        INTEGER       NOT NULL,
  premio      NUMERIC(18,2) NOT NULL,
  otorgada_en TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, hito)
);

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

-- Metodos de retiro configurados por cada cliente
CREATE TABLE IF NOT EXISTS metodos_retiro_cliente (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id       BIGINT      NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo             TEXT        NOT NULL CHECK (tipo IN ('banco', 'movil', 'cripto')),
  -- Banco / Movil
  banco_nombre     TEXT,       -- Ej. 'Lafise', 'BAC', 'Banpro', 'Billetera Movil'
  titular          TEXT,
  numero_cuenta    TEXT,
  -- Cripto
  cripto_red       TEXT,
  cripto_direccion TEXT,
  telefono_movil   TEXT,
  
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  activo           BOOLEAN     NOT NULL DEFAULT TRUE
);

ALTER TABLE metodos_retiro_cliente ADD COLUMN IF NOT EXISTS telefono_movil TEXT;

-- Registro de solicitudes de retiro
CREATE TABLE IF NOT EXISTS retiros (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id       BIGINT        NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  metodo_retiro_id BIGINT        NOT NULL REFERENCES metodos_retiro_cliente(id) ON DELETE RESTRICT,
  monto            NUMERIC(18,2) NOT NULL CHECK (monto >= 30),
  comision         NUMERIC(18,2) NOT NULL CHECK (comision >= 0),
  total_recibir    NUMERIC(18,2) NOT NULL CHECK (total_recibir > 0),
  estado           TEXT          NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'completado', 'rechazado')),
  creado_en        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  procesado_en     TIMESTAMPTZ,
  procesado_por    BIGINT        REFERENCES clientes(id) ON DELETE SET NULL
);

-- Fecha en la que esta programado pagar el retiro. Las cuentas normales cobran el
-- dia 25 de cada mes (NULL en las premium, que cobran en 24h).
ALTER TABLE retiros ADD COLUMN IF NOT EXISTS programado_para DATE;

-- Enlazar la tabla movimientos con la tabla retiros (si no existe la constraint)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'movimientos' AND column_name = 'retiro_id') THEN
    ALTER TABLE movimientos ADD COLUMN retiro_id BIGINT REFERENCES retiros(id) ON DELETE RESTRICT;
  ELSE
    -- Asegurar la Foreign Key si la columna ya existía
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'movimientos_retiro_id_fkey'
    ) THEN
        ALTER TABLE movimientos ADD CONSTRAINT movimientos_retiro_id_fkey FOREIGN KEY (retiro_id) REFERENCES retiros(id) ON DELETE RESTRICT;
    END IF;
  END IF;
END $$;

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

-- Confirmacion automatica de recargas cripto (KuCoin): cada recarga cripto reserva
-- un monto EXACTO y unico (monto + comision + centavos aleatorios). Cuando ese
-- importe llega a la exchange, el cron identifica el pago y confirma solo.
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS monto_esperado NUMERIC(18,2);
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS tx_id TEXT;
-- Un deposito de la exchange solo puede confirmar UNA recarga.
CREATE UNIQUE INDEX IF NOT EXISTS recargas_tx_id_key ON recargas (tx_id) WHERE tx_id IS NOT NULL;
-- Dos recargas pendientes nunca comparten monto esperado: es lo que identifica al pagador.
CREATE UNIQUE INDEX IF NOT EXISTS recargas_monto_esperado_pendiente_key
  ON recargas (monto_esperado) WHERE estado = 'pendiente' AND monto_esperado IS NOT NULL;

-- Migracion: Configuración de grupo de WhatsApp
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS link_grupo_whatsapp TEXT NOT NULL DEFAULT 'https://chat.whatsapp.com/J3wRtFKhqft9fCpLu0h34t?s=sw&p=a&ilr=0';
ALTER TABLE configuracion_sitio ADD COLUMN IF NOT EXISTS mostrar_grupo_whatsapp BOOLEAN NOT NULL DEFAULT TRUE;
