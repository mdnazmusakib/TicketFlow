# TicketFlow — Final Requirements Compliance Matrix

Audit date: 2026-11-22 (end of Phase 6). Sources: `PRD.md`, `TRD.md`, `.claude/CLAUDE.md` (engineering rules), `ALGORITHMS_AND_SECURITY.md`, `DATABASE_DESIGN.md`, and the six phase briefs.

Status meanings: **COMPLETE** = implemented and verified by tests or a live run · **PARTIAL** = implemented but a part is missing or unproven · **MISSING** = not done · **NOT VERIFIED** = implemented but could not be executed in this environment.

Verification run for this audit: lint, Prettier, typecheck, build clean; backend unit + integration **359/359**; frontend **93/93**; concurrency (PostgreSQL + real Redis) **8/8**; live Supabase/Redis **7/7**; SSLCommerz sandbox **10/10**; Playwright **6/6**; schema report "Schema consistent" (live Supabase = migrations = `DATABASE_DESIGN.md`); production-mode smoke against live Supabase/Redis (health, CSP/HSTS headers, generic errors). Coverage: backend 93.9 % statements / 81.3 % branches, frontend 91.6 % / 82.7 %.

## 1. Functional requirements (PRD §3)

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1.1 | Registration with email OTP verification | PARTIAL (by decision) | OTP flow complete and tested, but **optional for now** (`REQUIRE_EMAIL_VERIFICATION=false`, owner decision 2026-11-22); setting it to `true` restores mandatory verification (tested in `auth.api.test.ts` / `authOptionalVerification.api.test.ts`) |
| 1.2 | OTP bypass in tests (`NODE_ENV=test` / `TEST_BYPASS_OTP`) and never in production | COMPLETE | config rules + `health.api.test.ts` (bypass ignored in production) |
| 1.3 | Login/logout, httpOnly cookie JWT, bcrypt, RBAC | COMPLETE | `AuthService`, `TokenService`, auth tests, Playwright login/logout |
| 2.1 | Venue, date-time, seat map (rows × seats), categories with prices, pricing strategy per event | COMPLETE | `EventService`, `organizer.api.test.ts`, Playwright organizer journey |
| 2.2 | Organizers manage only their own events | COMPLETE | ownership checks (404), IDOR tests (events, venues, banners, dashboards) |
| 3 | Browse: search by name/city/date, filters, pagination | COMPLETE | `discovery.api.test.ts`, frontend events tests, Playwright discovery |
| 4 | 5-minute hold, held seat unavailable to others, automatic release | COMPLETE | `booking.api.test.ts`, concurrency suite, expiry worker tests |
| 5 | Max 6 tickets per user per event (holds + confirmed) | COMPLETE | advisory-lock count in transaction; booking + concurrency tests |
| 6 | Lifecycle `HELD → PENDING_PAYMENT → CONFIRMED | EXPIRED | CANCELLED`, valid transitions only, full history | COMPLETE | state machine + DB triggers + history; unit and integration tests |
| 7.1 | ≥ 2 mock providers + SSLCommerz behind one interface | COMPLETE | `PaymentGateway`, `MockProviderA/B`, `SslCommerzAdapter`; payment tests |
| 7.2 | Switching provider does not change booking code | COMPLETE | adapters registered in the container only |
| 7.3 | Idempotent payments (no double charge) | COMPLETE | `IdempotencyService`, unique indexes, payment/idempotency tests |
| 7.4 | Server-side webhook/payment verification | COMPLETE | signature + validation API; tests incl. real sandbox (signed but unpaid IPN cannot confirm) |
| 7.5 | Real SSLCommerz paid capture and refund end to end | NOT VERIFIED | needs a customer paying on the hosted sandbox page and a public IPN URL; adapter verified against the official spec, a simulated SSLCommerz API and the live sandbox endpoints |
| 8 | ≥ 2 pricing strategies, chosen per event | COMPLETE | `BasePriceStrategy`, `EarlyBirdStrategy`; pricing tests |
| 9.1 | Confirmation email + in-app on `CONFIRMED` | COMPLETE | outbox observer; notification tests; Playwright reads the confirmation email |
| 9.2 | Reminder at least 1 hour before start (email + in-app), no duplicates | COMPLETE | `ReminderService` window + markers; reminder timing/parallel tests |
| 9.3 | Cancellation notification (email + in-app) | COMPLETE | notification tests; Playwright cancellation email |
| 9.4 | New channel without changing booking code | COMPLETE | `NotificationChannel` + dispatcher registration |
| 9.5 | Real email delivery over SMTP in production | NOT VERIFIED | `SmtpEmailSender` (nodemailer) delivers over the SMTP protocol in a test against a local SMTP server (headers, stable Message-ID, failure → retry); no real mail provider account was configured here |
| 10 | Zero double booking under concurrency | COMPLETE | partial unique index + Redis locks; concurrency suite on real PostgreSQL + Redis |
| 11 | Full refund > 24 h before start, otherwise none | COMPLETE | `decideRefund`; boundary tests (exactly 24 h = no refund), Playwright full-refund journey |
| 12 | Operational & security baseline | COMPLETE | see §3 |

## 2. Roles, demo access, dashboards

| Requirement | Status | Evidence |
| --- | --- | --- |
| Organizer / Customer / protected admin routes | COMPLETE | `requireRole`, admin router + service checks, RBAC tests, Playwright RBAC |
| Demo Organizer and Customer credentials in README and login UI | PARTIAL (by decision) | README only: removed from the web app at the owner's request for security; admin credentials removed everywhere and no admin is seeded |
| Customer dashboard (profile, bookings, payments, refunds, notifications) | COMPLETE | `dashboard.api.test.ts`, `dashboards.test.tsx` |
| Organizer dashboard (events, venues/seat maps, pricing, booking overview, statistics) | COMPLETE | dashboard API/frontend tests, Playwright booking overview |
| Admin capabilities (platform overview, user directory) | COMPLETE | admin API (ADMIN only) and page tests |
| In-app inbox (list, read/unread, mark one/all, pagination, ownership) | COMPLETE | notification API and frontend tests |

## 3. Security (PRD §3.12, CLAUDE.md, ALGORITHMS_AND_SECURITY.md)

| Requirement | Status | Evidence |
| --- | --- | --- |
| bcrypt, httpOnly cookie JWT, RBAC, strict ownership | COMPLETE | auth/RBAC/IDOR tests |
| Zod input validation | COMPLETE | `validate` middleware on all routes; validation tests |
| File upload validation (JPEG/PNG/WebP, 2 MB, content check, random names, no traversal) | COMPLETE | `uploads.api.test.ts`, `uploads.test.ts`, frontend `uploads.test.tsx` |
| Webhook signature verification | COMPLETE | HMAC / `verify_sign` tests, sandbox test |
| Rate limiting | COMPLETE (code) / NOT VERIFIED (production) | Redis-backed limiter, trusted client-IP resolution (signed Vercel hand-off, exact `TRUST_PROXY` hops), per-account + per-IP sign-in throttling; `rateLimitSecurity.api.test.ts`, `loginThrottle.test.ts`, `middleware.test.ts`; confirm `TRUST_PROXY=3` on Render with `/api/admin/diagnostics/request` after deploying |
| Strict CORS | COMPLETE | CORS tests (disallowed origin rejected) |
| Redacted logger | COMPLETE | logger redaction tests |
| Production debug disabled, no sensitive info exposed | COMPLETE | config rules (log level, stack traces dev-only); production smoke |
| No secrets committed | COMPLETE | `.gitignore` excludes all `.env*` (except `.env.example`), CI check; secrets only in Render/Vercel/GitHub dashboards |
| XSS / CSRF protections | COMPLETE | CSP (API + SPA), SameSite + Origin allowlist; SPA tests |
| Supabase Data API locked (RLS) | COMPLETE | live tests + schema report (RLS on all 15 tables) |
| `anthropics/claude-code-security-review` | PARTIAL | workflow added and validated; runs on PRs only after the `CLAUDE_API_KEY` secret is set; not executed yet |
| Cross-domain cookies and CORS (Vercel + Render) | COMPLETE | same-origin proxy via Vercel rewrites keeps `SameSite=Lax` first-party cookies; CORS allowlist; `SameSite=None` option refused without `Secure` (config tests); live check after deployment |
| Banner storage on ephemeral hosting | PARTIAL | Supabase Storage driver implemented and unit-tested (6 tests); not yet run against the real bucket |
| Strix security scan (TRD engineering aid) | MISSING | tool not available in this environment; run it against the deployed site or repository |

## 4. Architecture rules (CLAUDE.md)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Layering; no SQL/business logic in controllers | COMPLETE | ESLint `no-restricted-imports` layer rules; code review |
| SOLID / DIP via interfaces | COMPLETE | `PaymentGateway`, `NotificationChannel`, `EmailSender`, `FileStorage`, `TtlStore` |
| Strategy, Adapter, State guard, Observer/Dispatcher, Repository | COMPLETE | see `ARCHITECTURE.md` §3 |
| Small Conventional Commits on feature branches via PR | NOT VERIFIED | git history is managed by the repository owner (the AI made no git operations by instruction) |

## 5. Testing, CI/CD, hosting, documentation (PRD §4, TRD)

| Requirement | Status | Evidence / reason |
| --- | --- | --- |
| Jest unit + integration with coverage | COMPLETE | 359 backend + 93 frontend tests; thresholds enforced; CI failure on PostgreSQL 17 (`23503` vs `23001`) fixed |
| Database and Redis tests | COMPLETE | integration (real PostgreSQL), live suite, concurrency suite, Redis primitives unit tests |
| Booking concurrency tests | COMPLETE | `npm run test:concurrency` 8/8 |
| Payment, webhook, idempotency, refund tests | COMPLETE | payment/sslcommerz/cancellation suites + sandbox suite |
| Notification and reminder tests | COMPLETE | 17 integration + 12 unit tests |
| Playwright E2E (registration+OTP, login, discovery, seats, payment, confirmation, cancellation/refund, organizer login, venue/event management, booking overview) | COMPLETE | `e2e/*.spec.ts`, 6/6 passing |
| CI on push/PR: lint, typecheck, build, tests, coverage, Playwright | NOT VERIFIED | `.github/workflows/ci.yml` written and YAML-validated; it has not run on GitHub yet (pushes are done by the owner) |
| Automatic deployment on merge to `main` | PARTIAL | Docker-free: `render.yaml` (Render native Node, `autoDeployTrigger: checksPass`, migrations in the build) + `frontend/vercel.json` (Vercel Git deploys `main`); configured but not exercised until the owner creates the Render and Vercel projects |
| Live frontend, backend and database | PARTIAL | database live on Supabase (migrations 0001–0008 applied); Render (API) and Vercel (web app) projects still to be created by the owner, step-by-step guide in README "Deployment" |
| README, ARCHITECTURE, AI_USAGE, PRD, TRD, DATABASE_DESIGN, ALGORITHMS_AND_SECURITY | COMPLETE | all present and updated in Phase 6 |
| DATABASE_DESIGN matches migrations and running schema | COMPLETE | `npm run db:schema-report -w backend` → "Schema consistent" |

## 6. Known limitations and remaining tasks

1. **Hosting**: follow README "Deployment": Upstash Redis, Render web service from `render.yaml`, Vercel project with root `frontend` (check the API URL in `frontend/vercel.json`), then set `CORS_ORIGINS`/`FRONTEND_URL` to the Vercel URL. Add the GitHub secret `CLAUDE_API_KEY`. Verify `/api/health/ready` through the Vercel URL and that sign-in works (first-party cookie through the proxy).
2. **SSLCommerz end to end**: on the hosted (public https) instance, pay one sandbox order with a test card, confirm the IPN arrives and the booking confirms, then cancel more than 24 h before the event and check the refund settles.
3. **SMTP**: configure a real mail provider and confirm OTP, confirmation, cancellation and reminder emails arrive.
4. **Strix**: run a Strix scan against the deployed instance and fix any findings.
5. **Uploads on ephemeral hosts**: solved with `STORAGE_DRIVER=supabase` (private Supabase Storage bucket). The adapter is unit-tested against the Storage REST API contract but has not run against your project yet (needs `SUPABASE_SERVICE_ROLE_KEY` on Render).
6. **Render free tier**: the API sleeps after 15 idle minutes (first request ~1 minute; workers pause and catch up on wake). Rate limits (Redis) and workers (`SKIP LOCKED`) are safe if you later scale to several instances.
7. **Mock providers** are disabled by default in production (`ENABLE_MOCK_PAYMENTS=false`); enable them only for a demo deployment, with `MOCK_PAYMENT_WEBHOOK_SECRET` set.
