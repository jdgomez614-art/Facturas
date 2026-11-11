# Facturas automáticas

Lee correos, detecta facturas / cuentas de cobro / recibos de servicios, los clasifica según el
"Formato registro de facturas", archiva el documento en Drive por tipo de gasto, lo registra en
Google Sheets y avisa en Slack lo que hay que pagar.

## Cómo funciona

```
                 cada 15 min (Vercel Cron)
                          │
   Buzones ──IMAP solo lectura──▶ filtro previo ──▶ XML DIAN (determinístico)
   (Google por login,                               + Claude (PDF, cuentas de cobro, recibos)
    o cualquier IMAP)                                        │
                                                   reglas del negocio (config/empresa.json)
                                                             │
                                  Drive: <Categoría>/<AAAA-MM>/archivo.pdf
                                                             │
                                        Postgres (fuente de verdad, anti-duplicados)
                                               │                         │
                                     Google Sheets (formato)      Slack (aviso + botones)
```

- **Personas**: entran a la página, pulsan *Conectar con Google* y autorizan su correo y su Drive.
  El sistema les crea una carpeta `Facturas (automático)` y una hoja `Registro de facturas (automático)`.
- **Clasificación**: la factura electrónica (ZIP con XML de la DIAN) se lee de forma exacta: NIT, número,
  CUFE, valores, IVA, retenciones. Claude clasifica categoría / centro de costos / medio de pago / tarjeta y
  extrae los documentos que no traen XML. Las reglas de `config/empresa.json` mandan sobre el modelo.
- **Confiabilidad**: nunca modifica el correo; no repite facturas (CUFE o NIT+número); reintenta errores y
  avisa en Slack cuando un correo falla 3 veces; si Sheets o Slack se caen, lo pendiente sale en la siguiente
  corrida; lo dudoso (confianza baja, no cuadra, tarjeta desconocida) se marca "⚠️ Revisar".
- **Slack**: mensaje por documento con botones *Marcar pagada* / *Descartar* (actualizan la base y el Sheet)
  y resumen diario de pagos pendientes y vencidos (lunes a viernes, 8 a. m. Bogotá).

## Columnas del Sheet

A–R son exactamente las del formato (Fecha … Fecha de Pago). A la derecha se agregan columnas de control:
Tipo documento, Medio de pago, Tarjeta, Fecha vencimiento, Estado, Moneda, CUFE, Fuente, Confianza,
Requiere revisión, Motivos, Remitente, Asunto, Recibido, Archivo (Drive), ID sistema.

## Puesta en marcha

1. **Base de datos**: crea un Postgres (Neon desde el Marketplace de Vercel sirve). Luego
   `DATABASE_URL=... npm run migrate`.
2. **Claude**: una API key de Anthropic en `ANTHROPIC_API_KEY`.
3. **Google Cloud** (para el login):
   - Activa *Google Drive API* y *Google Sheets API*.
   - Crea credenciales *OAuth client ID → Web application* con redirect URI
     `https://TU-APP/api/conectar/callback`.
   - Pantalla de consentimiento: si todos usan Google Workspace de la misma empresa, elige **Internal**
     (sin límites). Si es **External**, en modo *Testing* solo entran hasta 100 cuentas agregadas a mano y
     el acceso vence cada 7 días; para abrirlo al público Google exige verificar la app, porque leer correo
     es un permiso restringido.
4. **Slack**: crea una app con el permiso `chat:write`, instálala e invítala al canal. En *Interactivity*
   pon `https://TU-APP/api/slack/acciones`.
5. **Vercel**: importa el repo y carga las variables de `.env.example`. El cron cada 15 minutos requiere plan
   Pro; en Hobby solo corre una vez al día (alternativa: cualquier programador externo que llame
   `GET /api/cron/poll` con `Authorization: Bearer $CRON_SECRET`).
6. **Tu negocio**: edita `config/empresa.json` — NIT propio, tarjetas (últimos 4), cuentas contables por
   categoría, reglas por proveedor y referencias de cada inmueble (dirección, # de contrato del servicio).
7. Abre `https://TU-APP/api/health` para verificar y luego `https://TU-APP/` para conectar la primera cuenta.

Correos que no son Google (Outlook, Zoho, hosting): se agregan en `MAILBOXES_JSON` (ver `.env.example`).

## Desarrollo

```bash
npm test                 # pruebas unitarias
TEST_DATABASE_URL=postgres://... npm test   # + integración con Postgres
npm run typecheck
DRY_RUN=1 npm run poll   # lee los buzones de MAILBOXES_JSON y muestra lo que registraría, sin escribir nada
```

## Límites conocidos

- El catálogo (categorías, centros de costo, tarjetas, reglas) es uno solo para toda la instalación: está
  pensado para varias personas de una misma empresa, no para varias empresas distintas.
- El login con cuenta propia existe para Google. Microsoft/Outlook entra por `MAILBOXES_JSON`.
- Slack usa un solo canal para todos.
- Retenciones: se toman del documento. El sistema no las calcula por tarifa.
