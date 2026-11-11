import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailboxConfig } from "../config.js";
import type { CorreoEntrante } from "../types.js";

export interface LecturaBuzon {
  uidvalidity: number;
  correos: CorreoEntrante[];
  quedanMas: boolean;
}

export interface LectorCorreo {
  leer(mb: MailboxConfig, estado: { uidvalidity: number; ultimo_uid: number } | null, max: number): Promise<LecturaBuzon>;
}

async function accessToken(auth: Extract<MailboxConfig["auth"], { tipo: "oauth2" }>): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: auth.client_id,
    client_secret: auth.client_secret,
    refresh_token: auth.refresh_token,
  });
  if (auth.scope) body.set("scope", auth.scope);
  const res = await fetch(auth.token_url, { method: "POST", body });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`OAuth2: ${data.error ?? res.status} ${data.error_description ?? ""}`);
  return data.access_token;
}

function htmlATexto(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Lector IMAP genérico (Gmail, Outlook/Microsoft 365, Zoho, cPanel, etc.). Abre el buzón en SOLO LECTURA:
 *  nunca marca como leído, mueve ni borra correos. */
export class ImapLector implements LectorCorreo {
  async leer(mb: MailboxConfig, estado: { uidvalidity: number; ultimo_uid: number } | null, max: number): Promise<LecturaBuzon> {
    const auth = mb.auth.tipo === "password" ? { user: mb.user, pass: mb.auth.password } : { user: mb.user, accessToken: await accessToken(mb.auth) };
    const client = new ImapFlow({ host: mb.host, port: mb.port, secure: mb.secure, auth, logger: false, socketTimeout: 60_000 });
    await client.connect();
    try {
      const box = await client.mailboxOpen(mb.carpeta, { readOnly: true });
      const uidvalidity = Number(box.uidValidity);
      let uids: number[];
      if (!estado || estado.uidvalidity !== uidvalidity) {
        const desde = mb.desde ? new Date(`${mb.desde}T00:00:00`) : new Date(Date.now() - 7 * 86_400_000);
        uids = (await client.search({ since: desde }, { uid: true })) || [];
      } else {
        uids = ((await client.search({ uid: `${estado.ultimo_uid + 1}:*` }, { uid: true })) || []).filter((u) => u > estado.ultimo_uid);
      }
      uids.sort((a, b) => a - b);
      const lote = uids.slice(0, max);
      const correos: CorreoEntrante[] = [];
      for (const uid of lote) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const p = await simpleParser(msg.source);
        correos.push({
          mailboxId: mb.id,
          uid,
          messageId: p.messageId ?? `uid-${uidvalidity}-${uid}`,
          from: p.from?.text ?? "",
          subject: p.subject ?? "",
          date: p.date ?? new Date(),
          text: p.text?.trim() || (typeof p.html === "string" ? htmlATexto(p.html) : ""),
          adjuntos: p.attachments.map((a) => ({ filename: a.filename ?? "adjunto", contentType: a.contentType, content: a.content })),
        });
      }
      return { uidvalidity, correos, quedanMas: uids.length > lote.length };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}
