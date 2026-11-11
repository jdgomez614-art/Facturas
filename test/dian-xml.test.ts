import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseFacturaDian } from "../src/parse/dian-xml.js";
import { clasificarAdjuntos } from "../src/mail/attachments.js";
import { attachedDocument, invoiceXml } from "./helpers.js";

describe("parseFacturaDian", () => {
  it("lee una Invoice UBL 2.1", () => {
    const f = parseFacturaDian(invoiceXml)!;
    expect(f).toMatchObject({
      tipo: "Invoice", numero: "FE-1234", cufe: "abc123cufe", fecha: "2026-11-03", fecha_vencimiento: "2026-11-18",
      emisor_nit: "0860063875", emisor_razon_social: "ENEL COLOMBIA S.A. E.S.P.", receptor_nit: "901465015",
      valor_bruto: 1_000_000, iva: 190_000, retefuente: 40_000, reteica: 9_660, total_a_pagar: 1_190_000,
    });
    expect(f.descripcion_items[0]).toContain("1381914");
  });

  it("desempaqueta el AttachedDocument de la DIAN", () => {
    expect(parseFacturaDian(attachedDocument)?.numero).toBe("FE-1234");
  });

  it("devuelve null para XML que no es factura", () => {
    expect(parseFacturaDian("<foo><bar>1</bar></foo>")).toBeNull();
    expect(parseFacturaDian("no es xml <<<")).toBeNull();
  });
});

describe("clasificarAdjuntos", () => {
  it("expande el ZIP de la factura electrónica", async () => {
    const zip = new JSZip();
    zip.file("ad0860063875.xml", attachedDocument);
    zip.file("fv0860063875.pdf", Buffer.from("%PDF-1.4 fake"));
    const content = await zip.generateAsync({ type: "nodebuffer" });
    const r = await clasificarAdjuntos([{ filename: "z.zip", contentType: "application/zip", content }]);
    expect(r.xml).toHaveLength(1);
    expect(r.pdf).toHaveLength(1);
  });

  it("ignora imágenes pequeñas (logos)", async () => {
    const r = await clasificarAdjuntos([{ filename: "logo.png", contentType: "image/png", content: Buffer.alloc(500) }]);
    expect(r.imagenes).toHaveLength(0);
  });
});
