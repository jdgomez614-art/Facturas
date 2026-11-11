import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function clave(): Buffer {
  const k = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY debe ser 32 bytes en base64 (genera una con: openssl rand -base64 32)");
  return k;
}

/** AES-256-GCM. Los tokens de acceso al correo/Drive de cada persona nunca se guardan en claro. */
export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave(), iv);
  const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), datos].map((b) => b.toString("base64url")).join(".");
}

export function descifrar(cifrado: string): string {
  const [iv, tag, datos] = cifrado.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", clave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString("utf8");
}

/** Valor firmado (para el parámetro `state` de OAuth): evita que alguien fabrique el retorno de Google. */
export function firmar(valor: string): string {
  return `${valor}.${createHmac("sha256", clave()).update(valor).digest("base64url")}`;
}

export function verificarFirmado(firmado: string): string | null {
  const i = firmado.lastIndexOf(".");
  if (i < 0) return null;
  const valor = firmado.slice(0, i);
  const a = Buffer.from(firmar(valor));
  const b = Buffer.from(firmado);
  return a.length === b.length && timingSafeEqual(a, b) ? valor : null;
}
