/** TRM oficial (Superfinanciera) publicada en datos.gov.co. Devuelve null si no se puede consultar:
 *  el sistema sigue funcionando y marca la factura para revisión cuando la necesita. */
export async function obtenerTrm(fecha: string, timeoutMs = 8000): Promise<number | null> {
  const url = new URL("https://www.datos.gov.co/resource/32sa-8pi3.json");
  url.searchParams.set("$where", `vigenciadesde <= '${fecha}T00:00:00.000'`);
  url.searchParams.set("$order", "vigenciadesde DESC");
  url.searchParams.set("$limit", "1");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const [row] = (await res.json()) as { valor?: string }[];
    const v = Number(row?.valor);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function hoyEn(tz: string, desplazamientoDias = 0): string {
  const d = new Date(Date.now() + desplazamientoDias * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
