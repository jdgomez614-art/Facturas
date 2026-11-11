import { autorizadoCron, depsProduccion } from "../../src/deps.js";
import { bloquesRecordatorio } from "../../src/notify/slack.js";
import { hoyEn } from "../../src/trm.js";

/** Resumen diario en Slack de lo que hay que pagar (vencido o por vencer). */
export async function GET(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response("No autorizado", { status: 401 });
  const deps = depsProduccion();
  if (!deps.slack) return Response.json({ omitido: "Slack no configurado" });
  const tz = process.env.TZ_NEGOCIO ?? "America/Bogota";
  const hoy = hoyEn(tz);
  const facturas = await deps.repo.porPagar(hoyEn(tz, deps.cfg.recordatorios.dias_antes_vencimiento));
  if (!facturas.length) return Response.json({ pendientes: 0 });
  await deps.slack.publicar(`Pagos pendientes: ${facturas.length}`, bloquesRecordatorio(facturas, hoy));
  return Response.json({ pendientes: facturas.length });
}
