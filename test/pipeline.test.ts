import { describe, expect, it, vi } from "vitest";
import type { Extraccion, Extractor } from "../src/ai/extract.js";
import type { LectorCorreo } from "../src/mail/imap.js";
import { ejecutarPoll, type Deps } from "../src/pipeline.js";
import { MemoryRepo } from "../src/store/memory.js";
import type { CorreoEntrante } from "../src/types.js";
import { attachedDocument, cfg, correo, doc } from "./helpers.js";

const mb = { id: "facturacion", host: "imap.test", port: 993, secure: true, user: "u", carpeta: "INBOX", auth: { tipo: "password" as const, password: "x" } };

function montar(correos: CorreoEntrante[], extraer: Extractor["extraer"]) {
  const repo = new MemoryRepo();
  const lector: LectorCorreo = {
    leer: vi.fn(async (_mb, estado) => ({ uidvalidity: 7, correos: correos.filter((c) => c.uid > (estado?.ultimo_uid ?? 0)), quedanMas: false })),
  };
  const slack = { notificarFactura: vi.fn(async () => ({ canal: "C1", ts: "1.1" })), alerta: vi.fn(async () => ({ canal: "C1", ts: "1.2" })) };
  const filas: string[] = [];
  const sheets = {
    asegurarEncabezado: vi.fn(async () => {}),
    filasPorId: vi.fn(async () => new Map(filas.map((id, i) => [id, i + 2]))),
    agregar: vi.fn(async (f: { id: string }) => filas.push(f.id) + 1),
  };
  const deps: Deps = {
    repo, cfg, lector, slack: slack as never,
    buzones: async () => [{ config: mb, sheets: sheets as never, drive: null }],
    extractor: { extraer: vi.fn(extraer) },
    env: { MAX_CORREOS_POR_EJECUCION: 20, MAX_INTENTOS: 2 },
    trm: async () => 4000,
    log: () => {},
  };
  return { deps, repo, slack, lector, sheets, filas };
}

const siempre = (d: Extraccion["documentos"]) => async (): Promise<Extraccion> => ({ es_documento_de_cobro: d.length > 0, documentos: d });

describe("ejecutarPoll", () => {
  it("procesa, guarda, notifica y no repite en la siguiente corrida", async () => {
    const correos = [
      correo({ uid: 1, messageId: "<a>", subject: "Cuenta de cobro" }),
      correo({ uid: 2, messageId: "<b>", subject: "Hola", text: "¿almorzamos?" }), // filtro previo
    ];
    const { deps, repo, slack } = montar(correos, siempre([doc()]));
    const r1 = await ejecutarPoll(deps);
    expect(r1.buzones[0]).toMatchObject({ leidos: 2, nuevas: 1, errores: 0 });
    expect(repo.facturas.size).toBe(1);
    expect(slack.notificarFactura).toHaveBeenCalledTimes(1);
    expect(deps.extractor.extraer).toHaveBeenCalledTimes(1);
    expect(await repo.obtenerEstadoBuzon("facturacion", "INBOX")).toEqual({ uidvalidity: 7, ultimo_uid: 2 });

    const r2 = await ejecutarPoll(deps);
    expect(r2.buzones[0].leidos).toBe(0);
    expect(slack.notificarFactura).toHaveBeenCalledTimes(1);
  });

  it("deduplica la misma factura que llega en dos correos (por CUFE)", async () => {
    const adj = [{ filename: "ad.xml", contentType: "application/xml", content: Buffer.from(attachedDocument) }];
    const correos = [correo({ uid: 1, messageId: "<a>", adjuntos: adj }), correo({ uid: 2, messageId: "<reenvio>", adjuntos: adj })];
    const { deps, repo } = montar(correos, siempre([doc({ numero_factura: "FE-1234" })]));
    await ejecutarPoll(deps);
    expect(repo.facturas.size).toBe(1);
  });

  it("reintenta errores transitorios sin avanzar el puntero y alerta al agotar intentos", async () => {
    const correos = [correo({ uid: 1, messageId: "<a>", subject: "Factura" }), correo({ uid: 2, messageId: "<b>", subject: "Factura 2" })];
    let llamadas = 0;
    const { deps, repo, slack } = montar(correos, async (c) => {
      llamadas++;
      if (c.messageId === "<a>") throw new Error("API caída");
      return { es_documento_de_cobro: true, documentos: [doc({ numero_factura: "X-2" })] };
    });
    const r1 = await ejecutarPoll(deps);
    expect(r1.buzones[0].errores).toBe(1);
    expect((await repo.obtenerEstadoBuzon("facturacion", "INBOX"))!.ultimo_uid).toBe(0); // no avanza: <a> falló
    expect(repo.facturas.size).toBe(1); // <b> sí se guardó

    await ejecutarPoll(deps); // segundo intento de <a> → se agota (MAX_INTENTOS=2)
    expect(slack.alerta).toHaveBeenCalledTimes(1);
    expect((await repo.obtenerEstadoBuzon("facturacion", "INBOX"))!.ultimo_uid).toBe(2);
    expect(repo.correos.get("facturacion|<a>")!.estado).toBe("fallido");
    expect(llamadas).toBe(3); // <b> no se volvió a enviar al modelo
  });

  it("si Slack falla, la factura queda pendiente y se notifica después", async () => {
    const { deps, repo, slack } = montar([correo({ uid: 1 })], siempre([doc()]));
    slack.notificarFactura.mockRejectedValueOnce(new Error("timeout"));
    const r = await ejecutarPoll(deps);
    expect(r.salidas.errores[0]).toMatch(/Slack/);
    expect([...repo.facturas.values()][0].slack_notificada).toBe(false);
    await ejecutarPoll(deps);
    expect([...repo.facturas.values()][0].slack_notificada).toBe(true);
  });

  it("escribe en el Sheet del dueño del buzón y no duplica filas si quedó a medias", async () => {
    const { deps, repo, sheets, filas } = montar([correo({ uid: 1 })], siempre([doc()]));
    const marcar = vi.spyOn(repo, "marcarSheet").mockRejectedValueOnce(new Error("BD caída")); // fila escrita, pero no se alcanzó a anotar
    const r = await ejecutarPoll(deps);
    expect(r.salidas.errores[0]).toMatch(/Sheets/);
    await ejecutarPoll(deps);
    expect(sheets.agregar).toHaveBeenCalledTimes(1);
    expect(filas).toHaveLength(1);
    expect([...repo.facturas.values()][0]).toMatchObject({ sheet_sincronizada: true, sheet_fila: 2 });
    marcar.mockRestore();
  });

  it("no corre dos veces a la vez", async () => {
    const { deps, repo } = montar([], siempre([]));
    await repo.adquirirBloqueo("poll", "otro", 60);
    expect((await ejecutarPoll(deps)).bloqueado).toBe(true);
  });
});
