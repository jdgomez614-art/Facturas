import { OAuth2Client } from "google-auth-library";
import type { MailboxConfig } from "./config.js";
import { cifrar, descifrar } from "./crypto.js";
import { DriveClient } from "./notify/drive.js";
import type { GoogleHttp } from "./notify/google-auth.js";
import { SheetsClient } from "./notify/sheets.js";
import type { Conexion, Repo } from "./store/repo.js";

/** Permisos que se le piden a cada persona:
 *  - mail.google.com: leer su correo por IMAP (el sistema lo abre en solo lectura).
 *  - Drive: si la empresa definió una carpeta y/o una hoja comunes (DRIVE_FOLDER_ID / SHEETS_SPREADSHEET_ID), se pide
 *    acceso a Drive para poder escribir en ellas, que ya existen. Si no, solo "drive.file": la app únicamente ve la
 *    carpeta y la hoja que ella misma le crea a cada persona. */
export function scopesUsuario(env: NodeJS.ProcessEnv = process.env): string[] {
  const comun = !!(env.DRIVE_FOLDER_ID || env.SHEETS_SPREADSHEET_ID);
  return ["openid", "email", "https://mail.google.com/", `https://www.googleapis.com/auth/${comun ? "drive" : "drive.file"}`];
}
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleApp(env: NodeJS.ProcessEnv = process.env): GoogleApp {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_URL) throw new Error("Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o APP_URL");
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: `${APP_URL.replace(/\/$/, "")}/api/conectar/callback` };
}

export function urlDeAutorizacion(app: GoogleApp, state: string): string {
  return new OAuth2Client(app.clientId, app.clientSecret, app.redirectUri).generateAuthUrl({
    access_type: "offline", // para recibir refresh_token y seguir funcionando sin la persona presente
    prompt: "consent",
    scope: scopesUsuario(),
    state,
  });
}

/** USUARIOS_PERMITIDOS="ana@empresa.com,@empresa.com". Sin esta lista nadie puede conectarse (evita que un extraño use tu sistema). */
export function usuarioPermitido(email: string, lista = process.env.USUARIOS_PERMITIDOS ?? ""): boolean {
  const e = email.toLowerCase();
  return lista.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).some((p) => (p.startsWith("@") ? e.endsWith(p) : e === p));
}

export function httpDeUsuario(app: GoogleApp, refreshToken: string): GoogleHttp {
  const c = new OAuth2Client(app.clientId, app.clientSecret);
  c.setCredentials({ refresh_token: refreshToken });
  return c as unknown as GoogleHttp;
}

/** Termina el login: intercambia el código, valida a la persona y le crea su carpeta y su hoja (una sola vez). */
export async function completarConexion(app: GoogleApp, repo: Repo, code: string, pestana: string): Promise<Conexion> {
  const oauth = new OAuth2Client(app.clientId, app.clientSecret, app.redirectUri);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw new Error("Google no devolvió la identidad del usuario");
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: app.clientId });
  const p = ticket.getPayload();
  const email = p?.email_verified ? p.email?.toLowerCase() : undefined;
  if (!email) throw new Error("No se pudo verificar el correo de la cuenta");
  if (!usuarioPermitido(email)) throw new ErrorNoPermitido(email);
  for (const s of scopesUsuario().slice(2)) {
    if (!tokens.scope?.split(" ").includes(s)) throw new Error("Faltó aceptar todos los permisos (correo y Drive). Intenta de nuevo y marca todas las casillas.");
  }

  const previa = await repo.obtenerConexion(email);
  const refresh = tokens.refresh_token ?? (previa ? descifrar(previa.refresh_token_cifrado) : null);
  if (!refresh) throw new Error("Google no entregó un token permanente. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a conectar.");

  const http = httpDeUsuario(app, refresh);
  let { drive_folder_id, sheet_id } = previa ?? { drive_folder_id: null, sheet_id: null };
  // Con carpeta/hoja comunes de la empresa no se le crea nada personal a cada usuario.
  if (!drive_folder_id && !process.env.DRIVE_FOLDER_ID) {
    const r = await http.request<{ id: string }>({
      url: "https://www.googleapis.com/drive/v3/files?fields=id",
      method: "POST",
      data: { name: "Facturas (automático)", mimeType: "application/vnd.google-apps.folder" },
    });
    drive_folder_id = r.data.id;
  }
  if (!sheet_id && !process.env.SHEETS_SPREADSHEET_ID) {
    const r = await http.request<{ spreadsheetId: string }>({
      url: "https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId",
      method: "POST",
      data: { properties: { title: "Registro de facturas (automático)" }, sheets: [{ properties: { title: pestana, gridProperties: { frozenRowCount: 1 } } }] },
    });
    sheet_id = r.data.spreadsheetId;
    await new SheetsClient(http, sheet_id, pestana).asegurarEncabezado();
  }
  return repo.guardarConexion({ email, proveedor: "google", refresh_token_cifrado: cifrar(refresh), drive_folder_id, sheet_id });
}

export class ErrorNoPermitido extends Error {
  constructor(public email: string) {
    super(`La cuenta ${email} no está autorizada para usar este sistema`);
  }
}

export const idBuzon = (email: string) => `g-${email.replace(/[^a-z0-9]+/gi, "-")}`;

/** Convierte una conexión guardada en un buzón IMAP + sus destinos (su Sheet y su carpeta de Drive). */
export function materializar(app: GoogleApp, c: Conexion, pestana: string, comun: { carpeta?: string; hoja?: string } = {}) {
  const sheetId = comun.hoja ?? c.sheet_id;
  const folderId = comun.carpeta ?? c.drive_folder_id;
  const refresh = descifrar(c.refresh_token_cifrado);
  const http = httpDeUsuario(app, refresh);
  const buzon: MailboxConfig = {
    id: idBuzon(c.email),
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: c.email,
    carpeta: "INBOX",
    desde: c.creado.slice(0, 10), // solo correos desde el día en que se conectó
    auth: { tipo: "oauth2", token_url: TOKEN_URL, client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refresh },
  };
  return {
    buzon,
    sheets: sheetId ? new SheetsClient(http, sheetId, pestana) : null,
    drive: folderId ? new DriveClient(http, folderId) : null,
  };
}
