import { completarConexion, ErrorNoPermitido, googleApp } from "../../src/conexiones.js";
import { verificarFirmado } from "../../src/crypto.js";
import { depsProduccion } from "../../src/deps.js";

const ir = (params: Record<string, string>) =>
  new Response(null, { status: 302, headers: { location: `/?${new URLSearchParams(params)}`, "set-cookie": "oauth_nonce=; Path=/api/conectar; Max-Age=0" } });

/** Paso 2 del login: Google devuelve a la persona aquí con un código de un solo uso. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return ir({ error: "Cancelaste la autorización." });

  // Anti-CSRF: el state debe venir firmado por nosotros, ser reciente y coincidir con la cookie de este navegador.
  const valor = verificarFirmado(url.searchParams.get("state") ?? "");
  const [nonce, ts] = valor?.split(".") ?? [];
  const cookie = /(?:^|;\s*)oauth_nonce=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (!nonce || nonce !== cookie || Date.now() - Number(ts) > 600_000) return ir({ error: "La sesión de conexión venció. Intenta de nuevo." });

  const code = url.searchParams.get("code");
  if (!code) return ir({ error: "Google no devolvió el código de autorización." });
  try {
    const deps = depsProduccion();
    const c = await completarConexion(googleApp(), deps.repo, code, process.env.SHEETS_TAB ?? "Registro de facturas");
    return ir({ ok: c.email, sheet: process.env.SHEETS_SPREADSHEET_ID ?? c.sheet_id ?? "", carpeta: process.env.DRIVE_FOLDER_ID ?? c.drive_folder_id ?? "" });
  } catch (e) {
    if (e instanceof ErrorNoPermitido) return ir({ error: e.message });
    console.error(JSON.stringify({ ev: "conexion_error", error: (e as Error).message }));
    return ir({ error: (e as Error).message.slice(0, 200) });
  }
}
