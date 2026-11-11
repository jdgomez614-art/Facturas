import { createHmac, timingSafeEqual } from "node:crypto";
import type { FacturaGuardada } from "../store/repo.js";

const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatoValor(f: Pick<FacturaGuardada, "valor_neto" | "valor_usd" | "moneda">): string {
  const base = cop.format(f.valor_neto);
  return f.moneda === "USD" && f.valor_usd !== null ? `${usd.format(f.valor_usd)} (${base})` : base;
}

export function titulo(f: FacturaGuardada): string {
  if (f.estado === "Descartada") return "🗑️ Documento descartado";
  if (f.tipo_movimiento === "Ingreso facturación") return "💰 Factura emitida — por cobrar";
  if (f.estado === "Pagada") return "💳 Pago registrado";
  const tipo = f.tipo_documento === "Cuenta de cobro" ? "Llegó una cuenta de cobro" : `Llegó: ${f.tipo_documento.toLowerCase()}`;
  return `🧾 ${tipo} — hay que pagar`;
}

type Bloque = Record<string, unknown>;

export function bloquesFactura(f: FacturaGuardada): Bloque[] {
  const campo = (k: string, v: string | null | undefined) => ({ type: "mrkdwn", text: `*${k}:*\n${v || "—"}` });
  const quien = f.tercero ?? f.razon_social ?? f.remitente;
  const bloques: Bloque[] = [
    { type: "header", text: { type: "plain_text", text: titulo(f).slice(0, 150) } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escape(quien)}* · ${escape(f.descripcion)}` },
    },
    {
      type: "section",
      fields: [
        campo("Valor neto", formatoValor(f)),
        campo("Vence", f.fecha_vencimiento),
        campo("Categoría", f.categoria),
        campo("Centro de costos", f.centro_costos),
        campo("Medio de pago", f.tarjeta ? `${f.medio_pago} · ${f.tarjeta}` : f.medio_pago),
        campo("Factura", [f.numero_factura, f.nit ? `NIT ${f.nit}` : null].filter(Boolean).join(" · ")),
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `📥 ${escape(f.mailbox_id)} · ${escape(f.asunto).slice(0, 120)} · fuente: ${f.fuente}` }],
    },
  ];
  if (f.drive_url) bloques.push({ type: "context", elements: [{ type: "mrkdwn", text: `📎 <${f.drive_url}|Ver archivo en Drive>` }] });
  if (f.requiere_revision) {
    bloques.push({ type: "section", text: { type: "mrkdwn", text: `⚠️ *Revisar:* ${escape(f.motivos_revision.join(" · ")).slice(0, 2500)}` } });
  }
  if (f.estado === "Pendiente") {
    const acciones: Bloque[] = [];
    if (f.tipo_movimiento === "Egreso facturación") {
      acciones.push({ type: "button", style: "primary", text: { type: "plain_text", text: "✅ Marcar pagada" }, action_id: "marcar_pagada", value: f.id });
    }
    acciones.push({
      type: "button",
      text: { type: "plain_text", text: "🗑️ Descartar" },
      action_id: "descartar",
      value: f.id,
      confirm: {
        title: { type: "plain_text", text: "¿Descartar?" },
        text: { type: "plain_text", text: "Se marcará como descartada (no es una factura o está duplicada)." },
        confirm: { type: "plain_text", text: "Descartar" },
        deny: { type: "plain_text", text: "Cancelar" },
      },
    });
    bloques.push({ type: "actions", elements: acciones });
  } else if (f.fecha_pago) {
    bloques.push({ type: "context", elements: [{ type: "mrkdwn", text: `Pagada el ${f.fecha_pago}` }] });
  }
  return bloques;
}

export function bloquesRecordatorio(facturas: FacturaGuardada[], hoy: string): Bloque[] {
  const vencidas = facturas.filter((f) => f.fecha_vencimiento && f.fecha_vencimiento < hoy);
  const total = facturas.reduce((s, f) => s + f.valor_neto, 0);
  const linea = (f: FacturaGuardada) =>
    `• ${f.fecha_vencimiento && f.fecha_vencimiento < hoy ? "🔴" : f.fecha_vencimiento ? "🟡" : "⚪"} *${escape(f.tercero ?? f.razon_social ?? "?")}* — ${formatoValor(f)} — vence ${f.fecha_vencimiento ?? "sin fecha"} — ${f.centro_costos}${f.tarjeta ? ` — ${f.tarjeta}` : ""}`;
  const lineas = facturas.slice(0, 40).map(linea);
  if (facturas.length > 40) lineas.push(`…y ${facturas.length - 40} más (ver el Sheet)`);
  return [
    { type: "header", text: { type: "plain_text", text: `📅 Pagos pendientes: ${facturas.length}` } },
    { type: "section", text: { type: "mrkdwn", text: `Total: *${cop.format(total)}* · Vencidas: *${vencidas.length}*` } },
    { type: "section", text: { type: "mrkdwn", text: lineas.join("\n").slice(0, 2900) } },
  ];
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class SlackClient {
  constructor(private token: string, public canal: string) {}

  private async api<T extends { ok: boolean; error?: string }>(metodo: string, body: unknown): Promise<T> {
    for (let intento = 0; ; intento++) {
      const res = await fetch(`https://slack.com/api/${metodo}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && intento < 3) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 1) * 1000));
        continue;
      }
      const data = (await res.json()) as T;
      if (!data.ok) throw new Error(`Slack ${metodo}: ${data.error}`);
      return data;
    }
  }

  async publicar(texto: string, blocks: Bloque[]): Promise<{ canal: string; ts: string }> {
    const r = await this.api<{ ok: boolean; channel: string; ts: string }>("chat.postMessage", { channel: this.canal, text: texto, blocks, unfurl_links: false });
    return { canal: r.channel, ts: r.ts };
  }

  async actualizar(canal: string, ts: string, texto: string, blocks: Bloque[]): Promise<void> {
    await this.api("chat.update", { channel: canal, ts, text: texto, blocks });
  }

  async notificarFactura(f: FacturaGuardada) {
    return this.publicar(`${titulo(f)}: ${f.tercero ?? f.razon_social ?? ""} ${formatoValor(f)}`, bloquesFactura(f));
  }

  async alerta(texto: string) {
    return this.publicar(texto, [{ type: "section", text: { type: "mrkdwn", text: escape(texto).slice(0, 2900) } }]);
  }
}

/** Verifica la firma de Slack (https://api.slack.com/authentication/verifying-requests-from-slack). */
export function verificarFirmaSlack(secret: string, timestamp: string | null, firma: string | null, cuerpo: string, ahora = Date.now()): boolean {
  if (!timestamp || !firma) return false;
  if (Math.abs(ahora / 1000 - Number(timestamp)) > 300) return false;
  const esperado = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${cuerpo}`).digest("hex");
  const a = Buffer.from(esperado);
  const b = Buffer.from(firma);
  return a.length === b.length && timingSafeEqual(a, b);
}
