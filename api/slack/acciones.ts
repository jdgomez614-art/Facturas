import { waitUntil } from "@vercel/functions";
import { aplicarAccion, type Accion } from "../../src/acciones.js";
import { depsProduccion } from "../../src/deps.js";
import { verificarFirmaSlack } from "../../src/notify/slack.js";

/** Endpoint de "Interactivity" de la app de Slack (botones Marcar pagada / Descartar). */
export async function POST(req: Request): Promise<Response> {
  const cuerpo = await req.text();
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !verificarFirmaSlack(secret, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"), cuerpo)) {
    return new Response("Firma inválida", { status: 401 });
  }
  const payload = JSON.parse(new URLSearchParams(cuerpo).get("payload") ?? "{}") as {
    type?: string;
    user?: { id: string };
    actions?: { action_id: string; value: string }[];
  };
  const accion = payload.actions?.[0];
  if (payload.type !== "block_actions" || !accion || !["marcar_pagada", "descartar"].includes(accion.action_id)) {
    return new Response("", { status: 200 });
  }
  // Slack exige respuesta en < 3 s: se responde ya y el trabajo sigue en segundo plano.
  waitUntil(
    aplicarAccion(depsProduccion(), accion.action_id as Accion, accion.value, payload.user?.id ?? "desconocido", process.env.TZ_NEGOCIO ?? "America/Bogota").catch((e) =>
      console.error(JSON.stringify({ ev: "accion_error", error: (e as Error).message })),
    ),
  );
  return new Response("", { status: 200 });
}
