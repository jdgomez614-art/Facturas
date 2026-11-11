import { readFileSync } from "node:fs";
import { z } from "zod";

/* ---------- Catálogos del negocio (config/empresa.json) ---------- */

const ReglaSchema = z.object({
  nombre: z.string(),
  si: z.object({
    remitente_contiene: z.array(z.string()).optional(),
    texto_contiene: z.array(z.string()).optional(),
    nit: z.array(z.string()).optional(),
  }),
  asignar: z.object({
    tipo_movimiento: z.string().optional(),
    categoria: z.string().optional(),
    centro_costos: z.string().optional(),
    cuenta: z.string().optional(),
    medio_pago: z.enum(["Crédito", "Débito"]).optional(),
    tarjeta: z.string().optional(),
    tipo_documento: z.string().optional(),
  }),
});

export const EmpresaConfigSchema = z.object({
  empresa: z.object({ nombre: z.string(), nits_propios: z.array(z.string()) }),
  tipos_movimiento: z.array(z.string()).min(1),
  categorias: z.array(z.string()).min(1),
  centros_costos: z.array(z.string()).min(1),
  cuentas_por_categoria: z.record(z.string(), z.string()),
  tarjetas: z.array(
    z.object({
      alias: z.string(),
      tipo: z.enum(["Crédito", "Débito"]),
      ultimos4: z.string().regex(/^\d{4}$/),
      banco: z.string().optional(),
    }),
  ),
  reglas: z.array(ReglaSchema),
  referencias_centro_costos: z.array(z.object({ contiene: z.array(z.string()), centro_costos: z.string() })),
  remitentes_ignorados: z.array(z.string()),
  palabras_clave: z.array(z.string()),
  revision: z.object({ confianza_minima: z.number(), tolerancia_cuadre: z.number() }),
  recordatorios: z.object({ dias_antes_vencimiento: z.number().int() }),
});

export type EmpresaConfig = z.infer<typeof EmpresaConfigSchema>;
export type Regla = z.infer<typeof ReglaSchema>;

/** Carga y valida el JSON; además verifica que las reglas apunten a valores que existen en los catálogos. */
export function parseEmpresaConfig(raw: unknown): EmpresaConfig {
  const cfg = EmpresaConfigSchema.parse(stripComments(raw));
  const errores: string[] = [];
  for (const r of cfg.reglas) {
    const a = r.asignar;
    if (a.categoria && !cfg.categorias.includes(a.categoria)) errores.push(`Regla "${r.nombre}": categoría desconocida "${a.categoria}"`);
    if (a.centro_costos && !cfg.centros_costos.includes(a.centro_costos)) errores.push(`Regla "${r.nombre}": centro de costos desconocido "${a.centro_costos}"`);
    if (a.tipo_movimiento && !cfg.tipos_movimiento.includes(a.tipo_movimiento)) errores.push(`Regla "${r.nombre}": tipo de movimiento desconocido`);
    if (a.tarjeta && !cfg.tarjetas.some((t) => t.ultimos4 === a.tarjeta)) errores.push(`Regla "${r.nombre}": tarjeta ****${a.tarjeta} no está en "tarjetas"`);
  }
  for (const ref of cfg.referencias_centro_costos) {
    if (!cfg.centros_costos.includes(ref.centro_costos)) errores.push(`Referencia: centro de costos desconocido "${ref.centro_costos}"`);
  }
  if (errores.length) throw new Error("config/empresa.json inválido:\n- " + errores.join("\n- "));
  return cfg;
}

function stripComments(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "$comentario").map(([k, x]) => [k, stripComments(x)]),
    );
  }
  return v;
}

let cachedEmpresa: EmpresaConfig | undefined;
export function empresaConfig(): EmpresaConfig {
  if (!cachedEmpresa) {
    const path = process.env.EMPRESA_CONFIG_PATH ?? new URL("../config/empresa.json", import.meta.url);
    cachedEmpresa = parseEmpresaConfig(JSON.parse(readFileSync(path, "utf8")));
  }
  return cachedEmpresa;
}

/* ---------- Buzones de correo (secretos, por variable de entorno) ---------- */

const MailboxSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  host: z.string(),
  port: z.number().int().default(993),
  secure: z.boolean().default(true),
  user: z.string(),
  carpeta: z.string().default("INBOX"),
  /** Desde qué fecha leer la primera vez (YYYY-MM-DD). */
  desde: z.string().optional(),
  auth: z.discriminatedUnion("tipo", [
    z.object({ tipo: z.literal("password"), password: z.string() }),
    z.object({
      tipo: z.literal("oauth2"),
      token_url: z.string().url(),
      client_id: z.string(),
      client_secret: z.string(),
      refresh_token: z.string(),
      scope: z.string().optional(),
    }),
  ]),
});
export type MailboxConfig = z.infer<typeof MailboxSchema>;

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  MAILBOXES_JSON: z.string().default("[]"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  DRIVE_FOLDER_ID: z.string().optional(),
  NOTIFICAR_DESDE: z.string().optional(),
  SHEETS_SPREADSHEET_ID: z.string().optional(),
  SHEETS_TAB: z.string().default("Registro de facturas"),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL_ID: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  MAX_CORREOS_POR_EJECUCION: z.coerce.number().int().positive().default(20),
  MAX_INTENTOS: z.coerce.number().int().positive().default(3),
  TZ_NEGOCIO: z.string().default("America/Bogota"),
});
export type Env = z.infer<typeof EnvSchema> & { mailboxes: MailboxConfig[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  const mailboxes = z.array(MailboxSchema).parse(JSON.parse(env.MAILBOXES_JSON));
  const ids = new Set<string>();
  for (const m of mailboxes) {
    if (ids.has(m.id)) throw new Error(`MAILBOXES_JSON: id de buzón duplicado "${m.id}"`);
    ids.add(m.id);
  }
  return { ...env, mailboxes };
}
