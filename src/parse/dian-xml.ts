import { XMLParser } from "fast-xml-parser";

/** Datos extraídos de forma determinística de una factura electrónica DIAN (UBL 2.1). */
export interface FacturaXml {
  tipo: "Invoice" | "CreditNote" | "DebitNote";
  numero: string | null;
  cufe: string | null;
  fecha: string | null;
  fecha_vencimiento: string | null;
  moneda: string;
  emisor_nit: string | null;
  emisor_razon_social: string | null;
  emisor_nombre_comercial: string | null;
  receptor_nit: string | null;
  receptor_razon_social: string | null;
  valor_bruto: number; // LineExtensionAmount (antes de impuestos)
  iva: number;
  retefuente: number;
  reteica: number;
  reteiva: number;
  total_a_pagar: number; // PayableAmount
  descripcion_items: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false, // NITs y números de factura deben quedar como texto
  trimValues: true,
  processEntities: true,
});

type Nodo = Record<string, unknown>;
const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const txt = (x: unknown): string | null => {
  if (x === undefined || x === null) return null;
  if (typeof x === "object") return txt((x as Nodo)["#text"]);
  const s = String(x).trim();
  return s === "" ? null : s;
};
const num = (x: unknown): number => {
  const s = txt(x);
  const n = s === null ? 0 : Number(s);
  return Number.isFinite(n) ? n : 0;
};
const get = (n: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? arr((acc as Nodo)[k] as unknown)[0] : undefined), n);

const CODIGOS = { IVA: "01", RETEIVA: "05", RETEFUENTE: "06", RETEICA: "07" } as const;

function sumarImpuestos(totales: unknown[], codigo: string): number {
  let total = 0;
  for (const t of totales) {
    for (const sub of arr((t as Nodo).TaxSubtotal as Nodo | Nodo[])) {
      const id = txt(get(sub, "TaxCategory", "TaxScheme", "ID"));
      if (id === codigo) total += num(sub.TaxAmount);
    }
  }
  return round2(total);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function nit(party: unknown): string | null {
  const id = txt(get(party, "Party", "PartyTaxScheme", "CompanyID")) ?? txt(get(party, "Party", "PartyLegalEntity", "CompanyID"));
  return id ? id.replace(/[^\dA-Za-z]/g, "") : null;
}

function documentoDesdeRaiz(root: Nodo): FacturaXml | null {
  const tipoKey = (["Invoice", "CreditNote", "DebitNote"] as const).find((k) => k in root);
  if (!tipoKey) return null;
  const d = root[tipoKey] as Nodo;
  const sup = get(d, "AccountingSupplierParty");
  const cus = get(d, "AccountingCustomerParty");
  const totals = get(d, "LegalMonetaryTotal");
  const taxTotals = arr(d.TaxTotal as Nodo | Nodo[]);
  const withholding = arr(d.WithholdingTaxTotal as Nodo | Nodo[]);
  const lineKey = tipoKey === "Invoice" ? "InvoiceLine" : tipoKey === "CreditNote" ? "CreditNoteLine" : "DebitNoteLine";
  const items = arr(d[lineKey] as Nodo | Nodo[])
    .map((l) => txt(get(l, "Item", "Description")))
    .filter((s): s is string => !!s);

  return {
    tipo: tipoKey,
    numero: txt(get(d, "ID")),
    cufe: txt(get(d, "UUID")),
    fecha: txt(get(d, "IssueDate")),
    fecha_vencimiento: txt(get(d, "DueDate")) ?? txt(get(d, "PaymentMeans", "PaymentDueDate")),
    moneda: txt(get(d, "DocumentCurrencyCode")) ?? "COP",
    emisor_nit: nit(sup),
    emisor_razon_social: txt(get(sup, "Party", "PartyTaxScheme", "RegistrationName")) ?? txt(get(sup, "Party", "PartyLegalEntity", "RegistrationName")),
    emisor_nombre_comercial: txt(get(sup, "Party", "PartyName", "Name")),
    receptor_nit: nit(cus),
    receptor_razon_social: txt(get(cus, "Party", "PartyTaxScheme", "RegistrationName")) ?? txt(get(cus, "Party", "PartyLegalEntity", "RegistrationName")),
    valor_bruto: round2(num(get(totals, "LineExtensionAmount"))),
    iva: sumarImpuestos(taxTotals, CODIGOS.IVA),
    retefuente: sumarImpuestos(withholding, CODIGOS.RETEFUENTE),
    reteica: sumarImpuestos(withholding, CODIGOS.RETEICA),
    reteiva: sumarImpuestos(withholding, CODIGOS.RETEIVA),
    total_a_pagar: round2(num(get(totals, "PayableAmount"))),
    descripcion_items: items.slice(0, 10),
  };
}

/** Acepta un Invoice/CreditNote directo o el AttachedDocument (contenedor DIAN que trae la factura embebida en CDATA). */
export function parseFacturaDian(xml: string | Buffer): FacturaXml | null {
  let root: Nodo;
  try {
    root = parser.parse(typeof xml === "string" ? xml : xml.toString("utf8")) as Nodo;
  } catch {
    return null;
  }
  if ("AttachedDocument" in root) {
    const ad = root.AttachedDocument as Nodo;
    const embebido = txt(get(ad, "Attachment", "ExternalReference", "Description"));
    if (embebido) {
      const doc = parseFacturaDian(embebido);
      if (doc) {
        // El AttachedDocument también trae el CUFE de la factura en ParentDocumentLineReference.
        doc.cufe ??= txt(get(ad, "ParentDocumentLineReference", "DocumentReference", "UUID"));
        return doc;
      }
    }
    return null;
  }
  return documentoDesdeRaiz(root);
}
