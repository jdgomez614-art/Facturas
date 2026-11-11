import { readFileSync } from "node:fs";
import { parseEmpresaConfig } from "../src/config.js";
import type { DocumentoExtraido } from "../src/ai/extract.js";
import type { CorreoEntrante } from "../src/types.js";

export const cfg = parseEmpresaConfig(JSON.parse(readFileSync(new URL("../config/empresa.json", import.meta.url), "utf8")));
export const invoiceXml = readFileSync(new URL("./fixtures/invoice.xml", import.meta.url), "utf8");

/** Envuelve la factura en un AttachedDocument, como la envía la DIAN. */
export const attachedDocument = `<?xml version="1.0" encoding="UTF-8"?>
<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>AD-1</cbc:ID>
  <cac:Attachment><cac:ExternalReference><cbc:MimeCode>text/xml</cbc:MimeCode><cbc:Description><![CDATA[${invoiceXml}]]></cbc:Description></cac:ExternalReference></cac:Attachment>
</AttachedDocument>`;

export function correo(p: Partial<CorreoEntrante> = {}): CorreoEntrante {
  return {
    mailboxId: "facturacion",
    uid: 1,
    messageId: "<m1@test>",
    from: "Facturación <facturas@proveedor.com>",
    subject: "Factura electrónica",
    date: new Date("2026-11-04T15:00:00Z"),
    text: "Adjuntamos su factura.",
    adjuntos: [],
    ...p,
  };
}

export function doc(p: Partial<DocumentoExtraido> = {}): DocumentoExtraido {
  return {
    tipo_documento: "Cuenta de cobro",
    numero_factura: "CC-7",
    fecha: "2026-11-01",
    fecha_vencimiento: "2026-11-15",
    tercero: "Juan Pérez",
    nit: "79123456",
    razon_social: "Juan Pérez",
    descripcion: "Asesoría legal octubre",
    tipo_movimiento: "Egreso facturación",
    categoria: "Honorarios",
    nit_sociedad: null,
    centro_costos: "TROOP TEAM",
    moneda: "COP",
    valor_bruto: 2_000_000,
    iva: 0,
    retefuente: 0,
    reteica: 0,
    total_a_pagar: 2_000_000,
    estado_pago: "Pendiente",
    medio_pago: "Por definir",
    tarjeta_ultimos4: null,
    confianza: 0.95,
    dudas: [],
    ...p,
  };
}
