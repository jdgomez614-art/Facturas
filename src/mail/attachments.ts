import JSZip from "jszip";
import type { Adjunto } from "../types.js";

const MAX_ADJUNTO_BYTES = 15 * 1024 * 1024;
const MAX_ARCHIVOS_EN_ZIP = 20;

export interface AdjuntosClasificados {
  xml: Adjunto[];
  pdf: Adjunto[];
  imagenes: Adjunto[];
  descartados: string[];
}

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** Expande .zip (la factura electrónica colombiana llega como ZIP con XML + PDF) y separa por tipo. */
export async function clasificarAdjuntos(adjuntos: Adjunto[]): Promise<AdjuntosClasificados> {
  const out: AdjuntosClasificados = { xml: [], pdf: [], imagenes: [], descartados: [] };
  const cola = [...adjuntos];
  let expandidos = 0;
  while (cola.length) {
    const a = cola.shift()!;
    if (a.content.length > MAX_ADJUNTO_BYTES) {
      out.descartados.push(`${a.filename} (muy grande)`);
      continue;
    }
    const e = ext(a.filename);
    const ct = a.contentType.toLowerCase();
    if (e === "zip" || ct.includes("zip")) {
      try {
        const zip = await JSZip.loadAsync(a.content);
        for (const f of Object.values(zip.files)) {
          if (f.dir || f.name.startsWith("__MACOSX")) continue;
          if (++expandidos > MAX_ARCHIVOS_EN_ZIP) break; // protección contra zip bombs
          const content = await f.async("nodebuffer");
          cola.push({ filename: f.name.split("/").pop()!, contentType: "", content });
        }
      } catch {
        out.descartados.push(`${a.filename} (zip ilegible)`);
      }
    } else if (e === "xml" || ct.includes("xml")) out.xml.push(a);
    else if (e === "pdf" || ct === "application/pdf") out.pdf.push(a);
    else if (["png", "jpg", "jpeg", "webp", "gif"].includes(e) || ct.startsWith("image/")) {
      // Ignora logos/firmas diminutos incrustados en el correo.
      if (a.content.length > 20 * 1024) out.imagenes.push(a);
    } else out.descartados.push(a.filename);
  }
  return out;
}
