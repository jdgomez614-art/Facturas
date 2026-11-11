import postgres from "postgres";
import type { Factura } from "../types.js";
import type { Conexion, EstadoCorreo, FacturaGuardada, Repo } from "./repo.js";

const COLUMNAS_FACTURA = [
  "fecha", "numero_factura", "tipo_movimiento", "categoria", "descripcion", "tercero", "nit", "razon_social",
  "cuenta", "centro_costos", "valor_bruto", "iva", "retenciones", "retefuente", "reteica", "valor_neto",
  "valor_usd", "fecha_pago", "tipo_documento", "medio_pago", "tarjeta", "fecha_vencimiento", "estado", "moneda",
  "cufe", "drive_url", "fuente", "confianza", "requiere_revision", "motivos_revision", "reglas_aplicadas", "mailbox_id",
  "message_id", "remitente", "asunto", "recibido_en",
] as const satisfies readonly (keyof Factura)[];

export function crearSql(url: string) {
  return postgres(url, {
    max: 1, // funciones serverless: una conexión por instancia (usar la URL "pooled" del proveedor)
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false, // compatible con poolers en modo transacción (PgBouncer / Supavisor)
    types: {
      // fechas como texto YYYY-MM-DD y numeric como number
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
}
type Sql = ReturnType<typeof crearSql>;

function aFactura(r: Record<string, unknown>): FacturaGuardada {
  return {
    ...(r as unknown as FacturaGuardada),
    recibido_en: r.recibido_en instanceof Date ? r.recibido_en.toISOString() : String(r.recibido_en),
  };
}

export class PostgresRepo implements Repo {
  constructor(private sql: Sql) {}

  async obtenerEstadoBuzon(mailboxId: string, carpeta: string) {
    const [r] = await this.sql`select uidvalidity, ultimo_uid from buzon_estado where mailbox_id = ${mailboxId} and carpeta = ${carpeta}`;
    return r ? { uidvalidity: Number(r.uidvalidity), ultimo_uid: Number(r.ultimo_uid) } : null;
  }

  async guardarEstadoBuzon(mailboxId: string, carpeta: string, uidvalidity: number, ultimoUid: number) {
    await this.sql`
      insert into buzon_estado (mailbox_id, carpeta, uidvalidity, ultimo_uid) values (${mailboxId}, ${carpeta}, ${uidvalidity}, ${ultimoUid})
      on conflict (mailbox_id, carpeta) do update set uidvalidity = excluded.uidvalidity, ultimo_uid = excluded.ultimo_uid, actualizado = now()`;
  }

  async estadoCorreo(clave: string) {
    const [r] = await this.sql`select estado, intentos from correos_procesados where clave = ${clave}`;
    return r ? { estado: r.estado as EstadoCorreo, intentos: Number(r.intentos) } : null;
  }

  async marcarCorreo(clave: string, mailboxId: string, uid: number, estado: EstadoCorreo, detalle?: string) {
    const suma = estado === "error" ? 1 : 0;
    const [r] = await this.sql`
      insert into correos_procesados (clave, mailbox_id, uid, estado, intentos, detalle)
      values (${clave}, ${mailboxId}, ${uid}, ${estado}, ${suma}, ${detalle ?? null})
      on conflict (clave) do update set estado = excluded.estado, uid = excluded.uid,
        intentos = correos_procesados.intentos + ${suma}, detalle = excluded.detalle, actualizado = now()
      returning intentos`;
    return { intentos: Number(r.intentos) };
  }

  async buscarDuplicado(f: Pick<Factura, "cufe" | "nit" | "numero_factura">) {
    if (f.cufe) {
      const [r] = await this.sql`select id from facturas where cufe = ${f.cufe} limit 1`;
      if (r) return r.id as string;
    }
    if (f.nit && f.numero_factura) {
      const [r] = await this.sql`select id from facturas where nit = ${f.nit} and numero_factura = ${f.numero_factura} and estado <> 'Descartada' limit 1`;
      if (r) return r.id as string;
    }
    return null;
  }

  async insertarFactura(f: Factura) {
    const fila = Object.fromEntries(COLUMNAS_FACTURA.map((c) => [c, f[c]]));
    const [r] = await this.sql`insert into facturas ${this.sql(fila as Record<string, postgres.ParameterOrJSON<never>>)} returning *`;
    return aFactura(r);
  }

  async obtenerFactura(id: string) {
    const [r] = await this.sql`select * from facturas where id = ${id}`;
    return r ? aFactura(r) : null;
  }

  async pendientesDeSincronizar(limite: number, s: { sheets: boolean; slack: boolean }) {
    const rows = await this.sql`
      select * from facturas
      where (${s.sheets} and not sheet_sincronizada) or (${s.slack} and not slack_notificada)
      order by creado limit ${limite}`;
    return rows.map(aFactura);
  }

  async marcarSheet(id: string, fila: number) {
    await this.sql`update facturas set sheet_fila = ${fila}, sheet_sincronizada = true, actualizado = now() where id = ${id}`;
  }

  async marcarSlack(id: string, canal: string, ts: string) {
    await this.sql`update facturas set slack_canal = ${canal}, slack_ts = ${ts}, slack_notificada = true, actualizado = now() where id = ${id}`;
  }

  async actualizarEstado(id: string, estado: Factura["estado"], fechaPago: string | null, por: string) {
    const [r] = await this.sql`
      update facturas set estado = ${estado}, fecha_pago = ${fechaPago}, pagada_por = ${por}, actualizado = now()
      where id = ${id} returning *`;
    return r ? aFactura(r) : null;
  }

  async porPagar(hastaFecha: string) {
    const rows = await this.sql`
      select * from facturas
      where estado = 'Pendiente' and tipo_movimiento = 'Egreso facturación'
        and (fecha_vencimiento is null or fecha_vencimiento <= ${hastaFecha})
      order by fecha_vencimiento nulls last, valor_neto desc`;
    return rows.map(aFactura);
  }

  private aConexion = (r: Record<string, unknown>): Conexion => ({ ...(r as unknown as Conexion), creado: (r.creado as Date).toISOString() });

  async obtenerConexion(email: string) {
    const [r] = await this.sql`select * from conexiones where email = ${email}`;
    return r ? this.aConexion(r) : null;
  }

  async guardarConexion(c: Omit<Conexion, "activo" | "creado">) {
    const [r] = await this.sql`
      insert into conexiones (email, proveedor, refresh_token_cifrado, drive_folder_id, sheet_id)
      values (${c.email}, ${c.proveedor}, ${c.refresh_token_cifrado}, ${c.drive_folder_id}, ${c.sheet_id})
      on conflict (email) do update set refresh_token_cifrado = excluded.refresh_token_cifrado,
        drive_folder_id = excluded.drive_folder_id, sheet_id = excluded.sheet_id, activo = true, ultimo_error = null, actualizado = now()
      returning *`;
    return this.aConexion(r);
  }

  async listarConexiones() {
    return (await this.sql`select * from conexiones where activo order by creado`).map(this.aConexion);
  }

  async desactivarConexion(email: string, motivo: string) {
    await this.sql`update conexiones set activo = false, ultimo_error = ${motivo}, actualizado = now() where email = ${email}`;
  }

  async adquirirBloqueo(nombre: string, dueno: string, segundos: number) {
    const rows = await this.sql`
      insert into bloqueos (nombre, dueno, expira) values (${nombre}, ${dueno}, now() + make_interval(secs => ${segundos}))
      on conflict (nombre) do update set dueno = excluded.dueno, expira = excluded.expira
        where bloqueos.expira < now()
      returning dueno`;
    return rows.length === 1 && rows[0].dueno === dueno;
  }

  async liberarBloqueo(nombre: string, dueno: string) {
    await this.sql`delete from bloqueos where nombre = ${nombre} and dueno = ${dueno}`;
  }
}
