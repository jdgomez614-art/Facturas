import { randomUUID } from "node:crypto";
import type { Factura } from "../types.js";
import type { Conexion, EstadoCorreo, FacturaGuardada, Repo } from "./repo.js";

/** Implementación en memoria: para tests y para probar en local sin base de datos. */
export class MemoryRepo implements Repo {
  buzones = new Map<string, { uidvalidity: number; ultimo_uid: number }>();
  correos = new Map<string, { estado: EstadoCorreo; intentos: number; detalle?: string }>();
  facturas = new Map<string, FacturaGuardada>();
  bloqueos = new Map<string, { dueno: string; expira: number }>();

  async obtenerEstadoBuzon(m: string, c: string) {
    return this.buzones.get(`${m}|${c}`) ?? null;
  }
  async guardarEstadoBuzon(m: string, c: string, uidvalidity: number, ultimo_uid: number) {
    this.buzones.set(`${m}|${c}`, { uidvalidity, ultimo_uid });
  }
  async estadoCorreo(clave: string) {
    return this.correos.get(clave) ?? null;
  }
  async marcarCorreo(clave: string, _m: string, _uid: number, estado: EstadoCorreo, detalle?: string) {
    const prev = this.correos.get(clave);
    const intentos = (prev?.intentos ?? 0) + (estado === "error" ? 1 : 0);
    this.correos.set(clave, { estado, intentos, detalle });
    return { intentos };
  }
  async buscarDuplicado(f: Pick<Factura, "cufe" | "nit" | "numero_factura">) {
    for (const x of this.facturas.values()) {
      if (f.cufe && x.cufe === f.cufe) return x.id;
      if (f.nit && f.numero_factura && x.nit === f.nit && x.numero_factura === f.numero_factura && x.estado !== "Descartada") return x.id;
    }
    return null;
  }
  async insertarFactura(f: Factura) {
    const g: FacturaGuardada = { ...f, id: randomUUID(), sheet_fila: null, sheet_sincronizada: false, slack_ts: null, slack_canal: null, slack_notificada: false };
    this.facturas.set(g.id, g);
    return { ...g };
  }
  async obtenerFactura(id: string) {
    const f = this.facturas.get(id);
    return f ? { ...f } : null;
  }
  async pendientesDeSincronizar(limite: number, s: { sheets: boolean; slack: boolean }) {
    return [...this.facturas.values()].filter((f) => (s.sheets && !f.sheet_sincronizada) || (s.slack && !f.slack_notificada)).slice(0, limite).map((f) => ({ ...f }));
  }
  async marcarSheet(id: string, fila: number) {
    const f = this.facturas.get(id)!;
    Object.assign(f, { sheet_fila: fila, sheet_sincronizada: true });
  }
  async marcarSlack(id: string, canal: string, ts: string) {
    Object.assign(this.facturas.get(id)!, { slack_canal: canal, slack_ts: ts, slack_notificada: true });
  }
  async actualizarEstado(id: string, estado: Factura["estado"], fecha_pago: string | null) {
    const f = this.facturas.get(id);
    if (!f) return null;
    Object.assign(f, { estado, fecha_pago });
    return { ...f };
  }
  async porPagar(hasta: string) {
    return [...this.facturas.values()].filter(
      (f) => f.estado === "Pendiente" && f.tipo_movimiento === "Egreso facturación" && (!f.fecha_vencimiento || f.fecha_vencimiento <= hasta),
    );
  }
  conexiones = new Map<string, Conexion>();
  async obtenerConexion(email: string) {
    return this.conexiones.get(email) ?? null;
  }
  async guardarConexion(c: Omit<Conexion, "activo" | "creado">) {
    const g: Conexion = { ...c, activo: true, creado: this.conexiones.get(c.email)?.creado ?? new Date().toISOString() };
    this.conexiones.set(c.email, g);
    return g;
  }
  async listarConexiones() {
    return [...this.conexiones.values()].filter((c) => c.activo);
  }
  async desactivarConexion(email: string) {
    const c = this.conexiones.get(email);
    if (c) c.activo = false;
  }
  async adquirirBloqueo(nombre: string, dueno: string, segundos: number) {
    const b = this.bloqueos.get(nombre);
    if (b && b.expira > Date.now()) return false;
    this.bloqueos.set(nombre, { dueno, expira: Date.now() + segundos * 1000 });
    return true;
  }
  async liberarBloqueo(nombre: string, dueno: string) {
    if (this.bloqueos.get(nombre)?.dueno === dueno) this.bloqueos.delete(nombre);
  }
}
