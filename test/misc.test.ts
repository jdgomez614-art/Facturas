import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv, parseEmpresaConfig } from "../src/config.js";
import { colLetra } from "../src/notify/sheets.js";
import { bloquesFactura, verificarFirmaSlack } from "../src/notify/slack.js";
import { COLUMNAS_SHEET, filaSheet } from "../src/types.js";
import { cfg } from "./helpers.js";

describe("Sheets", () => {
  it("las primeras 18 columnas son exactamente el formato", () => {
    expect(COLUMNAS_SHEET.slice(0, 18)).toEqual([
      "Fecha", "Número Factura", "Tipo de movimiento", "Categoría", "Descripción", "Tercero", "NIT", "Razón Social",
      "Cuenta", "Cemtro de Costos", "Valor bruto", "IVA", "Retenciones", "Retefuente", "ReteICA", "Valor neto", "Valor (USD)", "Fecha de Pago",
    ]);
    expect(colLetra(1)).toBe("A");
    expect(colLetra(27)).toBe("AA");
    expect(colLetra(COLUMNAS_SHEET.length)).toBe("AH");
  });
});

describe("Slack", () => {
  it("verifica la firma", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = "payload=%7B%7D";
    const sig = "v0=" + createHmac("sha256", "s3cr3t").update(`v0:${ts}:${body}`).digest("hex");
    expect(verificarFirmaSlack("s3cr3t", ts, sig, body)).toBe(true);
    expect(verificarFirmaSlack("otro", ts, sig, body)).toBe(false);
    expect(verificarFirmaSlack("s3cr3t", String(Number(ts) - 1000), sig, body)).toBe(false);
  });

  it("muestra botones solo si está pendiente", () => {
    const base = { id: "1", estado: "Pendiente", tipo_movimiento: "Egreso facturación", motivos_revision: [], requiere_revision: false } as never;
    const f = { ...(base as object), tercero: "X", descripcion: "d", valor_neto: 1, valor_usd: null, moneda: "COP", categoria: "c", centro_costos: "Sociedad", medio_pago: "Por definir", tarjeta: null, numero_factura: "1", nit: "1", mailbox_id: "m", asunto: "a", fuente: "IA", tipo_documento: "Cuenta de cobro", remitente: "r", fecha_vencimiento: null };
    expect(JSON.stringify(bloquesFactura(f as never))).toContain("marcar_pagada");
    expect(JSON.stringify(bloquesFactura({ ...f, estado: "Pagada" } as never))).not.toContain("marcar_pagada");
    expect(filaSheet(f as never)).toHaveLength(COLUMNAS_SHEET.length);
  });
});

describe("config", () => {
  it("rechaza reglas que apuntan a valores inexistentes", () => {
    const malo = structuredClone(cfg);
    malo.reglas.push({ nombre: "mala", si: { texto_contiene: ["x"] }, asignar: { categoria: "No existe" } });
    expect(() => parseEmpresaConfig(malo)).toThrow(/categoría desconocida/);
  });
  it("lee buzones del entorno", () => {
    const env = loadEnv({ MAILBOXES_JSON: JSON.stringify([{ id: "a", host: "imap.gmail.com", user: "u@x.com", auth: { tipo: "password", password: "p" } }]) });
    expect(env.mailboxes[0]).toMatchObject({ port: 993, carpeta: "INBOX" });
    expect(() => loadEnv({ MAILBOXES_JSON: JSON.stringify([{ id: "a", host: "h", user: "u", auth: { tipo: "password", password: "p" } }, { id: "a", host: "h", user: "u", auth: { tipo: "password", password: "p" } }]) })).toThrow(/duplicado/);
  });
});
