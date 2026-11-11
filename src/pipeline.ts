import { randomUUID } from "node:crypto";
import type { EmpresaConfig, Env, MailboxConfig } from "./config.js";
import type { Extractor } from "./ai/extract.js";
import { construirFactura, debeProcesar, emparejar } from "./classify/index.js";
import { clasificarAdjuntos } from "./mail/attachments.js";
import type { LectorCorreo } from "./mail/imap.js";
import { nombreSeguro, type DriveClient } from "./notify/drive.js";
import type { SheetsClient } from "./notify/sheets.js";
import type { SlackClient } from "./notify/slack.js";
import { parseFacturaDian, type FacturaXml } from "./parse/dian-xml.js";
import type { FacturaGuardada, Repo } from "./store/repo.js";
import type { AdjuntosClasificados } from "./mail/attachments.js";
import type { CorreoEntrante, Factura } from "./types.js";

export interface Deps {
  repo: Repo;
  extractor: Extractor;
  lector: LectorCorreo;
  cfg: EmpresaConfig;
  env: Pick<Env, "MAX_CORREOS_POR_EJECUCION" | "MAX_INTENTOS">;
  /** Buzones a leer en esta corrida, cada uno con sus destinos: el Sheet y la carpeta de Drive de su dueño.
   *  En Drive los documentos se archivan en <raíz>/<Categoría>/<AAAA-MM>/. */
  buzones: () => Promise<Buzon[]>;
  slack: SlackClient | null;
  /** TRM para una fecha YYYY-MM-DD (null si no está disponible). */
  trm: (fecha: string) => Promise<number | null>;
  /** Facturas recibidas antes de esta fecha ISO no se notifican en Slack (útil para la carga inicial). */
  notificarDesde?: string;
  log?: (evento: string, datos?: Record<string, unknown>) => void;
}

export interface Destinos {
  sheets: SheetsClient | null;
  drive: DriveClient | null;
}
export interface Buzon extends Destinos {
  config: MailboxConfig;
  /** Se llama si el proveedor rechaza las credenciales (la persona revocó el acceso). */
  alRevocar?: (motivo: string) => Promise<void>;
}

export type ResultadoCorreo =
  | { estado: "omitido" }
  | { estado: "ignorado"; motivo: string }
  | { estado: "procesado"; nuevas: FacturaGuardada[]; duplicadas: number };

const log = (d: Deps, e: string, x?: Record<string, unknown>) => (d.log ?? ((ev, dat) => console.log(JSON.stringify({ ev, ...dat }))))(e, x);

/** Procesa un correo de punta a punta y lo deja registrado en la base. Lanza excepción si algo falla (se reintenta). */
export async function procesarCorreo(correo: CorreoEntrante, deps: Deps, destinos: Destinos = { sheets: null, drive: null }): Promise<ResultadoCorreo> {
  const { repo, cfg } = deps;
  const clave = `${correo.mailboxId}|${correo.messageId}`;
  const previo = await repo.estadoCorreo(clave);
  if (previo && previo.estado !== "error") return { estado: "omitido" };

  const adj = await clasificarAdjuntos(correo.adjuntos);
  if (!debeProcesar(correo, adj, cfg)) {
    await repo.marcarCorreo(clave, correo.mailboxId, correo.uid, "ignorado", "filtro previo");
    return { estado: "ignorado", motivo: "filtro previo" };
  }

  const xmls = adj.xml.map((x) => parseFacturaDian(x.content)).filter((x): x is FacturaXml => x !== null);
  const ext = await deps.extractor.extraer(correo, adj, xmls);
  if (!xmls.length && (!ext.es_documento_de_cobro || ext.documentos.length === 0)) {
    await repo.marcarCorreo(clave, correo.mailboxId, correo.uid, "ignorado", "no es documento de cobro");
    return { estado: "ignorado", motivo: "no es documento de cobro" };
  }

  const nuevas: FacturaGuardada[] = [];
  let duplicadas = 0;
  for (const par of emparejar(ext.documentos, xmls)) {
    const fecha = par.xml?.fecha ?? par.doc?.fecha ?? correo.date.toISOString().slice(0, 10);
    const factura = construirFactura(par, { correo, cfg, trm: await deps.trm(fecha) });
    if (await repo.buscarDuplicado(factura)) {
      duplicadas++;
      continue;
    }
    // Se archiva antes de guardar: si Drive falla, el correo completo se reintenta y nada queda a medias.
    if (destinos.drive) factura.drive_url = await archivarEnDrive(destinos.drive, factura, correo, adj);
    try {
      nuevas.push(await repo.insertarFactura(factura));
    } catch (e) {
      if (esViolacionUnica(e)) duplicadas++; // carrera con otro buzón que trajo la misma factura
      else throw e;
    }
  }
  await repo.marcarCorreo(clave, correo.mailboxId, correo.uid, "procesado", `${nuevas.length} nuevas, ${duplicadas} duplicadas`);
  log(deps, "correo_procesado", { clave, nuevas: nuevas.length, duplicadas });
  return { estado: "procesado", nuevas, duplicadas };
}

/** Sube los adjuntos (PDF/XML/imagen) a <Categoría>/<AAAA-MM>/. Si el correo no trae adjuntos, guarda el texto del correo. */
export async function archivarEnDrive(drive: DriveClient, f: Factura, correo: CorreoEntrante, adj: AdjuntosClasificados): Promise<string> {
  const mes = (f.fecha ?? correo.date.toISOString()).slice(0, 7);
  const carpeta = await drive.carpeta([f.categoria, mes]);
  const prefijo = nombreSeguro([f.fecha, f.tercero ?? f.razon_social ?? "sin-tercero", f.numero_factura ?? correo.uid].filter(Boolean).join("_"), 90);
  const archivos = [
    ...adj.pdf.map((a) => ({ a, mime: "application/pdf" })),
    ...adj.imagenes.map((a) => ({ a, mime: a.contentType || "image/jpeg" })),
    ...adj.xml.map((a) => ({ a, mime: "application/xml" })),
  ];
  if (!archivos.length) {
    const texto = `De: ${correo.from}\nAsunto: ${correo.subject}\nFecha: ${correo.date.toISOString()}\n\n${correo.text}`;
    return (await drive.subir(carpeta, `${prefijo}.txt`, "text/plain; charset=UTF-8", Buffer.from(texto))).webViewLink;
  }
  let principal = "";
  for (const { a, mime } of archivos) {
    const sufijo = archivos.length > 1 ? `_${nombreSeguro(a.filename, 60)}` : `.${a.filename.split(".").pop()}`;
    const subido = await drive.subir(carpeta, prefijo + sufijo, mime, a.content);
    principal ||= subido.webViewLink; // el primero es el PDF si existe
  }
  return principal;
}

function esViolacionUnica(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/** Envía a Sheets y Slack lo que esté pendiente (patrón outbox: si un servicio falla, se reintenta en la próxima corrida). */
export async function sincronizarSalidas(deps: Deps, buzones: Buzon[]): Promise<{ sheets: number; slack: number; errores: string[] }> {
  const { repo, slack } = deps;
  const out = { sheets: 0, slack: 0, errores: [] as string[] };
  const pendientes = await repo.pendientesDeSincronizar(100, { sheets: buzones.some((b) => b.sheets), slack: !!slack });
  if (!pendientes.length) return out;

  // Cada factura va al Sheet del dueño del buzón por el que llegó.
  for (const b of buzones) {
    const suyas = pendientes.filter((f) => f.mailbox_id === b.config.id && !f.sheet_sincronizada);
    if (!b.sheets || !suyas.length) continue;
    try {
      await b.sheets.asegurarEncabezado();
      const existentes = await b.sheets.filasPorId();
      for (const f of suyas) {
        const fila = existentes.get(f.id) ?? (await b.sheets.agregar(f));
        await repo.marcarSheet(f.id, fila);
        out.sheets++;
      }
    } catch (e) {
      out.errores.push(`Sheets (${b.config.id}): ${(e as Error).message}`);
    }
  }

  if (slack) {
    for (const f of pendientes.filter((x) => !x.slack_notificada)) {
      try {
        if (deps.notificarDesde && f.recibido_en < deps.notificarDesde) {
          await repo.marcarSlack(f.id, "", "omitido");
          continue;
        }
        const { canal, ts } = await slack.notificarFactura(f);
        await repo.marcarSlack(f.id, canal, ts);
        out.slack++;
      } catch (e) {
        out.errores.push(`Slack: ${(e as Error).message}`);
        break;
      }
    }
  }
  return out;
}

export interface ResumenPoll {
  buzones: { id: string; leidos: number; nuevas: number; errores: number; quedanMas: boolean; error?: string }[];
  salidas: Awaited<ReturnType<typeof sincronizarSalidas>>;
  bloqueado?: boolean;
}

/** Una corrida completa: lee todos los buzones, procesa, sincroniza Sheets/Slack. Segura ante ejecuciones simultáneas. */
export async function ejecutarPoll(deps: Deps): Promise<ResumenPoll> {
  const dueno = randomUUID();
  if (!(await deps.repo.adquirirBloqueo("poll", dueno, 280))) {
    return { buzones: [], salidas: { sheets: 0, slack: 0, errores: [] }, bloqueado: true };
  }
  try {
    const resumen: ResumenPoll = { buzones: [], salidas: { sheets: 0, slack: 0, errores: [] } };
    const buzones = await deps.buzones();
    for (const b of buzones) {
      const mb = b.config;
      const r = { id: mb.id, leidos: 0, nuevas: 0, errores: 0, quedanMas: false } as ResumenPoll["buzones"][number];
      resumen.buzones.push(r);
      try {
        const estado = await deps.repo.obtenerEstadoBuzon(mb.id, mb.carpeta);
        const lectura = await deps.lector.leer(mb, estado, deps.env.MAX_CORREOS_POR_EJECUCION);
        r.leidos = lectura.correos.length;
        r.quedanMas = lectura.quedanMas;
        // Si el buzón fue recreado (UIDVALIDITY cambió) se empieza de cero; la deduplicación por Message-ID evita repetir.
        let puntero = estado && estado.uidvalidity === lectura.uidvalidity ? estado.ultimo_uid : 0;
        let bloqueadoPorError = false;
        for (const correo of lectura.correos) {
          let completado = true;
          try {
            const res = await procesarCorreo(correo, deps, b);
            if (res.estado === "procesado") r.nuevas += res.nuevas.length;
          } catch (e) {
            r.errores++;
            const msg = (e as Error).message ?? String(e);
            const clave = `${correo.mailboxId}|${correo.messageId}`;
            const { intentos } = await deps.repo.marcarCorreo(clave, correo.mailboxId, correo.uid, "error", msg);
            log(deps, "correo_error", { clave, intentos, msg });
            if (intentos >= deps.env.MAX_INTENTOS) {
              await deps.repo.marcarCorreo(clave, correo.mailboxId, correo.uid, "fallido", msg);
              await deps.slack
                ?.alerta(`❌ No pude procesar un correo tras ${intentos} intentos.\nBuzón: ${mb.id}\nDe: ${correo.from}\nAsunto: ${correo.subject}\nError: ${msg}\nRevísalo manualmente.`)
                .catch(() => undefined);
            } else completado = false;
          }
          // El puntero solo avanza sobre correos terminados, así un error transitorio se reintenta en la próxima corrida.
          if (!completado) bloqueadoPorError = true;
          if (!bloqueadoPorError) puntero = Math.max(puntero, correo.uid);
        }
        await deps.repo.guardarEstadoBuzon(mb.id, mb.carpeta, lectura.uidvalidity, puntero);
      } catch (e) {
        r.error = (e as Error).message;
        log(deps, "buzon_error", { buzon: mb.id, error: r.error });
        if (b.alRevocar && /invalid_grant|AUTHENTICATIONFAILED|Invalid credentials/i.test(r.error)) {
          await b.alRevocar(r.error);
          await deps.slack?.alerta(`🔌 ${mb.user} ya no está conectado (acceso revocado o vencido). Debe volver a entrar y pulsar "Conectar con Google".`).catch(() => undefined);
        }
      }
    }
    resumen.salidas = await sincronizarSalidas(deps, buzones);
    const errs = [...resumen.buzones.filter((b) => b.error).map((b) => `Buzón ${b.id}: ${b.error}`), ...resumen.salidas.errores];
    if (errs.length) log(deps, "poll_errores", { errs });
    return resumen;
  } finally {
    await deps.repo.liberarBloqueo("poll", dueno);
  }
}
