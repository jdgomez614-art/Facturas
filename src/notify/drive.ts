import { randomUUID } from "node:crypto";
import type { GoogleHttp } from "./google-auth.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const CARPETA = "application/vnd.google-apps.folder";
const TODAS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

/** Quita caracteres problemáticos para nombres de archivo/carpeta. */
export function nombreSeguro(s: string, max = 80): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]+/g, "-").replace(/\s+/g, " ").trim().slice(0, max) || "sin-nombre";
}

const normalizar = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

export interface ArchivoDrive {
  id: string;
  webViewLink: string;
}

/** Cliente mínimo de Google Drive (REST v3). Todas las operaciones son idempotentes: si la carpeta o el archivo
 *  ya existe con ese nombre, se reutiliza en vez de duplicarse. */
export class DriveClient {
  private cacheCarpetas = new Map<string, Promise<string>>();
  constructor(private http: GoogleHttp, private raizId: string) {}

  private async buscar(nombre: string, padre: string, soloCarpeta: boolean): Promise<ArchivoDrive | null> {
    const q = [`name = '${nombre.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, `'${padre}' in parents`, "trashed = false"];
    if (soloCarpeta) q.push(`mimeType = '${CARPETA}'`);
    const r = await this.http.request<{ files: ArchivoDrive[] }>({
      url: `${API}?q=${encodeURIComponent(q.join(" and "))}&fields=files(id,webViewLink)&pageSize=1&${TODAS}`,
      retry: true,
    });
    return r.data.files[0] ?? null;
  }

  /** Busca una subcarpeta tolerando diferencias de mayúsculas, tildes y espacios ("10. octubre", "07.  Julio"),
   *  porque las carpetas existentes fueron creadas a mano. */
  private async buscarCarpeta(nombre: string, padre: string): Promise<string | null> {
    const q = `'${padre}' in parents and trashed = false and mimeType = '${CARPETA}'`;
    const r = await this.http.request<{ files: { id: string; name: string }[] }>({
      url: `${API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200&${TODAS}`,
      retry: true,
    });
    const n = normalizar(nombre);
    return r.data.files.find((f) => normalizar(f.name) === n)?.id ?? null;
  }

  /** Devuelve el id de raíz/a/b/c, creando lo que falte. */
  async carpeta(ruta: string[]): Promise<string> {
    let padre = Promise.resolve(this.raizId);
    let clave = "";
    for (const parte of ruta.map((p) => nombreSeguro(p))) {
      clave += "/" + parte;
      if (!this.cacheCarpetas.has(clave)) {
        const p = padre;
        const promesa = (async () => {
          const padreId = await p;
          const existe = await this.buscarCarpeta(parte, padreId);
          if (existe) return existe;
          const r = await this.http.request<{ id: string }>({
            url: `${API}?fields=id&supportsAllDrives=true`,
            method: "POST",
            data: { name: parte, mimeType: CARPETA, parents: [padreId] },
          });
          return r.data.id;
        })();
        this.cacheCarpetas.set(clave, promesa);
        promesa.catch(() => this.cacheCarpetas.delete(clave));
      }
      padre = this.cacheCarpetas.get(clave)!;
    }
    return padre;
  }

  async subir(carpetaId: string, nombre: string, mime: string, contenido: Buffer): Promise<ArchivoDrive> {
    const existe = await this.buscar(nombre, carpetaId, false);
    if (existe) return existe;
    const limite = `lim-${randomUUID()}`;
    const meta = JSON.stringify({ name: nombre, parents: [carpetaId] });
    const body = Buffer.concat([
      Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${limite}\r\nContent-Type: ${mime}\r\n\r\n`),
      contenido,
      Buffer.from(`\r\n--${limite}--`),
    ]);
    const r = await this.http.request<ArchivoDrive>({
      url: `${UPLOAD}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`,
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${limite}` },
      body,
    });
    return r.data;
  }
}
