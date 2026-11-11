import { empresaConfig, loadEnv } from "../src/config.js";

/** Verifica que la configuración cargue sin exponer secretos. */
export function GET(): Response {
  try {
    const env = loadEnv();
    const cfg = empresaConfig();
    return Response.json({
      ok: true,
      buzones_fijos: env.mailboxes.map((m) => m.id),
      base_de_datos: !!env.DATABASE_URL,
      claude: !!env.ANTHROPIC_API_KEY,
      buzones_fijos_sheets: !!(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.SHEETS_SPREADSHEET_ID),
      buzones_fijos_drive: !!(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.DRIVE_FOLDER_ID),
      login_google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_URL && process.env.ENCRYPTION_KEY),
      usuarios_permitidos: !!process.env.USUARIOS_PERMITIDOS,
      slack: !!(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID),
      categorias: cfg.categorias.length,
      centros_costos: cfg.centros_costos.length,
      reglas: cfg.reglas.length,
    });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
