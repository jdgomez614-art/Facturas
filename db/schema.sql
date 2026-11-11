-- Esquema PostgreSQL (Neon, Supabase, RDS... cualquiera). Idempotente: se puede correr varias veces.

create table if not exists buzon_estado (
  mailbox_id   text not null,
  carpeta      text not null,
  uidvalidity  bigint not null,
  ultimo_uid   bigint not null default 0,
  actualizado  timestamptz not null default now(),
  primary key (mailbox_id, carpeta)
);

-- Un registro por correo visto: evita reprocesar y lleva la cuenta de reintentos.
create table if not exists correos_procesados (
  clave        text primary key,            -- mailbox_id + Message-ID
  mailbox_id   text not null,
  uid          bigint not null,
  estado       text not null,               -- procesado | ignorado | error | fallido
  intentos     int not null default 0,
  detalle      text,
  actualizado  timestamptz not null default now()
);

create table if not exists facturas (
  id                 uuid primary key default gen_random_uuid(),
  fecha              date,
  numero_factura     text,
  tipo_movimiento    text not null,
  categoria          text not null,
  descripcion        text not null,
  tercero            text,
  nit                text,
  razon_social       text,
  cuenta             text,
  centro_costos      text not null,
  valor_bruto        numeric(18,2) not null,
  iva                numeric(18,2) not null,
  retenciones        numeric(18,2) not null,
  retefuente         numeric(18,2) not null,
  reteica            numeric(18,2) not null,
  valor_neto         numeric(18,2) not null,
  valor_usd          numeric(18,2),
  fecha_pago         date,
  tipo_documento     text not null,
  medio_pago         text not null,
  tarjeta            text,
  fecha_vencimiento  date,
  estado             text not null,
  moneda             text not null,
  cufe               text,
  drive_url          text,
  fuente             text not null,
  confianza          numeric(4,3) not null,
  requiere_revision  boolean not null,
  motivos_revision   text[] not null default '{}',
  reglas_aplicadas   text[] not null default '{}',
  mailbox_id         text not null,
  message_id         text not null,
  remitente          text not null,
  asunto             text not null,
  recibido_en        timestamptz not null,
  -- outbox: si Sheets o Slack fallan, se reintenta en la siguiente ejecución
  sheet_fila         int,
  sheet_sincronizada boolean not null default false,
  slack_ts           text,
  slack_canal        text,
  slack_notificada   boolean not null default false,
  pagada_por         text,
  creado             timestamptz not null default now(),
  actualizado        timestamptz not null default now()
);

-- Anti-duplicados: la misma factura reenviada o llegada a dos buzones se registra una sola vez.
create unique index if not exists facturas_cufe_uq on facturas (cufe) where cufe is not null;
create unique index if not exists facturas_nit_numero_uq on facturas (nit, numero_factura)
  where nit is not null and numero_factura is not null and estado <> 'Descartada';
create index if not exists facturas_pendientes_idx on facturas (estado, fecha_vencimiento);
create index if not exists facturas_outbox_idx on facturas (sheet_sincronizada, slack_notificada);

create table if not exists bloqueos (
  nombre   text primary key,
  dueno    text not null,
  expira   timestamptz not null
);

-- Personas que conectaron su cuenta (correo + Drive). El token se guarda cifrado con ENCRYPTION_KEY.
create table if not exists conexiones (
  email                 text primary key,
  proveedor             text not null,
  refresh_token_cifrado text not null,
  drive_folder_id       text,
  sheet_id              text,
  activo                boolean not null default true,
  ultimo_error          text,
  creado                timestamptz not null default now(),
  actualizado           timestamptz not null default now()
);
