# TicketFlow

Event ticket booking platform: organizers publish events with seat maps and pricing strategies, customers hold seats (5-minute holds, max 6 tickets per event), pay through pluggable gateways and get email + in-app notifications.

> **Status: Phase 2 complete.** Foundation (Phase 1) plus authentication with email OTP, role-based authorization with ownership checks, organizer venue/event/seat-map management and public event discovery. Booking, payments and notifications arrive in later phases.

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
| * | `/api/organizer/venues[/:id]` | Venue CRUD (ORGANIZER own / ADMIN all) |
| * | `/api/organizer/events[/:id]` | Event CRUD, `PUT …/seat-map`, `PATCH …/categories/:categoryId`, `PATCH …/seats/category`, `POST …/publish|unpublish|cancel` |

Every response uses one envelope: `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details?", "requestId" } }`. Each response carries an `X-Request-Id` header.

## Testing

- **Unit** (`backend/tests/unit`): config validation, log redaction, CORS, state machines, middlewares, error mapping, transaction retry logic, Redis lock/TTL primitives (ioredis-mock), seed data.
- **Integration** (`backend/tests/integration`): runs against a real throwaway PostgreSQL started automatically (`embedded-postgres`, or set `TEST_DATABASE_URL`). Covers migrations, double-booking under 8 concurrent transactions, composite FKs, trigger/state-machine parity, payments/refunds uniqueness, transactions, the seeder and the HTTP health API.
- **Live** (`backend/tests/live`): read-only checks against your Supabase and Redis (migrated schema, RLS/privilege lockdown, demo data, real transaction rolled back, Redis locks/TTL).
- **Frontend** (`frontend/tests`): API client, auth flows (login, register, OTP, protected routes, open-redirect guard), events list/details, organizer venues/events/seat map editor, error boundaries.
- **Auth & authorization coverage** (`backend/tests/integration/api`): OTP hashing, expiry, attempt limit, replay, resend cooldown, bypass mode, cookie flags, forged/`alg:none`/revoked tokens, RBAC (401/403), IDOR on venues and events (404), destructive-change guards with active bookings, public discovery filters and data exposure.

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
