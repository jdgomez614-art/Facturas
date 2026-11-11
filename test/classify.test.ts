import { describe, expect, it } from "vitest";
import { construirFactura, debeProcesar, emparejar } from "../src/classify/index.js";
import { parseFacturaDian } from "../src/parse/dian-xml.js";
import { cfg, correo, doc, invoiceXml } from "./helpers.js";

const vacio = { xml: [], pdf: [], imagenes: [], descartados: [] };

describe("debeProcesar", () => {
  it("descarta remitentes ignorados y correos sin señales", () => {
    expect(debeProcesar(correo({ from: "no-reply@slack.com" }), vacio, cfg)).toBe(false);
    expect(debeProcesar(correo({ subject: "Hola", text: "¿almorzamos?" }), vacio, cfg)).toBe(false);
  });
  it("procesa si hay palabra clave o PDF", () => {
    expect(debeProcesar(correo({ subject: "Cuenta de cobro noviembre", text: "" }), vacio, cfg)).toBe(true);
    expect(debeProcesar(correo({ subject: "x", text: "" }), { ...vacio, pdf: [{ filename: "a.pdf", contentType: "", content: Buffer.alloc(1) }] }, cfg)).toBe(true);
  });
});

describe("construirFactura", () => {
  it("con XML DIAN: valores oficiales, egreso, reglas y sociedad por NIT del receptor", () => {
    const xml = parseFacturaDian(invoiceXml)!;
    const f = construirFactura(
      { doc: doc({ tipo_documento: "Factura electrónica", numero_factura: "FE-1234", categoria: "Otros Egresos", valor_bruto: 1, total_a_pagar: 1 }), xml },
      { correo: correo({ from: "facturacion@enel.com" }), cfg, trm: 4000 },
    );
    expect(f).toMatchObject({
      numero_factura: "FE-1234",
      tipo_movimiento: "Egreso facturación",
      categoria: "Arriendos y servicios", // regla Enel gana sobre el modelo
      tipo_documento: "Servicio público",
      centro_costos: "TROOP BOG 5762-3 SAS", // el NIT del receptor manda, aunque el texto mencione Chicó 95
      cuenta: "513525",
      nit: "0860063875".replace(/\D/g, ""),
      valor_bruto: 1_000_000,
      iva: 190_000,
      retefuente: 40_000,
      reteica: 9_660,
      retenciones: 49_660,
      valor_neto: 1_140_340,
      valor_usd: 285.08,
      fuente: "XML DIAN",
      cufe: "abc123cufe",
      estado: "Pendiente",
    });
    expect(f.reglas_aplicadas).toContain("Energía (Enel)");
  });

  it("detecta factura emitida por la empresa como ingreso", () => {
    const xml = { ...parseFacturaDian(invoiceXml)!, emisor_nit: "9018560541", receptor_nit: "800111222", receptor_razon_social: "Cliente SA" };
    const f = construirFactura({ doc: null, xml }, { correo: correo(), cfg, trm: null });
    expect(f.tipo_movimiento).toBe("Ingreso facturación");
    expect(f.centro_costos).toBe("TROOP ALTS SAS");
    expect(f.nit).toBe("800111222");
    expect(f.razon_social).toBe("Cliente SA");
    expect(f.requiere_revision).toBe(true); // sin documento del modelo
  });

  it("sin XML: usa el NIT de la sociedad que leyó el modelo; si no, la pista del inmueble; si no, lo que diga el modelo", () => {
    const con = (d: Parameters<typeof doc>[0], texto = "") => construirFactura({ doc: doc(d), xml: null }, { correo: correo({ text: texto }), cfg, trm: null }).centro_costos;
    expect(con({ nit_sociedad: "901.826.069-1", centro_costos: "TROOP TEAM SAS" }, "administración torre cci")).toBe("TROOP PORTAFOLIO VIVIENDA 2 SAS");
    expect(con({ centro_costos: "TROOP TEAM SAS" }, "Cuota de administración Torre CCI")).toBe("TROOP CLO 629-1 SAS");
    expect(con({ centro_costos: "TROOP MEX SAS" })).toBe("TROOP MEX SAS");
  });

  it("marca revisión si la factura está a nombre de un NIT ajeno al grupo", () => {
    const xml = { ...parseFacturaDian(invoiceXml)!, receptor_nit: "800999888" };
    const f = construirFactura({ doc: doc({ numero_factura: "FE-1234" }), xml }, { correo: correo(), cfg, trm: null });
    expect(f.motivos_revision.join("|")).toMatch(/800999888.*no es de ninguna sociedad/);
  });

  it("asigna tarjeta registrada y su tipo", () => {
    const f = construirFactura({ doc: doc({ tarjeta_ultimos4: "1234", estado_pago: "Pagada" }), xml: null }, { correo: correo(), cfg, trm: null });
    expect(f.tarjeta).toBe("Visa Corporativa ****1234");
    expect(f.medio_pago).toBe("Crédito");
    expect(f.estado).toBe("Pagada");
    expect(f.fecha_pago).toBe("2026-11-01");
  });

  it("regla por remitente fija la tarjeta (Google Workspace)", () => {
    const f = construirFactura(
      { doc: doc({ categoria: "Otros Egresos", tipo_documento: "Comprobante de pago" }), xml: null },
      { correo: correo({ from: "Google Payments <payments-noreply@google.com>" }), cfg, trm: null },
    );
    expect(f).toMatchObject({ categoria: "Licencias", medio_pago: "Crédito", tarjeta: "Visa Corporativa ****1234", centro_costos: "TROOP TEAM SAS" });
  });

  it("marca revisión: tarjeta desconocida, confianza baja, no cuadra", () => {
    const f = construirFactura(
      { doc: doc({ tarjeta_ultimos4: "9999", confianza: 0.4, valor_bruto: 100, iva: 19, total_a_pagar: 500 }), xml: null },
      { correo: correo(), cfg, trm: null },
    );
    expect(f.requiere_revision).toBe(true);
    expect(f.motivos_revision.join("|")).toMatch(/9999/);
    expect(f.motivos_revision.join("|")).toMatch(/Confianza baja/);
    expect(f.motivos_revision.join("|")).toMatch(/No cuadra/);
  });

  it("convierte facturas en USD a COP con la TRM", () => {
    const f = construirFactura({ doc: doc({ moneda: "USD", valor_bruto: 100, total_a_pagar: 100 }), xml: null }, { correo: correo(), cfg, trm: 4000 });
    expect(f.valor_usd).toBe(100);
    expect(f.valor_neto).toBe(400_000);
  });

  it("documento limpio no requiere revisión", () => {
    const f = construirFactura({ doc: doc(), xml: null }, { correo: correo(), cfg, trm: 4000 });
    expect(f.requiere_revision).toBe(false);
    expect(f.valor_neto).toBe(2_000_000);
  });
});

describe("emparejar", () => {
  it("empareja por número y deja XML sobrantes como documentos propios", () => {
    const xml = parseFacturaDian(invoiceXml)!;
    const otro = { ...xml, numero: "FE-9" };
    const pares = emparejar([doc({ numero_factura: "fe 1234" })], [otro, xml]);
    expect(pares).toHaveLength(2);
    expect(pares[0].xml?.numero).toBe("FE-1234");
    expect(pares[1]).toMatchObject({ doc: null, xml: { numero: "FE-9" } });
  });
});
