/** Ejecuta una corrida completa desde tu computador (usa las mismas variables de entorno que producción).
 *  Con DRY_RUN=1 usa una base en memoria y no escribe en Sheets ni Slack: ideal para probar un buzón nuevo. */
import { ClaudeExtractor } from "../src/ai/extract.js";
import { empresaConfig, loadEnv } from "../src/config.js";
import { depsProduccion } from "../src/deps.js";
import { ImapLector } from "../src/mail/imap.js";
import { ejecutarPoll, type Deps } from "../src/pipeline.js";
import { MemoryRepo } from "../src/store/memory.js";
import { obtenerTrm } from "../src/trm.js";

let deps: Deps;
if (process.env.DRY_RUN) {
  const env = loadEnv();
  const cfg = empresaConfig();
  const repo = new MemoryRepo();
  deps = { env, cfg, repo, extractor: new ClaudeExtractor(cfg, env.CLAUDE_MODEL), lector: new ImapLector(), slack: null, trm: obtenerTrm,
    buzones: async () => env.mailboxes.map((config) => ({ config, sheets: null, drive: null })) };
  const r = await ejecutarPoll(deps);
  console.log(JSON.stringify(r, null, 2));
  console.table([...repo.facturas.values()].map((f) => ({
    fecha: f.fecha, numero: f.numero_factura, tercero: f.tercero, categoria: f.categoria, centro: f.centro_costos,
    neto: f.valor_neto, medio: f.medio_pago, tarjeta: f.tarjeta, revisar: f.requiere_revision ? f.motivos_revision.join("; ") : "",
  })));
} else {
  deps = depsProduccion();
  console.log(JSON.stringify(await ejecutarPoll(deps), null, 2));
}
process.exit(0);
