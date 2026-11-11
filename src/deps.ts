import { ClaudeExtractor } from "./ai/extract.js";
import { empresaConfig, loadEnv } from "./config.js";
import { googleApp, materializar } from "./conexiones.js";
import { ImapLector } from "./mail/imap.js";
import { DriveClient } from "./notify/drive.js";
import { httpCuentaServicio } from "./notify/google-auth.js";
import { SheetsClient } from "./notify/sheets.js";
import { SlackClient } from "./notify/slack.js";
import type { Buzon, Deps } from "./pipeline.js";
import { crearSql, PostgresRepo } from "./store/postgres.js";
import { obtenerTrm } from "./trm.js";

let deps: Deps | undefined;

/** Construye las dependencias de producción a partir de las variables de entorno (una vez por instancia). */
export function depsProduccion(): Deps {
  if (deps) return deps;
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
  const cfg = empresaConfig();
  const repo = new PostgresRepo(crearSql(env.DATABASE_URL));
  const cacheTrm = new Map<string, Promise<number | null>>();

  // Destino común de los buzones fijos (MAILBOXES_JSON).
  const servicio = env.GOOGLE_SERVICE_ACCOUNT_JSON ? httpCuentaServicio(env.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
  const fijos: Buzon[] = env.mailboxes.map((config) => ({
    config,
    sheets: servicio && env.SHEETS_SPREADSHEET_ID ? new SheetsClient(servicio, env.SHEETS_SPREADSHEET_ID, env.SHEETS_TAB) : null,
    drive: servicio && env.DRIVE_FOLDER_ID ? new DriveClient(servicio, env.DRIVE_FOLDER_ID) : null,
  }));

  deps = {
    env,
    cfg,
    repo,
    extractor: new ClaudeExtractor(cfg, env.CLAUDE_MODEL, env.ANTHROPIC_API_KEY),
    lector: new ImapLector(),
    slack: env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID ? new SlackClient(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID) : null,
    buzones: async () => {
      if (!process.env.GOOGLE_CLIENT_ID) return fijos;
      const app = googleApp();
      const conectados = (await repo.listarConexiones()).map((c): Buzon => {
        const m = materializar(app, c, env.SHEETS_TAB);
        return { config: m.buzon, sheets: m.sheets, drive: m.drive, alRevocar: (motivo) => repo.desactivarConexion(c.email, motivo) };
      });
      return [...fijos, ...conectados];
    },
    trm: (fecha) => {
      if (!cacheTrm.has(fecha)) cacheTrm.set(fecha, obtenerTrm(fecha));
      return cacheTrm.get(fecha)!;
    },
    notificarDesde: env.NOTIFICAR_DESDE,
  };
  return deps;
}

/** Vercel Cron envía `Authorization: Bearer $CRON_SECRET`. */
export function autorizadoCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
