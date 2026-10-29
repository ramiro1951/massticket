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
  - `mapa-mesas.js` + `mapas/<id>.json` are the table-seating maps. Tables sell whole by
    default; tables listed in the event's `porAsiento` sell seat by seat (mesa compartida).
    The organizer switches tables or whole zones (`area` in the map) when editing the event.
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
- Refunds: a full refund or chargeback notice from Mercado Pago marks the sale `devuelto`
  and its unused tickets `cancelado` (`aplicarDevolucion()`, idempotent). Partial refunds and
  disputes only email the organizer, who cancels tickets by hand (Boletos tab). Cancelled
  tickets don't enter at the door and don't count toward capacity or revenue: use
  `boletoVigente()` whenever counting or checking tickets.
- Pricing modes per event: single price, `zonas` (price per purchase / `personas`), or
  `mapaId` (zones derived from the map's sections, price per person).
- "Today" uses `hoyMX()` (Mexico City time, rolls over at 6:00 am).
- Events with issued tickets can't be deleted or change map, and zones with sales can't be removed.
- Seat sales: `estadoAsientos()` holds seats like tables (tickets + recent `pendiente` sales).
  A table sold or held whole can't switch to seats, and a table with seats sold or held
  can't switch back to whole (`PUT /api/eventos/:id/por-asiento` enforces this).
- Apartados (deposit holds, arranged by WhatsApp, never through Mercado Pago): ventas with
  `apartado: true`, `estado: "apartado"` hold their seats until `vence`. `retieneLugar()` is the
  single rule for what holds seats (MP `pendiente` < 20 min, or an unexpired apartado), so use it
  in any new capacity check. Tickets are issued only on `liquidar`; expired apartados release
  automatically. Customers can request one until `DIAS_CIERRE_APARTADOS` (10) days before the
  event; each gets `DIAS_PARA_LIQUIDAR` (7) days.

## Running locally
```
npm install && cp server/env-ejemplo.txt .env   # at the repo root; fill in test values
npm run dev                                     # http://localhost:3000
```
Env vars: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `ADMIN_KEY`, `PUBLIC_URL`, `RESEND_API_KEY`,
`EMAIL_FROM`, `DATA_DIR`, `PORT`. Use Mercado Pago TEST credentials locally, never production.
Automated tests: `npm test` (Node's built-in runner, no extra dependencies; files in
`pruebas/*.test.js`). Each test file starts its own server on a free port with an empty
temporary `DATA_DIR` and a simulated Mercado Pago and Resend (`pruebas/simulador.cjs`),
so tests never touch real money, real email or `db.json`. Run `npm test` and
`node --check server/server.js` before every push; add or update tests when changing
payment, capacity, door or reservation logic. Manual click-through of purchase and admin
flows is still needed for real Mercado Pago, email and phone-camera behavior.

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
