import type { Factura } from "../types.js";

export type EstadoCorreo = "procesado" | "ignorado" | "error" | "fallido";

export interface FacturaGuardada extends Factura {
  id: string;
  sheet_fila: number | null;
  sheet_sincronizada: boolean;
  slack_ts: string | null;
  slack_canal: string | null;
  slack_notificada: boolean;
}

/** Una persona que entró con su cuenta y autorizó su correo y su Drive. */
export interface Conexion {
  email: string;
  proveedor: "google";
  refresh_token_cifrado: string;
  drive_folder_id: string | null;
  sheet_id: string | null;
  activo: boolean;
  creado: string; // ISO
}

/** Interfaz de persistencia. Hay una implementación Postgres (producción) y una en memoria (tests / pruebas locales). */
export interface Repo {
  obtenerEstadoBuzon(mailboxId: string, carpeta: string): Promise<{ uidvalidity: number; ultimo_uid: number } | null>;
  guardarEstadoBuzon(mailboxId: string, carpeta: string, uidvalidity: number, ultimoUid: number): Promise<void>;

  estadoCorreo(clave: string): Promise<{ estado: EstadoCorreo; intentos: number } | null>;
  marcarCorreo(clave: string, mailboxId: string, uid: number, estado: EstadoCorreo, detalle?: string): Promise<{ intentos: number }>;

  buscarDuplicado(f: Pick<Factura, "cufe" | "nit" | "numero_factura">): Promise<string | null>;
  insertarFactura(f: Factura): Promise<FacturaGuardada>;
  obtenerFactura(id: string): Promise<FacturaGuardada | null>;
  pendientesDeSincronizar(limite: number, servicios: { sheets: boolean; slack: boolean }): Promise<FacturaGuardada[]>;
  marcarSheet(id: string, fila: number): Promise<void>;
  marcarSlack(id: string, canal: string, ts: string): Promise<void>;
  actualizarEstado(id: string, estado: Factura["estado"], fechaPago: string | null, por: string): Promise<FacturaGuardada | null>;
  porPagar(hastaFecha: string): Promise<FacturaGuardada[]>;

  obtenerConexion(email: string): Promise<Conexion | null>;
  guardarConexion(c: Omit<Conexion, "activo" | "creado">): Promise<Conexion>;
  listarConexiones(): Promise<Conexion[]>;
  desactivarConexion(email: string, motivo: string): Promise<void>;

  adquirirBloqueo(nombre: string, dueno: string, segundos: number): Promise<boolean>;
  liberarBloqueo(nombre: string, dueno: string): Promise<void>;
}
