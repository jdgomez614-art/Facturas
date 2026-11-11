import { describe, expect, it, vi } from "vitest";
import { nombreCorto, rutaArchivo } from "../src/archivo.js";
import { construirFactura } from "../src/classify/index.js";
import { DriveClient, nombreSeguro } from "../src/notify/drive.js";
import { archivarEnDrive } from "../src/pipeline.js";
import { cfg, correo, doc } from "./helpers.js";

/** Drive falso en memoria que entiende las llamadas que hace el cliente. */
function driveFalso(previos: { name: string; parent: string; folder: boolean }[] = []) {
  const archivos = previos.map((p, i) => ({ id: `pre${i + 1}`, ...p }));
  const request = vi.fn(async (o: { url: string; method?: string; data?: any; body?: Buffer }) => {
    const u = new URL(o.url);
    if (!o.method) {
      const q = u.searchParams.get("q")!;
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const name = /name = '(.*?)' and/.exec(q)?.[1];
      const f = archivos.filter((a) => a.parent === parent && (name === undefined || a.name === name) && (!q.includes("mimeType") || a.folder));
      return { data: { files: f.map((a) => ({ id: a.id, name: a.name, webViewLink: `https://drive/${a.id}` })) } };
    }
    const meta = o.data ?? JSON.parse(/\r\n\r\n(\{.*?\})\r\n/.exec(o.body!.toString())![1]);
    const a = { id: `id${archivos.length + 1}`, name: meta.name, parent: meta.parents[0], folder: !!o.data };
    archivos.push(a);
    return { data: { id: a.id, webViewLink: `https://drive/${a.id}` } };
  });
  return { archivos, request, cliente: new DriveClient({ request } as never, "RAIZ") };
}
const pdf = { xml: [], imagenes: [], descartados: [], pdf: [{ filename: "cc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }] };

describe("rutaArchivo: misma estructura y nombres que usa contabilidad", () => {
  const base = { fecha: "2026-10-15", tipo_documento: "Servicio público", tarjeta: null, tercero: null, razon_social: "ENEL COLOMBIA S.A E.S.P", numero_factura: "412448757" };
  it("compras", () => {
    expect(rutaArchivo({ ...base, tipo_movimiento: "Egreso facturación" }, 2020, "")).toEqual({
      carpetas: ["01. Compra", "06. 2026", "10. Octubre"],
      nombre: "15 Oct. Enel Colombia 412448757",
    });
    expect(rutaArchivo({ ...base, tipo_movimiento: "Egreso facturación", tipo_documento: "Nota crédito" }, 2020, "").nombre).toMatch(/ NC$/);
  });
  it("compras con tarjeta: subcarpeta TC y nombre DDMMAAAA_Proveedor", () => {
    expect(rutaArchivo({ ...base, fecha: "2026-07-19", tipo_movimiento: "Egreso facturación", razon_social: "Slack", numero_factura: null, tarjeta: "TC 7685 (Matteo) ****7685" }, 2020, "")).toEqual({
      carpetas: ["01. Compra", "06. 2026", "07. Julio", "TC 7685"],
      nombre: "19072026_Slack",
    });
  });
  it("ventas", () => {
    expect(rutaArchivo({ ...base, fecha: "2026-11-09", tipo_movimiento: "Ingreso facturación", razon_social: "Distrito Horeka SAS", numero_factura: "FE 240" }, 2020, "")).toEqual({
      carpetas: ["02. Venta", "2026", "11. Noviembre"],
      nombre: "FE 240 _ Distrito Horeka",
    });
  });
  it("nombres cortos", () => {
    expect(nombreCorto("EDIFICIO PAVILLON - PROPIEDAD HORIZONTAL PH")).toBe("Edificio Pavillon");
    expect(nombreCorto("MONO COLOMBIA S.A.S.")).toBe("Mono Colombia");
  });
});

describe("Drive", () => {
  it("archiva en Compra/año/mes, reutiliza carpetas creadas a mano y es idempotente", async () => {
    // Carpetas existentes con mayúsculas y espacios distintos, como en el Drive real.
    const d = driveFalso([
      { name: "01. Compra", parent: "RAIZ", folder: true },
      { name: "06. 2026", parent: "pre1", folder: true },
      { name: "11.  noviembre ", parent: "pre2", folder: true },
    ]);
    const c = correo();
    const f = construirFactura({ doc: doc(), xml: null }, { correo: c, cfg, trm: null });
    const url = await archivarEnDrive(d.cliente, f, c, pdf, 2020);
    expect(d.archivos).toHaveLength(4); // no creó carpetas nuevas
    expect(d.archivos[3]).toMatchObject({ name: "01 Nov. Juan Pérez CC-7.pdf", parent: "pre3" });

    const otro = driveFalso(d.archivos); // reintento tras un fallo posterior
    expect((await archivarEnDrive(otro.cliente, f, c, pdf, 2020)).replace(/pre\d+|id\d+/, "")).toBe(url.replace(/pre\d+|id\d+/, ""));
    expect(otro.archivos).toHaveLength(4);
  });

  it("crea lo que falte y, sin adjuntos, guarda el texto del correo", async () => {
    const d = driveFalso();
    const c = correo({ text: "Se debitó de su tarjeta..." });
    const f = construirFactura({ doc: doc(), xml: null }, { correo: c, cfg, trm: null });
    await archivarEnDrive(d.cliente, f, c, { xml: [], pdf: [], imagenes: [], descartados: [] }, 2020);
    expect(d.archivos.map((a) => a.name)).toEqual(["01. Compra", "06. 2026", "11. Noviembre", "01 Nov. Juan Pérez CC-7.txt"]);
  });

  it("limpia nombres", () => {
    expect(nombreSeguro('a/b:c*"d"')).toBe("a-b-c-d-");
  });
});
