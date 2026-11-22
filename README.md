# TicketFlow

Event ticket booking platform (in the spirit of Ticketmaster / BookMyShow). Organizers publish events with seat maps and pricing strategies; customers find events, hold seats for 5 minutes (max 6 tickets per event), pay through pluggable payment gateways, get email + in-app notifications, and cancel under a clear 24-hour refund rule.

> **Status: all six phases implemented.** See [COMPLIANCE_MATRIX.md](COMPLIANCE_MATRIX.md) for what is complete, partial or not yet verified (live hosting is set up by the repository owner).

## Features

- **Accounts**: registration with 6-digit email OTP (hashed, 5-minute TTL, attempt limit, resend cooldown; bypassed only in automated tests), bcrypt passwords, httpOnly cookie JWT with server-side revocation, roles `CUSTOMER`, `ORGANIZER`, `ADMIN`.
- **Organizers**: venues, events (draft → published → cancelled), seat maps (rows × seats) with categories and prices, banner images, pricing strategy per event (**Base price** or **Early bird**), sales/booking dashboard per event.
- **Discovery**: search by name/venue, city, date range, sorting and pagination; live seat availability.
- **Booking**: 5-minute seat holds (Redis locks + PostgreSQL partial unique index, zero double booking), 6-ticket limit per user per event, strict lifecycle `HELD → PENDING_PAYMENT → CONFIRMED | EXPIRED | CANCELLED` with full history, automatic expiry.
- **Payments**: one `PaymentGateway` interface with Mock Provider A (hosted page + signed webhook), Mock Provider B (tokens) and **SSLCommerz**; idempotent (no double charge on retry), server-side verification before confirmation, reconciliation of unknown outcomes.
- **Cancellation & refunds**: full refund when cancelled more than 24 hours before the start, otherwise none; refunds retried with backoff.
- **Notifications**: Email + In-App on confirmation and cancellation, and a reminder at least 1 hour before the event; transactional outbox with retries, no duplicates.
- **Dashboards**: customer (bookings, payments, refunds, notifications), organizer (revenue, occupancy, bookings by status), admin (platform totals, notification delivery, user directory).
- **Security**: Zod validation, RBAC + ownership checks (IDOR-safe 404s), Redis-backed rate limits, strict CORS, Helmet/CSP, redacted logs, production config guards. Details: [ALGORITHMS_AND_SECURITY.md](ALGORITHMS_AND_SECURITY.md).

## Demo credentials

Created by `npm run db:seed` (all pre-verified, passwords bcrypt-hashed in the database). Never use them in production.

| Role | Email | Password |
| --- | --- | --- |
| Organizer | `organizer.demo@example.com` | `Organizer@123` |
| Customer | `customer.demo@example.com` | `Customer@123` |
| Customer 2 | `customer2.demo@example.com` | `Customer@123` |
| Admin | `admin.demo@example.com` | `Admin@12345` |

The same accounts are listed in the web app (`frontend/src/features/auth/demoAccounts.ts`).

Seeded catalogue: 2 venues (Dhaka, Chattogram) and 4 events, 220 seats in total: a BASE-priced concert, an EARLY_BIRD tech summit (20% off), an event starting in about 3 hours (to try reminders and the no-refund window) and a draft event.

## Tech stack

| Layer | Choice |
| --- | --- |
| Backend | Node.js (≥ 22; CI on 24, developed on 26) · TypeScript strict · Express 5 · Zod 4 · Pino · Helmet · Multer |
| Database | Supabase PostgreSQL 17 via `pg` (transactions, partial unique indexes, triggers, RLS lockdown) |
| Cache / locks | Redis via `ioredis` (atomic Lua seat locks, OTP/TTL store, rate-limit counters) |
| Frontend | React 19 · Vite 8 · TypeScript · React Router |
| Payments | Mock Provider A/B, SSLCommerz (sandbox verified) |
| Tests | Jest + Supertest (embedded PostgreSQL), Testing Library, Playwright |
| CI/CD | GitHub Actions (quality, tests, coverage, Playwright, Claude Code security review, deploy hook) · Docker · Render |

Architecture, layers, patterns and data flows: [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

```text
TicketFlow/
├── backend/
│   ├── db/migrations/       # versioned SQL 0001–0008 (matches DATABASE_DESIGN.md)
│   ├── scripts/             # live/sandbox test runner, schema consistency report
│   ├── src/
│   │   ├── config/          # env validation (+ production rules), logger (redaction), CORS
│   │   ├── middlewares/     # auth/RBAC, validate (zod), rate limit, upload, SPA, errors
│   │   ├── controllers/     # HTTP only
│   │   ├── services/        # auth, events, booking, payments, notifications, dashboards
│   │   ├── domain/          # pricing, payments, notifications, lifecycle, uploads (pure rules)
│   │   ├── repositories/    # SQL / Redis data access
│   │   ├── infrastructure/  # Database, Redis locks/TTL/rate limits, payment adapters, email, storage
│   │   ├── workers/         # hold expiry, notification/reminder worker
│   │   ├── db/              # Migrator, Seeder, CLIs
│   │   ├── routes/          # Express routers
│   │   ├── app.ts           # createApp(deps), no I/O
│   │   ├── container.ts     # composition root (DI)
│   │   └── server.ts        # startup, workers, graceful shutdown
│   └── tests/{unit,integration,concurrency,live,sandbox,e2e,helpers}
├── frontend/src/{app,components,features,lib,pages,styles,config} · frontend/tests
├── e2e/                     # Playwright journeys
├── .github/workflows/       # ci.yml, security-review.yml
├── Dockerfile · render.yaml # single-host deployment
└── PRD.md · TRD.md · ARCHITECTURE.md · DATABASE_DESIGN.md · ALGORITHMS_AND_SECURITY.md · AI_USAGE.md · COMPLIANCE_MATRIX.md
```

## Getting started (local)

Prerequisites: Node.js 22+, a Supabase project (or any PostgreSQL 15+), a Redis instance (e.g. Upstash or local Redis).

```bash
npm install                                  # both workspaces
cp backend/.env.example backend/.env         # fill DATABASE_URL, REDIS_URL, JWT_SECRET (never commit .env)
npm run db:migrate                           # apply migrations
npm run db:seed                              # demo users, venues, events, seats
npm run dev:backend                          # http://localhost:4000
npm run dev:frontend                         # http://localhost:5173 (proxies /api to the backend)
```

Generate a JWT secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

## Environment configuration

### Backend (`backend/.env`, never committed)

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | no (development) | `production` enables every production safety rule below |
| `PORT` | no (4000) | HTTP port |
| `LOG_LEVEL` | no (info) | `debug`/`trace` are rejected in production |
| `TRUST_PROXY` | no (0) | Number of proxy hops (set `1` behind Render/Fly/NGINX so rate limits see the client IP) |
| `DATABASE_URL` | yes | Supabase **session pooler** (port 5432) or direct URI. The transaction pooler (6543) is not supported. |
| `DATABASE_SSL` | no (true) | Must be true in production |
| `DATABASE_SSL_CA_PATH` | no | Path to the Supabase root CA to verify the server certificate |
| `DATABASE_POOL_MAX` | no (10) | PostgreSQL pool size |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no (15000) | Per-statement timeout |
| `REDIS_URL` | yes | `redis://` or `rediss://` |
| `REDIS_KEY_PREFIX` | no | default `ticketflow:` |
| `BCRYPT_SALT_ROUNDS` | no (12) | 10–15 |
| `JWT_SECRET` | yes | ≥ 32 random chars; placeholders rejected in production |
| `CORS_ORIGINS` | yes | comma-separated allowlist, https only in production |
| `MAX_TICKETS_PER_USER_PER_EVENT` | no (6) | |
| `DEFAULT_CURRENCY` | no (BDT) | Currency of new events |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | no (900000, 300) | Global API limit per IP (Redis-backed, shared across instances) |
| `SEAT_HOLD_TTL_SECONDS` | no (300) | |
| `TEST_BYPASS_OTP` | no (false) | Rejected in production; OTP is always bypassed when `NODE_ENV=test` |
| `ALLOW_SEED` | no (false) | Needed to seed when `NODE_ENV=production` |
| `JWT_EXPIRES_IN` | no (1h) | Session lifetime (cookie expires with the token) |
| `AUTH_COOKIE_NAME` | no (tf_session) | httpOnly session cookie name |
| `COOKIE_SECURE` | no (true in production) | Set `false` only for plain-http localhost; rejected in production |
| `COOKIE_SAMESITE` | no (lax) | `lax` or `strict` |
| `OTP_MAX_ATTEMPTS` | no (5) | Wrong codes allowed before the code is burned |
| `OTP_RESEND_COOLDOWN_SECONDS` | no (60) | Minimum gap between OTP emails |
| `AUTH_RATE_LIMIT_MAX` | no (30) | Requests per window per IP on `/api/auth/*` |
| `EMAIL_TRANSPORT` | no (console) | `console` prints emails (incl. OTPs) to the backend terminal; `smtp` is required in production |
| `BOOKING_EXPIRY_INTERVAL_MS` | no (15000) | How often expired holds are released |
| `BOOKING_RATE_LIMIT_MAX` | no (60) | Hold/checkout/cancel requests per window per IP |
| `FRONTEND_URL` | no (first CORS origin) | Web app URL used for payment return pages |
| `PUBLIC_API_URL` | production: yes (https) | Public API URL: SSLCommerz IPN/returns and banner image URLs. Defaults to `http://localhost:PORT` outside production |
| `UPLOAD_DIR` | no (`uploads`) | Directory for uploaded event banners (use a persistent disk in production) |
| `FRONTEND_DIST_DIR` | no | Built web app served by the API (single-host deployment; set by the Docker image) |
| `PAYMENT_HOLD_EXTENSION_SECONDS` | no (900) | Seats stay held this long once payment starts |
| `REFUND_MAX_ATTEMPTS` | no (5) | Refund attempts before giving up |
| `ENABLE_MOCK_PAYMENTS` | no (true outside production) | Mock Provider A and B |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | production with mocks | HMAC secret for mock webhooks (derived automatically in development) |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` | for SSLCommerz | Sandbox or live store credentials (never committed) |
| `SSLCOMMERZ_SANDBOX` | no (true) | `false` switches to securepay.sslcommerz.com |
| `SSLCOMMERZ_CUSTOMER_PHONE` | no | Phone sent to SSLCommerz (required field; not collected from users) |
| `REMINDER_WINDOW_MINUTES` | no (120) | Reminders go out when the event starts within this window, never with less than 1 hour left (61–10080) |
| `NOTIFICATION_MAX_ATTEMPTS` | no (8) | Delivery attempts per notification before it stays `FAILED` |
| `NOTIFICATION_WORKER_INTERVAL_MS` | no (15000) | How often reminders are scheduled and the outbox is drained |
| `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | for smtp | Mail server settings |

The server validates every variable at startup and exits listing invalid names (never values).

### Frontend (`frontend/.env`, optional)

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | Keep `/api` (same origin) in development and in the single-host deployment |
| `VITE_DEV_API_PROXY` | `http://localhost:4000` | Backend address for the Vite dev proxy |

The server validates every variable at startup and exits listing invalid variable **names** (never values). In production it also refuses: console email, OTP bypass, non-Secure cookies, non-TLS database, http CORS origins or `PUBLIC_API_URL`, debug/trace logging, placeholder JWT secrets, and mock payments without a webhook secret.

## Database migrations and seeding

- Migrations live in `backend/db/migrations` (forward-only, numbered). The runner records each file with a SHA-256 checksum in `schema_migrations`, takes an advisory lock (safe with several instances) and refuses edited history.
  - Apply: `npm run db:migrate` · Status: `npm run db:migrate:status -w backend`
  - In the Docker image: `node dist/db/cli/migrate.js` (Render runs it as the pre-deploy command).
- Seed: `npm run db:seed` is idempotent (re-running re-anchors event dates to "now"). Refused in production unless `ALLOW_SEED=true`.
- Consistency check: `npm run db:schema-report -w backend` compares the live database with a fresh database built from the migrations and with `DATABASE_DESIGN.md` (columns, constraints, indexes, triggers, functions, RLS).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:backend` / `npm run dev:frontend` | Development servers |
| `npm run build` | Compile backend (`backend/dist`) and frontend (`frontend/dist`) |
| `npm run typecheck` · `npm run lint` · `npm run format:check` | TypeScript, ESLint, Prettier |
| `npm test` · `npm run test:coverage` | Backend unit + integration and frontend tests (coverage thresholds enforced) |
| `npm run test:concurrency -w backend` | Booking concurrency on real PostgreSQL + the Redis in `backend/.env` |
| `npm run test:live -w backend` | Read-only checks against your Supabase + Redis |
| `npm run test:sandbox -w backend` | SSLCommerz sandbox checks with the store in `backend/.env` (no tunnel needed) |
| `npm run e2e` | Builds the web app and runs the Playwright journeys on a self-contained stack |
| `npm run db:migrate` · `npm run db:seed` · `npm run db:schema-report -w backend` | Database tasks |

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health/live` | Liveness (no dependency calls) |
| GET | `/api/health/ready` (`/api/health`) | PostgreSQL + Redis readiness; 503 if any is down |
| POST | `/api/auth/register` | `{ name, email, password, role: CUSTOMER|ORGANIZER }` → emails a 6-digit OTP |
| POST | `/api/auth/verify-otp` | `{ email, otp }` → verifies, sets the session cookie |
| POST | `/api/auth/resend-otp` | `{ email }` → always 202 (no account enumeration) |
| POST | `/api/auth/login` / `/api/auth/logout` | Cookie session start / server-side revocation |
| GET | `/api/auth/me` | Current user |
| GET | `/api/events` | Public list: `q, city, from, to (YYYY-MM-DD), sort=date|price|title|newest, order, page, pageSize` |
| GET | `/api/events/cities` · `/api/events/:id` · `/api/events/:id/seats` | Cities, details with categories, seat availability |
| POST | `/api/bookings/quote` | `{ eventId, seatIds }` → server-side price (strategy, discounts, total) |
| POST | `/api/bookings` | Customer hold for 5 minutes; optional `Idempotency-Key` header; 409 `SEATS_UNAVAILABLE` / `TICKET_LIMIT_EXCEEDED` |
| GET | `/api/bookings` · `/api/bookings/:id` | My bookings (status filter, pages) / booking with seats and status history |
| POST | `/api/bookings/:id/payments` | `{ provider, paymentMethodToken? }` + **required** `Idempotency-Key` header → payment attempt (redirect URL, status) |
| GET · POST | `/api/payments/:id` · `/api/payments/:id/cancel` | Status (re-verifies open attempts) / abandon an open attempt |
| GET | `/api/payments/providers` | Enabled providers and Mock B test tokens |
| GET · POST | `/api/payments/mock/:transactionRef` · `/api/payments/mock/complete` | Mock Provider A hosted page data / complete it (the provider then sends a signed webhook) |
| POST | `/api/payments/webhooks/:provider` | Provider webhooks / SSLCommerz IPN (signature-verified, deduplicated) |
| POST | `/api/payments/providers/sslcommerz/return/:result` | SSLCommerz browser return → server-side validation → redirect to the result page |
| GET · POST | `/api/bookings/:id/cancellation` · `/api/bookings/:id/cancel` | Refund preview / cancel (HELD, PENDING_PAYMENT, CONFIRMED with the 24 h rule) |
| POST | `/api/bookings/:id/refunds/retry` | Retry a failed refund |
| POST | `/api/bookings/:id/checkout` | HELD → PENDING_PAYMENT without starting a payment |
| GET | `/api/notifications` | My in-app notifications: `unreadOnly=true`, `page`, `pageSize` (meta includes `unreadCount`) |
| GET | `/api/notifications/unread-count` | Badge count |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` | Mark one (404 if not yours) / all as read |
| GET | `/api/dashboard/customer` | Profile, booking/payment/refund stats, upcoming bookings, recent notifications |
| GET | `/api/dashboard/organizer` | ORGANIZER (own events) / ADMIN (all): revenue, seats sold/held, events and bookings by status, upcoming events with pricing |
| GET | `/api/dashboard/organizer/events/:id` | One event: sales, category breakdown, bookings with masked customer emails (`status`, `page`, `pageSize`) |
| GET | `/api/admin/overview` · `/api/admin/users` | ADMIN only: platform totals, failed refunds, open payments, notification delivery; user directory (`q`, `role`, pages) |
| * | `/api/organizer/venues[/:id]` | Venue CRUD (ORGANIZER own / ADMIN all) |
| POST · DELETE | `/api/organizer/events/:id/banner` | Banner image upload (multipart field `image`; JPEG/PNG/WebP, ≤ 2 MB, content-verified) / remove |
| GET | `/uploads/:key` | Public banner image (server-generated names only; `nosniff`, sandboxed CSP) |
| * | `/api/organizer/events[/:id]` | Event CRUD, `PUT …/seat-map`, `PATCH …/categories/:categoryId`, `PATCH …/seats/category`, `POST …/publish|unpublish|cancel` |

Every response uses one envelope: `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details?", "requestId" } }`. Each response carries an `X-Request-Id` header.

## Testing

| Suite | Command | What it covers |
| --- | --- | --- |
| Backend unit | `npm run test:unit -w backend` | config + production rules, redaction, CORS, state machines, pricing, payment rules/adapters, idempotency, notification templates/dispatcher/backoff, upload content checks, storage traversal, rate-limit store |
| Backend integration | `npm run test:integration -w backend` | real PostgreSQL (embedded or `TEST_DATABASE_URL`): migrations, triggers, auth/OTP/RBAC/IDOR, events, discovery, holds, ticket limit, payments, webhooks, idempotency, refunds, cancellation, notifications and reminders, dashboards, uploads, SPA serving |
| Concurrency | `npm run test:concurrency -w backend` | many simultaneous holds on the same seats with real Redis + PostgreSQL: exactly one winner, limit never exceeded |
| Live | `npm run test:live -w backend` | Supabase schema/RLS, demo data, Redis locks against your real services |
| SSLCommerz sandbox | `npm run test:sandbox -w backend` | real sandbox: session creation, pending verification, forged `val_id`, refund request shape, signed-but-unpaid IPN cannot confirm |
| Frontend | `npm test -w frontend` | API client, auth flows, events, seat selection, booking/payment/cancel, organizer pages, notifications, dashboards, banner upload |
| End-to-end | `npm run e2e` | Playwright: registration + OTP, login, discovery, seat selection, payment, confirmation email, cancellation with refund, organizer venue/event management and publishing, organizer booking overview, RBAC |

The E2E stack (`npm run e2e:server -w backend`) starts an embedded PostgreSQL with the demo seed, an in-memory Redis, a real OTP flow whose emails go to `backend/.tmp/e2e-mailbox.jsonl`, and serves the built web app, never reading `backend/.env`. First run: `npx playwright install chromium`.

### Manual testing guides

### Payments

1. Hold seats as a customer (see below), then pick a payment method on the booking page:
   - **Mock Provider A**: opens a simulated hosted card page with **Pay now** / **Decline payment**. The provider then sends an HMAC-signed webhook that the API verifies before confirming.
   - **Mock Provider B**: pick a test card: `tok_success`, `tok_decline`, `tok_pending` (settles on the next check), `tok_timeout` (charged but the response is lost: the page shows "pending" and confirms after verification, never charging twice), `tok_refund_fail_once` (first refund fails, a retry succeeds).
   - **SSLCommerz**: needs `SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` (free sandbox account at developer.sslcommerz.com). For the IPN to reach your laptop, expose the API with a tunnel and set `PUBLIC_API_URL`; without the IPN, the browser return and the status page still validate server-side.
2. **Cancel** a confirmed booking: the dialog shows the refund decision first. Events more than 24 hours away get a full refund; within 24 hours, none. "Classical Evening (starts soon)" shows the no-refund case (re-run `npm run db:seed` to move it 3 hours ahead again).
3. Refund status appears on the booking page; failed refunds can be retried and are also retried automatically.

### Notifications and dashboards

1. With `EMAIL_TRANSPORT=console` (default) every email is printed in the **backend terminal** under `[DEV MAIL]`.
2. Book and pay as `customer.demo@example.com`: within a second the confirmation email appears in the terminal and the 🔔 **Notifications** badge in the header shows 1. Open it to read, mark one or all as read.
3. Cancel the booking: a cancellation email + in-app notification states the refund outcome.
4. **Reminder**: book an event that starts in 1–2 hours (create one as the organizer with a start time ~90 minutes ahead). Within `NOTIFICATION_WORKER_INTERVAL_MS` the reminder email and in-app notification arrive, once only. Events less than 1 hour away are not reminded.
5. **Dashboards**: customers see `/account` (stats, upcoming bookings, notifications); organizers see sales and booking statistics on `/organizer` and per-event bookings via **Bookings**; `admin.demo@example.com` gets `/admin` with platform totals and the user directory.

### Seat booking

1. Start both apps, sign in as `customer.demo@example.com` and open an event (e.g. "Chattogram Tech Summit", which has an early-bird discount).
2. Click seats (max 6). The summary shows the server-calculated price; click **Hold … seats for 5 minutes**.
3. The booking page shows the countdown. **Continue to payment** moves it to "Awaiting payment"; **Cancel booking** releases the seats.
4. Open the same event in a private window as `customer2.demo@example.com`: held seats show as unavailable (availability refreshes every 10 s), and picking a just-taken seat returns a clear "just taken" message.
5. Let a hold run out: the countdown reaches zero, the page shows "expired", and the worker releases the seats within ~15 s.

### Authentication and authorization

1. Start both apps in two terminals: `npm run dev:backend` and `npm run dev:frontend`, then open http://localhost:5173.
2. **Sign in** with a demo account from the table above (the login page has "Use" buttons). Organizers land on `/organizer`, customers on `/account`.
3. **Register + OTP**: create a new account at `/register`. With `EMAIL_TRANSPORT=console` (default) the email, including the 6-digit code, is printed in the **backend terminal** under `[DEV MAIL]`. Enter it at `/verify-email`. Try a wrong code 5 times (locked), wait 5 minutes (expired) or reuse a code (rejected).
4. **Role checks**: signed in as the customer, open http://localhost:5173/organizer → "Access denied" (the API also returns 403).
5. **Ownership / IDOR**: register a second organizer, create a venue and event, copy the event id from the URL (`/organizer/events/<id>/edit`), sign in as the demo organizer and open that URL → the API answers 404, so the page shows an error.
6. **Logout revocation**: sign out; the old cookie is denylisted in Redis until it would have expired.
7. **Bypass mode** (automation only): `TEST_BYPASS_OTP=true` skips the OTP outside production; it is rejected when `NODE_ENV=production`.

## Deployment

**Architecture (single host):** one Docker container runs the API and serves the built React app from the same origin (so the httpOnly `SameSite=Lax` session cookie works without third-party cookies), plus **Supabase PostgreSQL** and a managed **Redis** (Upstash / Redis Cloud, `rediss://`). The repository includes a `Dockerfile` and a Render Blueprint (`render.yaml`); any Docker host (Render, Railway, Fly.io, a VM) works the same way.

1. **Database**: create a Supabase project; use the **session pooler** connection string (port 5432) as `DATABASE_URL`, `DATABASE_SSL=true` (optionally `DATABASE_SSL_CA_PATH` with the Supabase CA). Migrations run automatically before each deploy (`preDeployCommand`), or run `npm run db:migrate` once from your machine. Seed only if you want demo data (`ALLOW_SEED=true npm run db:seed`).
2. **Redis**: create a Redis database and set `REDIS_URL` (TLS `rediss://`). It holds seat locks, OTPs, session revocations and rate-limit counters; no persistence is required, but use a dedicated database or `REDIS_KEY_PREFIX`.
3. **Web service**: on Render choose *New → Blueprint* with this repository (or a Docker web service). Set the secrets marked `sync: false` in `render.yaml`: `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS` and `FRONTEND_URL` and `PUBLIC_API_URL` (all the service's https URL), SMTP settings, and SSLCommerz credentials. `JWT_SECRET` is generated. Keep `TRUST_PROXY=1`.
4. **Uploads**: banners are stored on local disk; attach the persistent disk from `render.yaml` (mounted at `/app/backend/uploads`) or images are lost on redeploy.
5. **SSLCommerz**: in the merchant panel the IPN URL is `https://<your-host>/api/payments/webhooks/SSLCOMMERZ`; set `SSLCOMMERZ_SANDBOX=false` only with live credentials.
6. **CI/CD**: GitHub Actions runs on every push/PR. On `main`, after all checks pass, the `deploy` job calls the Render deploy hook stored in the repository secret `RENDER_DEPLOY_HOOK_URL` (`autoDeploy` is off in `render.yaml` so only tested commits deploy). The AI security review needs the secret `CLAUDE_API_KEY`.
7. **Verify**: `GET /api/health/ready` returns `schemaVersion` and both dependencies `up`; sign in with a demo account (if seeded) and make a booking.

Secrets live only in the hosting dashboard / GitHub secrets and `backend/.env` locally; `.gitignore` and `.dockerignore` exclude every `.env*` file (except `.env.example`), and CI fails if one is committed.

## Security

Summary of controls (details and the audit in [ALGORITHMS_AND_SECURITY.md](ALGORITHMS_AND_SECURITY.md)): bcrypt (12 rounds), httpOnly + Secure (production) + SameSite cookies, HS256 JWT with pinned algorithm and jti revocation, hashed OTPs with attempt limits, RBAC + ownership (foreign resources answer 404), Zod validation on every input, parameterized SQL only, Helmet with `default-src 'none'` for the API and a strict CSP for the web app, strict CORS allowlist (blocks cross-site state-changing requests), Redis-backed rate limits, verified webhooks/IPN + server-side payment validation, idempotency keys and webhook deduplication, content-verified uploads with random names, redacted structured logs, no stack traces outside development.

## Documentation

[PRD.md](PRD.md) · [TRD.md](TRD.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE_DESIGN.md](DATABASE_DESIGN.md) · [ALGORITHMS_AND_SECURITY.md](ALGORITHMS_AND_SECURITY.md) · [AI_USAGE.md](AI_USAGE.md) · [COMPLIANCE_MATRIX.md](COMPLIANCE_MATRIX.md)
