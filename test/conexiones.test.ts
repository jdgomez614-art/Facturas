import { beforeAll, describe, expect, it } from "vitest";
import { idBuzon, materializar, scopesUsuario, urlDeAutorizacion, usuarioPermitido } from "../src/conexiones.js";
import { cifrar, descifrar, firmar, verificarFirmado } from "../src/crypto.js";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("crypto", () => {
  it("cifra y descifra; detecta manipulación", () => {
    const c = cifrar("1//refresh-token");
    expect(c).not.toContain("refresh");
    expect(descifrar(c)).toBe("1//refresh-token");
    const partes = c.split(".");
    partes[2] = Buffer.from("otro").toString("base64url");
    expect(() => descifrar(partes.join("."))).toThrow();
  });
  it("firma el state de OAuth", () => {
    const s = firmar("nonce.123");
    expect(verificarFirmado(s)).toBe("nonce.123");
    expect(verificarFirmado(s.replace("nonce", "nonc3"))).toBeNull();
    expect(verificarFirmado("sin-firma")).toBeNull();
  });
});

describe("conexiones", () => {
  it("solo deja entrar a usuarios o dominios permitidos", () => {
    expect(usuarioPermitido("Ana@empresa.com", "ana@empresa.com")).toBe(true);
    expect(usuarioPermitido("luis@empresa.com", "@empresa.com, otro@gmail.com")).toBe(true);
    expect(usuarioPermitido("x@malo.com", "@empresa.com")).toBe(false);
    expect(usuarioPermitido("x@empresa.com", "")).toBe(false); // lista vacía = nadie
  });
  it("pide solo correo + archivos creados por la app, con acceso offline", () => {
    const u = new URL(urlDeAutorizacion({ clientId: "cid", clientSecret: "s", redirectUri: "https://app.test/api/conectar/callback" }, "st"));
    expect(u.searchParams.get("scope")).toBe("openid email https://mail.google.com/ https://www.googleapis.com/auth/drive.file");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")).toBe("st");
  });
  it("convierte una conexión en buzón IMAP + destinos propios", () => {
    const m = materializar(
      { clientId: "cid", clientSecret: "s", redirectUri: "x" },
      { email: "ana@empresa.com", proveedor: "google", refresh_token_cifrado: cifrar("rt"), drive_folder_id: "F1", sheet_id: "S1", activo: true, creado: "2026-11-11T10:00:00.000Z" },
      "Registro de facturas",
    );
    expect(m.buzon).toMatchObject({ id: idBuzon("ana@empresa.com"), host: "imap.gmail.com", user: "ana@empresa.com", desde: "2026-11-11", auth: { tipo: "oauth2", refresh_token: "rt" } });
    expect(m.sheets && m.drive).toBeTruthy();
  });
  it("con carpeta u hoja común de la empresa pide acceso a Drive; si no, solo a lo que crea la app", () => {
    expect(scopesUsuario({})).toContain("https://www.googleapis.com/auth/drive.file");
    expect(scopesUsuario({ DRIVE_FOLDER_ID: "x" })).toContain("https://www.googleapis.com/auth/drive");
  });
});
