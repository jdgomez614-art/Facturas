/** Un registro de factura. Los primeros 18 campos son, en orden, las columnas del formato
 *  "Formato registro de facturas"; el resto son columnas de control que se agregan a la derecha. */
export interface Factura {
  id?: string;
  // ---- Formato (A..R) ----
  fecha: string | null; // YYYY-MM-DD (fecha de emisión)
  numero_factura: string | null;
  tipo_movimiento: string; // Ingreso facturación | Egreso facturación
  categoria: string;
  descripcion: string;
  tercero: string | null; // nombre comercial
  nit: string | null;
  razon_social: string | null;
  cuenta: string | null;
  centro_costos: string;
  valor_bruto: number;
  iva: number;
  retenciones: number;
  retefuente: number;
  reteica: number;
  valor_neto: number;
  valor_usd: number | null;
  fecha_pago: string | null;
  // ---- Control ----
  tipo_documento: string;
  medio_pago: "Crédito" | "Débito" | "Por definir";
  tarjeta: string | null; // "Visa Corporativa ****1234"
  fecha_vencimiento: string | null;
  estado: "Pendiente" | "Pagada" | "Descartada";
  moneda: "COP" | "USD";
  cufe: string | null;
  /** Enlace al archivo de la factura en Google Drive. */
  drive_url: string | null;
  fuente: "XML DIAN" | "IA";
  confianza: number;
  requiere_revision: boolean;
  motivos_revision: string[];
  reglas_aplicadas: string[];
  mailbox_id: string;
  message_id: string;
  remitente: string;
  asunto: string;
  recibido_en: string; // ISO
}

export const COLUMNAS_SHEET = [
  "Fecha", "Número Factura", "Tipo de movimiento", "Categoría", "Descripción", "Tercero", "NIT",
  "Razón Social", "Cuenta", "Cemtro de Costos", "Valor bruto", "IVA", "Retenciones", "Retefuente",
  "ReteICA", "Valor neto", "Valor (USD)", "Fecha de Pago",
  // columnas extra (S en adelante)
  "Tipo documento", "Medio de pago", "Tarjeta", "Fecha vencimiento", "Estado", "Moneda", "CUFE",
  "Fuente", "Confianza", "Requiere revisión", "Motivos revisión", "Remitente", "Asunto", "Recibido", "Archivo (Drive)", "ID sistema",
] as const;

export function filaSheet(f: Factura): (string | number)[] {
  const n = (x: number | null) => (x === null ? "" : x);
  return [
    f.fecha ?? "", f.numero_factura ?? "", f.tipo_movimiento, f.categoria, f.descripcion, f.tercero ?? "",
    f.nit ?? "", f.razon_social ?? "", f.cuenta ?? "", f.centro_costos, f.valor_bruto, f.iva, f.retenciones,
    f.retefuente, f.reteica, f.valor_neto, n(f.valor_usd), f.fecha_pago ?? "",
    f.tipo_documento, f.medio_pago, f.tarjeta ?? "", f.fecha_vencimiento ?? "", f.estado, f.moneda, f.cufe ?? "",
    f.fuente, Math.round(f.confianza * 100) / 100, f.requiere_revision ? "Sí" : "No", f.motivos_revision.join("; "),
    f.remitente, f.asunto, f.recibido_en, f.drive_url ?? "", f.id ?? "",
  ];
}

export interface Adjunto {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface CorreoEntrante {
  mailboxId: string;
  uid: number;
  messageId: string;
  from: string;
  subject: string;
  date: Date;
  text: string;
  adjuntos: Adjunto[];
}
