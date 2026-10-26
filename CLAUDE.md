# massticket.mx

Live ticketing site (Mexico, MXN) for events. Buyers pay via Mercado Pago Checkout Pro;
tickets (QR folios) are issued only when the Mercado Pago webhook confirms payment.
This is PRODUCTION: real money and real customers. Code, comments, UI text and commit
messages are in Spanish; keep it that way.

## Layout
- `server/server.js`: the whole backend (Node 18+, Express, ES modules). Serves the API
  under `/api/*` and serves `public/` as static files. No build step.
- `public/`: plain HTML/CSS/vanilla JS, no framework, no bundler.
  - `index.html` lists upcoming events; `comprar.html?evento=ID` buys one event;
    `gracias.html?venta=ID` shows tickets/QR after payment.
  - `admin.html` is the organizer panel (tabs: Eventos, Puerta, Boletos, Venta manual,
    Panel, Clientes). It authenticates with the `x-admin-key` header (kept in sessionStorage).
  - `mapa-mesas.js` + `mapas/<id>.json` are the table-seating maps (tables sold whole).
- Data: a single JSON file `db.json` with arrays `eventos`, `ventas`, `boletos`, in
  `$DATA_DIR` (Railway volume) or `server/data/` locally. Every write goes through
  `conCandado()` (an in-process lock): always read-modify-write inside it.
- `package.json` and `package-lock.json` live only at the repo root; Railway builds from
  the root (`npm ci`, then `npm start` runs `node server/server.js`). Add or update
  dependencies with `npm install` at the root so the lock file stays in sync.

## Key domain rules
- The webhook (`/api/webhook/mercadopago`) is the only source of truth for payment. Never
  issue tickets from the browser return URL. `aplicarPagoAprobado()` must stay idempotent.
- Capacity = issued tickets + `pendiente` sales younger than `VENTANA_RESERVA_MS` (20 min).
  All payment links expire at 19 min (`expiracionMP`) and exclude delayed payment types
  (OXXO/cash, bank, SPEI: `TIPOS_PAGO_EXCLUIDOS`), so a payment can't arrive after its
  hold was released.
- Pricing modes per event: single price, `zonas` (price per purchase / `personas`), or
  `mapaId` (zones derived from the map's sections, price per person).
- "Today" uses `hoyMX()` (Mexico City time, rolls over at 6:00 am).
- Events with issued tickets can't be deleted or change map, and zones with sales can't be removed.

## Running locally
```
npm install && cp server/env-ejemplo.txt .env   # at the repo root; fill in test values
npm run dev                                     # http://localhost:3000
```
Env vars: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `ADMIN_KEY`, `PUBLIC_URL`, `RESEND_API_KEY`,
`EMAIL_FROM`, `DATA_DIR`, `PORT`. Use Mercado Pago TEST credentials locally, never production.
There are no automated tests or linter yet. At minimum, run `node --check server/server.js`
and click through the purchase and admin flows manually.

## Deployment
Railway deploys automatically from GitHub (`npm start`). Whatever is pushed to the
deployed branch goes live immediately. Work on a feature branch, and only merge to main
when the user says so. Secrets live only in Railway Variables, never in the repo.
Railway restarts reset the container, so `DATA_DIR` must point to a persistent volume.
Confirmed in Railway: `DATA_DIR=/data` and the volume is mounted at `/data`, so `db.json`
persists across restarts and deploys.

## Working rules for Claude
- Ask before changing payment, webhook, capacity/reservation or ticket-validation logic.
- Never commit `.env`, tokens, or real customer data (`db.json`).
- Don't change the shape of `db.json` records without a migration that handles existing data.
- Escape any user-supplied text before putting it in `innerHTML` (use the `escapar()` helpers).

## Long-term idea (not current work): multiple promoters
Someday we may add separate panels so several promoters each manage only their own
events. This is NOT planned work: don't design, scaffold or build anything for it now.
Just avoid choices that would make it hard later, e.g. don't hard-code a single
organizer into data records, and keep sales and tickets linked to their event via `eventoId`.
