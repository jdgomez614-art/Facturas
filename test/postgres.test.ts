import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { construirFactura } from "../src/classify/index.js";
import { parseFacturaDian } from "../src/parse/dian-xml.js";
import { crearSql, PostgresRepo } from "../src/store/postgres.js";
import { cfg, correo, doc, invoiceXml } from "./helpers.js";

// Prueba de integración: solo corre si hay una base de pruebas (TEST_DATABASE_URL).
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgresRepo (integración)", () => {
  const sql = crearSql(url ?? "postgres://x");
  const repo = new PostgresRepo(sql);
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

  beforeAll(async () => {
    await sql.unsafe("drop table if exists facturas, correos_procesados, buzon_estado, bloqueos, conexiones");
    await sql.unsafe(schema);
    await sql.unsafe(schema); // idempotente
  });
  afterAll(() => sql.end());

  const factura = () => construirFactura({ doc: doc({ numero_factura: "FE-1234" }), xml: parseFacturaDian(invoiceXml) }, { correo: correo(), cfg, trm: 4000 });

  it("inserta, lee con tipos correctos y bloquea duplicados", async () => {
    const f = await repo.insertarFactura({ ...factura(), drive_url: "https://drive/x" });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    const leida = (await repo.obtenerFactura(f.id))!;
    expect(leida).toMatchObject({ fecha: "2026-11-03", valor_neto: 1_140_340, valor_usd: 285.08, cufe: "abc123cufe", drive_url: "https://drive/x", requiere_revision: false, recibido_en: "2026-11-04T15:00:00.000Z" });
    expect(leida.motivos_revision).toEqual([]);
    expect(await repo.buscarDuplicado(factura())).toBe(f.id);
    await expect(repo.insertarFactura(factura())).rejects.toMatchObject({ code: "23505" });
  });

  it("outbox, pago y pendientes por pagar", async () => {
    const [f] = await repo.pendientesDeSincronizar(10, { sheets: true, slack: true });
    await repo.marcarSheet(f.id, 5);
    expect(await repo.pendientesDeSincronizar(10, { sheets: true, slack: false })).toHaveLength(0);
    expect(await repo.pendientesDeSincronizar(10, { sheets: true, slack: true })).toHaveLength(1);
    await repo.marcarSlack(f.id, "C1", "1.2");
    expect(await repo.porPagar("2026-11-20")).toHaveLength(1);
    expect(await repo.porPagar("2026-11-10")).toHaveLength(0);
    const pagada = await repo.actualizarEstado(f.id, "Pagada", "2026-11-12", "U1");
    expect(pagada).toMatchObject({ estado: "Pagada", fecha_pago: "2026-11-12", sheet_fila: 5 });
    expect(await repo.porPagar("2026-11-20")).toHaveLength(0);
  });

  it("estado de buzón, reintentos, bloqueo y conexiones", async () => {
    expect(await repo.obtenerEstadoBuzon("m", "INBOX")).toBeNull();
    await repo.guardarEstadoBuzon("m", "INBOX", 7, 10);
    await repo.guardarEstadoBuzon("m", "INBOX", 7, 12);
    expect(await repo.obtenerEstadoBuzon("m", "INBOX")).toEqual({ uidvalidity: 7, ultimo_uid: 12 });

    expect((await repo.marcarCorreo("k", "m", 1, "error", "x")).intentos).toBe(1);
    expect((await repo.marcarCorreo("k", "m", 1, "error", "x")).intentos).toBe(2);
    expect((await repo.marcarCorreo("k", "m", 1, "fallido", "x")).intentos).toBe(2);
    expect(await repo.estadoCorreo("k")).toEqual({ estado: "fallido", intentos: 2 });

    expect(await repo.adquirirBloqueo("poll", "a", 60)).toBe(true);
    expect(await repo.adquirirBloqueo("poll", "b", 60)).toBe(false);
    await repo.liberarBloqueo("poll", "a");
    expect(await repo.adquirirBloqueo("poll", "b", 60)).toBe(true);

    const c = await repo.guardarConexion({ email: "ana@x.com", proveedor: "google", refresh_token_cifrado: "c1", drive_folder_id: "F", sheet_id: "S" });
    expect(c).toMatchObject({ activo: true, sheet_id: "S" });
    expect(c.creado).toMatch(/^\d{4}-/);
    await repo.desactivarConexion("ana@x.com", "revocado");
    expect(await repo.listarConexiones()).toHaveLength(0);
    await repo.guardarConexion({ email: "ana@x.com", proveedor: "google", refresh_token_cifrado: "c2", drive_folder_id: "F", sheet_id: "S" });
    expect((await repo.listarConexiones())[0].refresh_token_cifrado).toBe("c2");
  });
});
