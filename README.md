# TicketFlow

Event ticket booking platform: organizers publish events with seat maps and pricing strategies, customers hold seats (5-minute holds, max 6 tickets per event), pay through pluggable gateways and get email + in-app notifications.

> **Status: Phase 5 complete.** Phases 1–4 (auth, events, seat holds, payments through Mock Provider A/B and SSLCommerz, cancellation and refunds) plus Email + In-App notifications through a transactional outbox (booking confirmation, cancellation, reminder at least 1 hour before the event), the in-app inbox, and customer, organizer and admin dashboards.

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
| Backend | Node.js (≥ 22) · TypeScript strict · Express 5 · Zod · Pino · Helmet |
| Database | Supabase PostgreSQL via `pg` (real transactions on one connection) |
| Cache / locks | Redis via `ioredis` (atomic Lua lock scripts, TTL store) |
| Frontend | React 19 · Vite · TypeScript · React Router |
| Tests | Jest (+ Supertest, embedded PostgreSQL) · Playwright CLI for E2E (later phase) |
| Quality | ESLint (flat config, layer import rules) · Prettier |

## Repository layout

```text
TicketFlow/
├── backend/
│   ├── db/migrations/          # versioned SQL (source of truth, matches DATABASE_DESIGN.md)
│   ├── scripts/                # run-live-tests.js
│   ├── src/
│   │   ├── config/             # env validation, logger (redaction), CORS
│   │   ├── middlewares/        # requestId, request logging, validate (zod), rate limit, errors
│   │   ├── controllers/        # HTTP only
│   │   ├── services/           # orchestration / business logic
│   │   ├── domain/lifecycle/   # booking + seat state machines
│   │   ├── repositories/       # data access (health probes so far)
│   │   ├── infrastructure/     # Database (transactions), Redis client, LockManager, TtlStore
│   │   ├── db/                 # Migrator, Seeder, CLIs
│   │   ├── routes/             # Express routers (/api)
│   │   ├── shared/             # AppError hierarchy, API response helpers
│   │   ├── app.ts              # createApp(deps) – no I/O
│   │   ├── container.ts        # composition root (DI)
│   │   └── server.ts           # startup, graceful shutdown
│   └── tests/{unit,integration,live,helpers}
├── frontend/
│   ├── src/{app,components,features,lib,pages,styles,config}
│   └── tests/
├── DATABASE_DESIGN.md · PRD.md · TRD.md · ALGORITHMS_AND_SECURITY.md
└── .claude/CLAUDE.md           # engineering rules
```

Request flow: `routes → middlewares → controllers → services → domain → repositories → PostgreSQL / Redis`. ESLint blocks driver/infrastructure imports outside the infrastructure, repository, db and composition-root layers.

## Getting started

Prerequisites: Node.js 22+ (tested on 26), a Supabase project, a Redis instance (e.g. Upstash).

```bash
npm install                                  # installs both workspaces
cp backend/.env.example backend/.env         # then fill in DATABASE_URL, REDIS_URL, JWT_SECRET
cp frontend/.env.example frontend/.env       # optional (defaults work)
npm run db:migrate                           # apply migrations to Supabase
npm run db:seed                              # demo users, venues, events, seats
npm run dev:backend                          # http://localhost:4000
npm run dev:frontend                         # http://localhost:5173 (proxies /api)
```

### Backend environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase **session pooler** (port 5432) or direct URI. The transaction pooler (6543) is not supported. |
| `DATABASE_SSL` | no (true) | Must be true in production |
| `DATABASE_SSL_CA_PATH` | no | Path to the Supabase root CA to verify the server certificate |
| `REDIS_URL` | yes | `redis://` or `rediss://` |
| `REDIS_KEY_PREFIX` | no | default `ticketflow:` |
| `JWT_SECRET` | yes | ≥ 32 random chars; placeholders rejected in production |
| `CORS_ORIGINS` | yes | comma-separated allowlist, https only in production |
| `MAX_TICKETS_PER_USER_PER_EVENT` | no (6) | |
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
| `PUBLIC_API_URL` | no (`http://localhost:PORT`) | Public API URL given to SSLCommerz for IPN and browser returns |
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

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:backend` / `npm run dev:frontend` | Development servers |
| `npm run build` | Compile backend (`backend/dist`) and frontend (`frontend/dist`) |
| `npm run typecheck` | Strict TypeScript for both workspaces |
| `npm run lint` / `npm run format:check` | ESLint / Prettier |
| `npm test` | Backend unit + integration and frontend tests |
| `npm run test:coverage` | Same with coverage (80% thresholds) |
| `npm run db:migrate` · `npm run db:migrate:status -w backend` | Apply / list migrations |
| `npm run db:seed` | Idempotent demo seed |
| `npm run test:live -w backend` | Live checks against the Supabase + Redis in `backend/.env` |
| `npm run test:concurrency -w backend` | Booking concurrency suite on real PostgreSQL (embedded) + the real Redis in `backend/.env` |

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
| * | `/api/organizer/events[/:id]` | Event CRUD, `PUT …/seat-map`, `PATCH …/categories/:categoryId`, `PATCH …/seats/category`, `POST …/publish|unpublish|cancel` |

Every response uses one envelope: `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details?", "requestId" } }`. Each response carries an `X-Request-Id` header.

## Testing

- **Unit** (`backend/tests/unit`): config validation, log redaction, CORS, state machines, middlewares, error mapping, transaction retry logic, Redis lock/TTL primitives (ioredis-mock), seed data.
- **Integration** (`backend/tests/integration`): runs against a real throwaway PostgreSQL started automatically (`embedded-postgres`, or set `TEST_DATABASE_URL`). Covers migrations, double-booking under 8 concurrent transactions, composite FKs, trigger/state-machine parity, payments/refunds uniqueness, transactions, the seeder and the HTTP health API.
- **Live** (`backend/tests/live`): read-only checks against your Supabase and Redis (migrated schema, RLS/privilege lockdown, demo data, real transaction rolled back, Redis locks/TTL).
- **Frontend** (`frontend/tests`): API client, auth flows (login, register, OTP, protected routes, open-redirect guard), events list/details, organizer venues/events/seat map editor, booking/payment flows, notification bell and inbox, customer/organizer/admin dashboards, error boundaries.
- **Notifications** (`backend/tests/integration/api/notifications.api.test.ts`): Email + In-App delivery, enqueue-in-transaction and rollback, dedupe, retry with backoff, max attempts, expired-lease reclaim, parallel workers (exactly once), cancellation refund wording, reminder window / <1 h / started-event skip / parallel schedulers, inbox ownership, pagination and read state. Dashboards: `dashboard.api.test.ts` (stats, ownership 404, RBAC 403, masked emails, admin search).
- **Auth & authorization coverage** (`backend/tests/integration/api`): OTP hashing, expiry, attempt limit, replay, resend cooldown, bypass mode, cookie flags, forged/`alg:none`/revoked tokens, RBAC (401/403), IDOR on venues and events (404), destructive-change guards with active bookings, public discovery filters and data exposure.

## Testing payments on localhost

1. Hold seats as a customer (see below), then pick a payment method on the booking page:
   - **Mock Provider A**: opens a simulated hosted card page with **Pay now** / **Decline payment**. The provider then sends an HMAC-signed webhook that the API verifies before confirming.
   - **Mock Provider B**: pick a test card: `tok_success`, `tok_decline`, `tok_pending` (settles on the next check), `tok_timeout` (charged but the response is lost: the page shows "pending" and confirms after verification, never charging twice), `tok_refund_fail_once` (first refund fails, a retry succeeds).
   - **SSLCommerz**: needs `SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` (free sandbox account at developer.sslcommerz.com). For the IPN to reach your laptop, expose the API with a tunnel and set `PUBLIC_API_URL`; without the IPN, the browser return and the status page still validate server-side.
2. **Cancel** a confirmed booking: the dialog shows the refund decision first. Events more than 24 hours away get a full refund; within 24 hours, none. "Classical Evening (starts soon)" shows the no-refund case (re-run `npm run db:seed` to move it 3 hours ahead again).
3. Refund status appears on the booking page; failed refunds can be retried and are also retried automatically.

## Testing notifications and dashboards on localhost

1. With `EMAIL_TRANSPORT=console` (default) every email is printed in the **backend terminal** under `[DEV MAIL]`.
2. Book and pay as `customer.demo@example.com`: within a second the confirmation email appears in the terminal and the 🔔 **Notifications** badge in the header shows 1. Open it to read, mark one or all as read.
3. Cancel the booking: a cancellation email + in-app notification states the refund outcome.
4. **Reminder**: book an event that starts in 1–2 hours (create one as the organizer with a start time ~90 minutes ahead). Within `NOTIFICATION_WORKER_INTERVAL_MS` the reminder email and in-app notification arrive, once only. Events less than 1 hour away are not reminded.
5. **Dashboards**: customers see `/account` (stats, upcoming bookings, notifications); organizers see sales and booking statistics on `/organizer` and per-event bookings via **Bookings**; `admin.demo@example.com` gets `/admin` with platform totals and the user directory.

## Testing seat booking on localhost

1. Start both apps, sign in as `customer.demo@example.com` and open an event (e.g. "Chattogram Tech Summit", which has an early-bird discount).
2. Click seats (max 6). The summary shows the server-calculated price; click **Hold … seats for 5 minutes**.
3. The booking page shows the countdown. **Continue to payment** moves it to "Awaiting payment"; **Cancel booking** releases the seats.
4. Open the same event in a private window as `customer2.demo@example.com`: held seats show as unavailable (availability refreshes every 10 s), and picking a just-taken seat returns a clear "just taken" message.
5. Let a hold run out: the countdown reaches zero, the page shows "expired", and the worker releases the seats within ~15 s.

## Testing authentication and authorization on localhost

1. Start both apps in two terminals: `npm run dev:backend` and `npm run dev:frontend`, then open http://localhost:5173.
2. **Sign in** with a demo account from the table above (the login page has "Use" buttons). Organizers land on `/organizer`, customers on `/account`.
3. **Register + OTP**: create a new account at `/register`. With `EMAIL_TRANSPORT=console` (default) the email, including the 6-digit code, is printed in the **backend terminal** under `[DEV MAIL]`. Enter it at `/verify-email`. Try a wrong code 5 times (locked), wait 5 minutes (expired) or reuse a code (rejected).
4. **Role checks**: signed in as the customer, open http://localhost:5173/organizer → "Access denied" (the API also returns 403).
5. **Ownership / IDOR**: register a second organizer, create a venue and event, copy the event id from the URL (`/organizer/events/<id>/edit`), sign in as the demo organizer and open that URL → the API answers 404, so the page shows an error.
6. **Logout revocation**: sign out; the old cookie is denylisted in Redis until it would have expired.
7. **Bypass mode** (automation only): `TEST_BYPASS_OTP=true` skips the OTP outside production; it is rejected when `NODE_ENV=production`.

## Security baseline (in place)

Helmet (strict CSP for JSON API, HSTS in production), strict CORS allowlist with credentials, JSON body limit 100 kB, global API rate limiting (health probes exempt), Zod validation middleware, central error handler that never leaks internals in production, Pino logs with redaction of passwords, tokens, cookies, OTPs, card data and secrets, request ids, env validation with production safety rules, Supabase Data API locked (RLS + revoked privileges), bcrypt-hashed seed passwords, secrets only in untracked `.env` files.

See [DATABASE_DESIGN.md](DATABASE_DESIGN.md) for the schema and integrity rules.
