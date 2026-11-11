import { GoogleAuth } from "google-auth-library";

/** Cualquier cliente de google-auth-library que sepa hacer peticiones autenticadas. */
export interface GoogleHttp {
  request<T>(opts: { url: string; method?: string; data?: unknown; headers?: Record<string, string>; body?: unknown; retry?: boolean }): Promise<{ data: T }>;
}

/** Cuenta de servicio: para los buzones fijos de MAILBOXES_JSON (Sheet compartido con ella / Unidad Compartida).
 *  Las personas que entran con "Conectar con Google" usan su propio acceso (ver conexiones.ts). */
export function httpCuentaServicio(json: string): GoogleHttp {
  return new GoogleAuth({
    credentials: JSON.parse(json),
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  }) as unknown as GoogleHttp;
}
