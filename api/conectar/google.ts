import { randomBytes } from "node:crypto";
import { googleApp, urlDeAutorizacion } from "../../src/conexiones.js";
import { firmar } from "../../src/crypto.js";

/** Paso 1 del login: manda a la persona a la pantalla de permisos de Google. */
export function GET(): Response {
  try {
    const nonce = randomBytes(16).toString("base64url");
    const state = firmar(`${nonce}.${Date.now()}`);
    return new Response(null, {
      status: 302,
      headers: {
        location: urlDeAutorizacion(googleApp(), state),
        "set-cookie": `oauth_nonce=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/conectar; Max-Age=600`,
      },
    });
  } catch (e) {
    return new Response(`Configuración incompleta: ${(e as Error).message}`, { status: 500 });
  }
}
