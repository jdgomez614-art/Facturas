import type { Deps } from "./pipeline.js";
import { bloquesFactura, titulo } from "./notify/slack.js";
import { hoyEn } from "./trm.js";

export type Accion = "marcar_pagada" | "descartar";

/** Aplica una acción de Slack: actualiza base de datos, fila del Sheet y el mensaje original. */
export async function aplicarAccion(deps: Deps, accion: Accion, facturaId: string, usuario: string, tz: string) {
  const actual = await deps.repo.obtenerFactura(facturaId);
  if (!actual) throw new Error(`Factura ${facturaId} no existe`);
  const f =
    accion === "marcar_pagada"
      ? await deps.repo.actualizarEstado(facturaId, "Pagada", hoyEn(tz), usuario)
      : await deps.repo.actualizarEstado(facturaId, "Descartada", null, usuario);
  if (!f) return;
  const errores: string[] = [];
  const sheets = (await deps.buzones()).find((b) => b.config.id === f.mailbox_id)?.sheets;
  if (sheets && f.sheet_fila) await sheets.actualizar(f.sheet_fila, f).catch((e) => errores.push(`Sheets: ${e.message}`));
  if (deps.slack && f.slack_canal && f.slack_ts && f.slack_ts !== "omitido") {
    const blocks = [...bloquesFactura(f), { type: "context", elements: [{ type: "mrkdwn", text: `Actualizado por <@${usuario}>` }] }];
    await deps.slack.actualizar(f.slack_canal, f.slack_ts, titulo(f), blocks).catch((e) => errores.push(`Slack: ${e.message}`));
  }
  if (errores.length) console.error(JSON.stringify({ ev: "accion_parcial", facturaId, errores }));
}
