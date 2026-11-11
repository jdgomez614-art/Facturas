import { autorizadoCron, depsProduccion } from "../../src/deps.js";
import { ejecutarPoll } from "../../src/pipeline.js";

export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response("No autorizado", { status: 401 });
  const deps = depsProduccion();
  const resumen = await ejecutarPoll(deps);
  const huboError = resumen.buzones.some((b) => b.error) || resumen.salidas.errores.length > 0;
  return Response.json(resumen, { status: huboError ? 207 : 200 });
}
