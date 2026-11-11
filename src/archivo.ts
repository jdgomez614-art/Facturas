import type { Factura } from "./types.js";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

export interface RutaArchivo {
  carpetas: string[];
  /** Nombre sin extensión. */
  nombre: string;
}

const limpio = (s: string) => s.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();

/** Nombre corto del tercero para el archivo: sin sufijos societarios ("ENEL COLOMBIA S.A E.S.P" → "Enel Colombia"). */
export function nombreCorto(tercero: string): string {
  const sin = limpio(tercero)
    .replace(/[.,]/g, " ")
    .replace(/\b(s\s?a\s?s|s\s?a|e\s?s\s?p|ltda|bic|ph|propiedad horizontal)\b/gi, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const palabras = (sin || limpio(tercero)).split(" ").slice(0, 4);
  return palabras.map((p) => (p === p.toUpperCase() && p.length > 3 ? p[0] + p.slice(1).toLowerCase() : p)).join(" ");
}

/**
 * Reproduce la estructura que ya usa contabilidad dentro de "03. Facturas":
 *   01. Compra / 06. 2026 / 10. Octubre / "15 Oct. Enel 412448757.pdf"
 *   02. Venta  / 2026     / 11. Noviembre / "FE 240 _ Distrito Horeka.pdf"
 * El número de factura va en el nombre para que dos facturas del mismo día y proveedor no se pisen.
 */
export function rutaArchivo(f: Pick<Factura, "fecha" | "tipo_movimiento" | "tipo_documento" | "tercero" | "razon_social" | "numero_factura">, anioBase: number, respaldoFecha: string): RutaArchivo {
  const [anio, mes, dia] = (f.fecha ?? respaldoFecha).slice(0, 10).split("-").map(Number);
  const carpetaMes = `${String(mes).padStart(2, "0")}. ${MESES[mes - 1]}`;
  const tercero = nombreCorto(f.tercero ?? f.razon_social ?? "Sin tercero");
  if (f.tipo_movimiento === "Ingreso facturación") {
    return { carpetas: ["02. Venta", String(anio), carpetaMes], nombre: limpio(`${f.numero_factura ?? "SN"} _ ${tercero}`) };
  }
  const nc = f.tipo_documento === "Nota crédito" ? " NC" : "";
  const numero = f.numero_factura ? ` ${f.numero_factura}` : "";
  return {
    carpetas: ["01. Compra", `${String(anio - anioBase).padStart(2, "0")}. ${anio}`, carpetaMes],
    nombre: limpio(`${String(dia).padStart(2, "0")} ${MESES_CORTOS[mes - 1]}. ${tercero}${numero}${nc}`),
  };
}
