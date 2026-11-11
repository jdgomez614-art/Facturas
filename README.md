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

- **Personas**: entran a la página, pulsan *Conectar con Google* y autorizan su correo y Drive.
- **Archivo en Drive**: reproduce la estructura que ya usa contabilidad dentro de `03. Facturas`
  (`01. Compra/06. 2026/10. Octubre/15 Oct. Enel Colombia 412448757.pdf`,
  `02. Venta/2026/11. Noviembre/FE 240 _ Distrito Horeka.pdf`). Con `DRIVE_FOLDER_ID` y
  `SHEETS_SPREADSHEET_ID` todos escriben en la carpeta y la hoja de la empresa; sin ellas, a cada persona se
  le crea una carpeta y una hoja propias.
- **Centro de costos = sociedad**. Si el documento está a nombre de una sociedad dueña de inmueble, es esa.
  Si está a nombre de la operadora (TROOP TEAM, que recibe casi todos los gastos y factura los arriendos),
  se determina por el inmueble: # de contrato del servicio, edificio, dirección o inquilino
  (`referencias_centro_costos`). Gastos generales (software, asesoría) quedan en la operadora.
- **Clasificación**: la factura electrónica (ZIP con XML de la DIAN) se lee de forma exacta: NIT, número,
  CUFE, valores, IVA, retenciones. Claude clasifica categoría / sociedad (centro de costos) / medio de pago / tarjeta y
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
6. **Tu negocio**: edita `config/empresa.json` — sociedades (el centro de costos es la sociedad a cuyo nombre está la factura, por NIT), tarjetas (últimos 4), cuentas contables por
   categoría, reglas por proveedor (por NIT) y pistas por inmueble (# de contrato, edificio, inquilino).
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

- El catálogo (sociedades, categorías, tarjetas, reglas) es uno solo para toda la instalación: está
  pensado para varias personas de una misma empresa, no para varias empresas distintas.
- El login con cuenta propia existe para Google. Microsoft/Outlook entra por `MAILBOXES_JSON`.
- Slack usa un solo canal para todos.
- Retenciones: se toman del documento. El sistema no las calcula por tarifa.
