import type { GoogleHttp } from "./google-auth.js";
import { COLUMNAS_SHEET, filaSheet, type Factura } from "../types.js";

const ULTIMA_COL = colLetra(COLUMNAS_SHEET.length); // "AH"
const COL_ID = ULTIMA_COL; // la última columna es "ID sistema"

export function colLetra(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Cliente mínimo de Google Sheets (REST v4). */
export class SheetsClient {
  private base: string;
  private encabezadoListo = false;

  constructor(private auth: GoogleHttp, spreadsheetId: string, private tab: string) {
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  }

  private rango(r: string) {
    return encodeURIComponent(`'${this.tab.replace(/'/g, "''")}'!${r}`);
  }

  private async req<T>(url: string, method = "GET", data?: unknown): Promise<T> {
    const res = await this.auth.request<T>({ url, method, data, retry: true });
    return res.data;
  }

  /** Crea la pestaña si no existe y escribe el encabezado (idéntico al formato + columnas de control). */
  async asegurarEncabezado(): Promise<void> {
    if (this.encabezadoListo) return;
    const meta = await this.req<{ sheets: { properties: { title: string } }[] }>(`${this.base}?fields=sheets.properties.title`);
    if (!meta.sheets.some((s) => s.properties.title === this.tab)) {
      await this.req(`${this.base}:batchUpdate`, "POST", { requests: [{ addSheet: { properties: { title: this.tab, gridProperties: { frozenRowCount: 1 } } } }] });
    }
    const actual = await this.req<{ values?: string[][] }>(`${this.base}/values/${this.rango(`A1:${ULTIMA_COL}1`)}`);
    const fila = actual.values?.[0] ?? [];
    if (COLUMNAS_SHEET.some((c, i) => fila[i] !== c)) {
      if (fila.length && fila.slice(0, 18).some((c, i) => c && c !== COLUMNAS_SHEET[i])) {
        throw new Error(`La pestaña "${this.tab}" tiene un encabezado distinto al formato. Usa una pestaña vacía o corrige el encabezado.`);
      }
      await this.req(`${this.base}/values/${this.rango(`A1:${ULTIMA_COL}1`)}?valueInputOption=RAW`, "PUT", { values: [COLUMNAS_SHEET] });
    }
    this.encabezadoListo = true;
  }

  /** Mapa id-sistema → número de fila, para no duplicar filas si una sincronización anterior quedó a medias. */
  async filasPorId(): Promise<Map<string, number>> {
    const r = await this.req<{ values?: string[][] }>(`${this.base}/values/${this.rango(`${COL_ID}2:${COL_ID}`)}`);
    const m = new Map<string, number>();
    (r.values ?? []).forEach((v, i) => v[0] && m.set(v[0], i + 2));
    return m;
  }

  async agregar(f: Factura & { id: string }): Promise<number> {
    const r = await this.req<{ updates: { updatedRange: string } }>(
      `${this.base}/values/${this.rango(`A1:${ULTIMA_COL}1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      "POST",
      { values: [filaSheet(f)] },
    );
    const m = /![A-Z]+(\d+)/.exec(r.updates.updatedRange);
    if (!m) throw new Error(`Respuesta inesperada de Sheets: ${r.updates.updatedRange}`);
    return Number(m[1]);
  }

  async actualizar(fila: number, f: Factura & { id: string }): Promise<void> {
    await this.req(`${this.base}/values/${this.rango(`A${fila}:${ULTIMA_COL}${fila}`)}?valueInputOption=USER_ENTERED`, "PUT", {
      values: [filaSheet(f)],
    });
  }
}
