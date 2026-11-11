import { describe, expect, it, vi } from "vitest";
import { DriveClient, nombreSeguro } from "../src/notify/drive.js";
import { archivarEnDrive } from "../src/pipeline.js";
import { construirFactura } from "../src/classify/index.js";
import { cfg, correo, doc } from "./helpers.js";

/** Drive falso en memoria que entiende las tres llamadas que hace el cliente. */
function driveFalso() {
  const archivos: { id: string; name: string; parent: string; folder: boolean }[] = [];
  const request = vi.fn(async (o: { url: string; method?: string; data?: any; body?: Buffer }) => {
    const u = new URL(o.url);
    if (!o.method) {
      const q = u.searchParams.get("q")!;
      const name = /name = '(.*?)' and/.exec(q)![1];
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const f = archivos.filter((a) => a.name === name && a.parent === parent && (!q.includes("mimeType") || a.folder));
      return { data: { files: f.map((a) => ({ id: a.id, webViewLink: `https://drive/${a.id}` })) } };
    }
    const meta = o.data ?? JSON.parse(/\r\n\r\n(\{.*?\})\r\n/.exec(o.body!.toString())![1]);
    const a = { id: `id${archivos.length + 1}`, name: meta.name, parent: meta.parents[0], folder: !!o.data };
    archivos.push(a);
    return { data: { id: a.id, webViewLink: `https://drive/${a.id}` } };
  });
  return { archivos, request, cliente: new DriveClient({ request } as never, "RAIZ") };
}

describe("Drive", () => {
  it("archiva en <Categoría>/<AAAA-MM>/ y es idempotente", async () => {
    const d = driveFalso();
    const c = correo();
    const f = construirFactura({ doc: doc(), xml: null }, { correo: c, cfg, trm: null });
    const adj = { xml: [], imagenes: [], descartados: [], pdf: [{ filename: "cc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }] };
    const url = await archivarEnDrive(d.cliente, f, c, adj);
    expect(url).toMatch(/^https:\/\/drive\//);
    expect(d.archivos.map((a) => a.name)).toEqual(["Honorarios", "2026-11", "2026-11-01_Juan Pérez_CC-7.pdf"]);
    expect(d.archivos[1].parent).toBe(d.archivos[0].id);
    expect(d.archivos[2].parent).toBe(d.archivos[1].id);

    // Reintento (p. ej. tras un fallo posterior): no crea carpetas ni archivos repetidos.
    const otro = driveFalso();
    otro.archivos.push(...d.archivos);
    expect(await archivarEnDrive(otro.cliente, f, c, adj)).toBe(url);
    expect(otro.archivos).toHaveLength(3);
  });

  it("sin adjuntos guarda el texto del correo", async () => {
    const d = driveFalso();
    const c = correo({ text: "Se debitó de su tarjeta..." });
    const f = construirFactura({ doc: doc({ categoria: "Licencias" }), xml: null }, { correo: c, cfg, trm: null });
    await archivarEnDrive(d.cliente, f, c, { xml: [], pdf: [], imagenes: [], descartados: [] });
    expect(d.archivos.at(-1)!.name).toMatch(/\.txt$/);
    expect(d.archivos[0].name).toBe("Licencias");
  });

  it("limpia nombres", () => {
    expect(nombreSeguro('a/b:c*"d"')).toBe("a-b-c-d-");
  });
});
