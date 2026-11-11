import type { EmpresaConfig, Regla } from "../config.js";
import type { DocumentoExtraido } from "../ai/extract.js";
import type { AdjuntosClasificados } from "../mail/attachments.js";
import type { FacturaXml } from "../parse/dian-xml.js";
import type { CorreoEntrante, Factura } from "../types.js";

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const soloDigitos = (s: string | null | undefined) => (s ? s.replace(/\D/g, "") : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Filtro barato antes de gastar una llamada al modelo. */
export function debeProcesar(correo: CorreoEntrante, adj: AdjuntosClasificados, cfg: EmpresaConfig): boolean {
  const from = norm(correo.from);
  if (cfg.remitentes_ignorados.some((r) => from.includes(norm(r)))) return false;
  if (adj.xml.length || adj.pdf.length) return true;
  const texto = norm(`${correo.subject}\n${correo.text.slice(0, 5000)}`);
  return cfg.palabras_clave.some((k) => texto.includes(norm(k)));
}

export function reglaCoincide(regla: Regla, ctx: { remitente: string; texto: string; nit: string }): boolean {
  const { si } = regla;
  const conds: boolean[] = [];
  if (si.remitente_contiene?.length) conds.push(si.remitente_contiene.some((r) => ctx.remitente.includes(norm(r))));
  if (si.texto_contiene?.length) conds.push(si.texto_contiene.some((t) => ctx.texto.includes(norm(t))));
  if (si.nit?.length) conds.push(si.nit.some((n) => soloDigitos(n) === ctx.nit && ctx.nit !== ""));
  // Una regla sin condiciones nunca aplica; con varias, todas deben cumplirse.
  return conds.length > 0 && conds.every(Boolean);
}

/** Empareja documentos del modelo con XML DIAN por número de factura (o 1 a 1 si solo hay uno de cada). */
export function emparejar(docs: DocumentoExtraido[], xmls: FacturaXml[]): { doc: DocumentoExtraido | null; xml: FacturaXml | null }[] {
  const clave = (s: string | null) => (s ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();
  const libres = [...xmls];
  const pares: { doc: DocumentoExtraido | null; xml: FacturaXml | null }[] = docs.map((doc) => {
    let i = libres.findIndex((x) => x.numero && clave(x.numero) === clave(doc.numero_factura));
    if (i < 0 && docs.length === 1 && libres.length === 1) i = 0;
    const xml = i >= 0 ? libres.splice(i, 1)[0] : null;
    return { doc, xml };
  });
  for (const xml of libres) pares.push({ doc: null, xml });
  return pares;
}

export interface Contexto {
  correo: CorreoEntrante;
  cfg: EmpresaConfig;
  /** Pesos colombianos por dólar del día (null si no se pudo consultar). */
  trm: number | null;
}

export function construirFactura(par: { doc: DocumentoExtraido | null; xml: FacturaXml | null }, ctx: Contexto): Factura {
  const { doc, xml } = par;
  const { correo, cfg } = ctx;
  const motivos: string[] = [];
  const reglasAplicadas: string[] = [];

  // 1. Datos base: XML DIAN (oficial) > modelo.
  const emitidaPorNosotros = xml ? esPropio(xml.emisor_nit, cfg) : false;
  const nit = soloDigitos(xml ? (emitidaPorNosotros ? xml.receptor_nit : xml.emisor_nit) : doc?.nit) || null;
  let tipoMovimiento = doc?.tipo_movimiento ?? "Egreso facturación";
  if (xml?.emisor_nit) tipoMovimiento = emitidaPorNosotros ? "Ingreso facturación" : "Egreso facturación";

  const razonSocial = xml ? (emitidaPorNosotros ? xml.receptor_razon_social : xml.emisor_razon_social) : doc?.razon_social ?? null;

  let categoria = doc?.categoria ?? "Otros Egresos";
  let centro = doc?.centro_costos ?? "Sociedad";
  let tipoDocumento: string = doc?.tipo_documento ?? (xml?.tipo === "CreditNote" ? "Nota crédito" : "Factura electrónica");
  let cuenta: string | null = null;
  let medio: Factura["medio_pago"] = doc?.medio_pago ?? "Por definir";
  let ultimos4: string | null = soloDigitos(doc?.tarjeta_ultimos4).slice(-4) || null;
  if (!doc) motivos.push("Clasificación por defecto: el modelo no devolvió este documento");

  // 2. Reglas determinísticas del negocio (ganan sobre el modelo).
  const texto = norm([correo.from, correo.subject, correo.text.slice(0, 20000), razonSocial ?? "", doc?.descripcion ?? "", ...(xml?.descripcion_items ?? [])].join("\n"));
  const rctx = { remitente: norm(correo.from), texto, nit: nit ?? "" };
  const fijado = new Set<string>();
  for (const regla of cfg.reglas) {
    if (!reglaCoincide(regla, rctx)) continue;
    reglasAplicadas.push(regla.nombre);
    const a = regla.asignar;
    const set = (campo: string, fn: () => void) => {
      if (!fijado.has(campo)) {
        fn();
        fijado.add(campo);
      }
    };
    if (a.categoria) set("categoria", () => (categoria = a.categoria!));
    if (a.centro_costos) set("centro", () => (centro = a.centro_costos!));
    if (a.tipo_movimiento) set("tipo_movimiento", () => (tipoMovimiento = a.tipo_movimiento!));
    if (a.tipo_documento) set("tipo_documento", () => (tipoDocumento = a.tipo_documento!));
    if (a.cuenta) set("cuenta", () => (cuenta = a.cuenta!));
    if (a.medio_pago) set("medio", () => (medio = a.medio_pago!));
    if (a.tarjeta) set("tarjeta", () => (ultimos4 = a.tarjeta!));
  }
  if (!fijado.has("centro")) {
    const ref = cfg.referencias_centro_costos.find((r) => r.contiene.some((c) => texto.includes(norm(c))));
    if (ref) {
      centro = ref.centro_costos;
      reglasAplicadas.push(`Referencia → ${ref.centro_costos}`);
    }
  }
  cuenta ??= cfg.cuentas_por_categoria[categoria] ?? null;

  // 3. Tarjeta y medio de pago.
  let tarjeta: string | null = null;
  if (ultimos4) {
    const t = cfg.tarjetas.find((x) => x.ultimos4 === ultimos4);
    if (t) {
      tarjeta = `${t.alias} ****${t.ultimos4}`;
      if (!fijado.has("medio")) medio = t.tipo;
    } else {
      tarjeta = `****${ultimos4}`;
      motivos.push(`Tarjeta ****${ultimos4} no está registrada en la configuración`);
    }
  }

  // 4. Valores.
  const moneda: Factura["moneda"] = xml ? (xml.moneda === "USD" ? "USD" : "COP") : doc?.moneda ?? "COP";
  let bruto = xml ? xml.valor_bruto : doc?.valor_bruto ?? 0;
  const iva = xml ? xml.iva : doc?.iva ?? 0;
  const retefuente = xml ? xml.retefuente : doc?.retefuente ?? 0;
  const reteica = xml ? xml.reteica : doc?.reteica ?? 0;
  const reteiva = xml?.reteiva ?? 0;
  const total = xml ? xml.total_a_pagar : doc?.total_a_pagar ?? 0;
  if (bruto === 0 && total > 0) bruto = round2(total - iva);
  if (total > 0 && Math.abs(bruto + iva - total) / total > cfg.revision.tolerancia_cuadre) {
    motivos.push(`No cuadra: bruto ${bruto} + IVA ${iva} ≠ total ${total}`);
  }
  if (bruto + iva <= 0) motivos.push("Sin valor a pagar");
  const retenciones = round2(retefuente + reteica + reteiva);
  const neto = round2(bruto + iva - retenciones);

  let conv = (n: number) => n;
  let valorUsd: number | null = null;
  if (moneda === "USD") {
    valorUsd = neto;
    if (ctx.trm) conv = (n) => round2(n * ctx.trm!);
    else motivos.push("Factura en USD y no se pudo obtener la TRM: valores quedan en USD");
  } else if (ctx.trm) {
    valorUsd = round2(neto / ctx.trm);
  }

  // 5. Revisión humana.
  const confianza = doc?.confianza ?? (xml ? 0.6 : 0);
  if (confianza < cfg.revision.confianza_minima) motivos.push(`Confianza baja (${Math.round(confianza * 100)}%)`);
  if (doc?.dudas?.length) motivos.push(...doc.dudas);
  const numero = xml?.numero ?? doc?.numero_factura ?? null;
  if (!numero && tipoDocumento !== "Comprobante de pago") motivos.push("Sin número de factura");
  if (!nit) motivos.push("Sin NIT del tercero");

  const estado: Factura["estado"] = doc?.estado_pago === "Pagada" ? "Pagada" : "Pendiente";
  const fecha = xml?.fecha ?? doc?.fecha ?? correo.date.toISOString().slice(0, 10);

  return {
    fecha,
    numero_factura: numero,
    tipo_movimiento: tipoMovimiento,
    categoria,
    descripcion: (doc?.descripcion ?? xml?.descripcion_items.join(", ") ?? correo.subject).slice(0, 200),
    tercero: doc?.tercero ?? (emitidaPorNosotros ? null : xml?.emisor_nombre_comercial) ?? razonSocial,
    nit,
    razon_social: razonSocial,
    cuenta,
    centro_costos: centro,
    valor_bruto: conv(bruto),
    iva: conv(iva),
    retenciones: conv(retenciones),
    retefuente: conv(retefuente),
    reteica: conv(reteica),
    valor_neto: conv(neto),
    valor_usd: valorUsd,
    fecha_pago: estado === "Pagada" ? fecha : null,
    tipo_documento: tipoDocumento,
    medio_pago: medio,
    tarjeta,
    fecha_vencimiento: xml?.fecha_vencimiento ?? doc?.fecha_vencimiento ?? null,
    estado,
    moneda,
    cufe: xml?.cufe ?? null,
    drive_url: null,
    fuente: xml ? "XML DIAN" : "IA",
    confianza,
    requiere_revision: motivos.length > 0,
    motivos_revision: [...new Set(motivos)],
    reglas_aplicadas: reglasAplicadas,
    mailbox_id: correo.mailboxId,
    message_id: correo.messageId,
    remitente: correo.from,
    asunto: correo.subject,
    recibido_en: correo.date.toISOString(),
  };
}

function esPropio(nit: string | null, cfg: EmpresaConfig): boolean {
  const n = soloDigitos(nit);
  // Acepta el NIT con o sin dígito de verificación pegado al final.
  return !!n && cfg.empresa.nits_propios.some((p) => {
    const q = soloDigitos(p);
    return q === n || (n.length === q.length + 1 && n.startsWith(q));
  });
}
