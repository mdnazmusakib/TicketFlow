# Key Algorithms, Flows & Security Controls — TicketFlow

This document describes what is **implemented** (file references point to `backend/src`). Section 3 is the Phase 6 security audit.

## 1. Key algorithms and flows

### 1.1 Signup + email OTP (with test bypass)
- **Normal mode** (`services/auth/AuthService.ts`, `OtpService`):
  1. Register → user stored with `email_verified = false`, bcrypt hash (12 rounds by default).
  2. Generate a 6-digit OTP with a CSPRNG, store only its **hash** in Redis with a 5-minute TTL; email it (console transport in development prints `[DEV MAIL]`, SMTP in production).
  3. `verify-otp` compares in constant time, burns the code after `OTP_MAX_ATTEMPTS` (5) wrong tries, deletes it on success (no replay), sets `email_verified = true` and starts the session.
  4. `resend-otp` always answers 202 (no account enumeration) and enforces `OTP_RESEND_COOLDOWN_SECONDS`.
- **Test bypass**: when `NODE_ENV === 'test'` or `TEST_BYPASS_OTP === 'true'`, registration marks the user verified immediately. `TEST_BYPASS_OTP` is **rejected at startup in production**, and the container forces the bypass off in production even if a caller asks for it (covered by tests).

### 1.2 Seat hold (5 minutes), ticket limit and expiry
- **Acquire** (`services/booking/BookingService.ts`):
  1. Validate the event (published, sales window) and seats (belong to the event).
  2. Acquire all Redis locks `seat_hold:{eventId}:{seatId}` atomically with a Lua script (all-or-nothing, owner token = booking id, TTL = `SEAT_HOLD_TTL_SECONDS`).
  3. PostgreSQL transaction: `pg_advisory_xact_lock(user,event)` serialises one user's requests → count tickets in `HELD`, `PENDING_PAYMENT`, `CONFIRMED` for `(user, event)`; reject with `TICKET_LIMIT_EXCEEDED` if `existing + requested > MAX_TICKETS_PER_USER_PER_EVENT` (6) → insert `HELD` booking with `hold_expires_at = now() + 300 s` (database clock) and `HELD` seat rows; the partial unique index `idx_active_seat_per_event (event_id, seat_id) WHERE seat_state IN ('HELD','BOOKED')` rejects a seat someone else holds → history `null → HELD`.
  4. Any failure releases the Redis locks (compare-and-delete by owner).
- **Expire** (`workers/BookingExpiryWorker.ts`): every `BOOKING_EXPIRY_INTERVAL_MS`, claim due `HELD`/`PENDING_PAYMENT` bookings with `FOR UPDATE SKIP LOCKED` → `EXPIRED`, seats `RELEASED`, history row, Redis locks deleted. Holds are also expired lazily whenever a booking is touched.
- **Re-verification before confirmation**: the confirming transaction locks the booking and re-checks owner, state and `hold_expires_at > now()`; once payment starts the hold is extended by `PAYMENT_HOLD_EXTENSION_SECONDS` so a customer on the provider page does not lose the seats.

### 1.3 Pricing
`PricingStrategyRegistry` picks the event's strategy: `BasePriceStrategy` (category price) or `EarlyBirdStrategy` (percentage discount until the deadline, rounded in minor units). The server always recomputes prices; client totals are never trusted.

### 1.4 Payment and idempotency
- **Interface** (`domain/payments/PaymentGateway.ts`): `initiatePayment`, `verifyPayment`, `refundPayment`, `refundStatus`, `parseWebhook`. Implementations: `MockProviderA` (hosted page + HMAC-SHA256 signed webhook), `MockProviderB` (token-based: success, decline, pending, timeout, refund-fails-once), `SslCommerzAdapter` (hosted session, IPN `verify_sign` check, Order Validation API, v4 refund API with `refund_trans_id`).
- **Idempotency**: `Idempotency-Key` is required for payment initiation; `sha256(user + key)` is stored as the payment's `idempotency_key` (unique) and in `idempotency_keys` with a request fingerprint. A retry returns the same attempt; a different body with the same key → 422; a concurrent duplicate → 409. Only one open attempt per booking (`uq_payments_one_open_per_booking`), one success per booking (`uq_payments_one_success_per_booking`).
- **Verification**: a webhook/IPN with an invalid signature is stored as `REJECTED` and ignored. A valid one still triggers server-side verification with the provider; the booking is confirmed only if status, amount and currency match. Webhooks are deduplicated by provider event id.
- **Edge cases**: capture after hold expiry or after cancellation → recorded and refunded in full; duplicate capture → marked and refunded; timeout/unknown → stays open and is reconciled by polling or the worker, never re-charged.

### 1.5 Notifications and the "at least 1 hour before" reminder
- **Outbox** (`services/notifications/NotificationDispatcher.ts`): booking transitions enqueue one row per channel (`EMAIL`, `IN_APP`) **inside the same transaction**, with unique `dedupe_key = type:bookingId:channel`.
- **Delivery**: workers claim due rows (`FOR UPDATE SKIP LOCKED`, `attempts < NOTIFICATION_MAX_ATTEMPTS`) with a 5-minute lease; success → `SENT`; failure → `FAILED` and retry after `min(30 min, 30 s · 2^(n−1))`; a crashed worker's row is reclaimed when the lease ends. The email `Message-ID` carries the dedupe key.
- **Reminder** (`ReminderService`): one transaction selects `CONFIRMED` bookings with `reminder_sent_at IS NULL` whose event starts in `[now + 1 h, now + REMINDER_WINDOW_MINUTES]` (default 120), locks them `SKIP LOCKED`, sets `reminder_sent_at` and enqueues Email + In-App. So the reminder is always sent **at least 1 hour before** the start, exactly once (marker + lock + dedupe key), never for bookings with less than 1 hour left, and a queued reminder whose event already started is marked `SKIPPED`.
- **Content**: confirmation email includes booking id, event, time in the venue's time zone, venue, seats and amount; cancellation includes the refund outcome.

### 1.6 Cancellation and the 24-hour refund rule (`services/payments/CancellationService.ts`, `domain/payments/paymentRules.ts`)
1. Verify any open payment attempt with the provider first (a completed payment is never lost).
2. `hoursUntilEvent = (start_at − now) / 1 h`; `> 24` → refund = amount paid; otherwise 0 (exactly 24 h is **not** more than 24 h).
3. One transaction: `CANCELLED`, seats `RELEASED`, refund row (if any), history, cancellation notifications.
4. After commit the gateway refund runs; failures retry with backoff up to `REFUND_MAX_ATTEMPTS`; each attempt reuses its idempotency key so a re-sent request cannot refund twice.

### 1.7 Image upload validation (`domain/uploads/images.ts`, `services/events/EventBannerService.ts`)
Multer keeps the file in memory (1 file, no other fields, ≤ 2 MB) and rejects MIME types other than JPEG/PNG/WebP. The service then reads the **bytes**: JPEG `FF D8 FF … FF D9`, PNG signature + `IHDR`, WebP `RIFF…WEBP` + `VP8/VP8L/VP8X` with a consistent RIFF size; the detected type must equal the declared one. The file is stored as `<random uuid>.<ext>`; the client file name is never used. Both storage drivers only accept keys matching that pattern and never overwrite: `LocalFileStorage` also verifies the resolved path stays inside the upload root; `SupabaseFileStorage` writes to a private bucket with the server-side service-role key (redacted from logs). Images are served with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and the exact image content type.

## 2. Security controls

| Area | Control |
| --- | --- |
| Passwords | bcrypt (`BCRYPT_SALT_ROUNDS` 10–15, default 12); password strength rules; generic "invalid email or password" |
| Sessions | HS256 JWT (algorithm pinned on verify) in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production (enforced), host-only (no `Domain`); `jti` denylisted in Redis on logout. With the Vercel → Render proxy the cookie is first-party; `COOKIE_SAMESITE=none` exists only for a cross-site frontend without a proxy and is refused unless `Secure` |
| OTP | CSPRNG, hashed at rest, 5-minute TTL, attempt limit, single use, resend cooldown, bypass impossible in production |
| Authorization | `requireRole` per route (`CUSTOMER`, `ORGANIZER`, `ADMIN`); ownership checks in services; foreign bookings/events/venues/notifications answer **404** (no IDOR oracle); admin APIs check the role in the router and the service |
| Input | Zod schemas for body, query and params on every route; JSON body limit 100 kB; urlencoded bodies accepted only on provider callback routes |
| SQL injection | parameterized queries only; the only interpolations are constant SQL fragments; `LIKE` search escapes `%`, `_`, `\` |
| XSS | React escaping, no `dangerouslySetInnerHTML`; strict CSP for the web app (`script-src 'self'`, no inline script, `frame-ancestors 'none'`); API responses `default-src 'none'`; uploads sandboxed and content-checked (SVG not allowed) |
| CSRF | `SameSite=Lax` cookie, JSON-only state-changing endpoints, and the CORS middleware rejects any request whose `Origin` is not allowlisted (including simple multipart POSTs) |
| CORS | explicit allowlist from `CORS_ORIGINS` (https only in production), credentials allowed, provider callback paths exempt (they carry no session and are signature-verified) |
| Rate limiting | global API limit, stricter limits on `/api/auth/*` and booking/payment endpoints, image route limit; counters in Redis (shared by all instances) |
| Headers | Helmet: HSTS in production, `nosniff`, frame denial, referrer policy, `X-Powered-By` removed |
| Payments | signature verification (HMAC / SSLCommerz `verify_sign`, constant-time compare), server-side validation API, amount/currency match, idempotency keys, webhook dedupe, one success/open attempt per booking |
| Logging | Pino with redaction of passwords, hashes, tokens, cookies, authorization headers, OTPs, secrets, card fields, store passwords, `verify_sign`, payment tokens, connection strings; request ids on every response |
| Errors | central handler; generic message for 5xx; stack traces only when `NODE_ENV=development` |
| Configuration | all settings validated at startup; production refuses console email, OTP bypass, insecure cookies, non-TLS DB, http origins/API URL, debug logging, placeholder JWT secrets |
| Secrets | only in `backend/.env` (git-ignored) or the Render/Vercel dashboards / GitHub secrets; CI fails if a `.env` file is committed; Supabase Data API locked (RLS on every table, `anon`/`authenticated` privileges revoked) |

## 3. Phase 6 security audit summary

| Area | Finding | Action / status |
| --- | --- | --- |
| File uploads | No upload endpoint existed although the PRD requires upload validation | **Fixed**: banner upload with MIME allowlist, 2 MB limit, magic-byte validation, random names, traversal-safe storage, safe serving; 16 tests |
| Rate limiting | Memory store: limits multiplied by the number of instances | **Fixed**: Redis-backed store (`RedisRateLimitStore`), tested with two app instances sharing one budget |
| Production debug | `LOG_LEVEL=debug` was allowed in production | **Fixed**: rejected at startup |
| Public URL | Production could start with an http/localhost `PUBLIC_API_URL` (broken IPN, mixed-content banner URLs) | **Fixed**: https required in production |
| Log redaction | `verify_sign`, payment tokens and webhook secrets were not on the redaction list | **Fixed** |
| Web app headers | No CSP for the HTML when served in production | **Fixed**: single-host SPA router with strict CSP and cache rules; dotfiles never served |
| JWT / cookies / bcrypt / OTP | Algorithm pinned, httpOnly, Secure enforced, revocation, hashed OTPs | Verified (tests), no change |
| RBAC / IDOR | Ownership enforced in services, 404 for foreign resources | Verified for venues, events, bookings, payments, notifications, dashboards, uploads |
| SQL injection | Parameterized everywhere | Verified by code review (grep of query builders) |
| CSRF | SameSite + JSON + Origin allowlist | Verified; no token needed for this design |
| Webhooks / idempotency / replay | Signatures, provider validation, dedupe, idempotency keys | Verified, including real SSLCommerz sandbox (`npm run test:sandbox`) |
| Dependency / AI review | `anthropics/claude-code-security-review` workflow added for PRs | Runs once `CLAUDE_API_KEY` is configured (not yet run) |
| Strix scan | Listed in the TRD as an engineering aid | **Not run** in this environment (see COMPLIANCE_MATRIX.md) |
| Separate frontend/backend domains | `*.vercel.app` and `*.onrender.com` are different sites: an API cookie would be third-party (blocked by Safari/privacy modes) | **Fixed by design**: Vercel rewrites `/api` and `/uploads` to the API (first-party cookie, `SameSite=Lax`); CORS allowlists the Vercel origin; `SameSite=None` only with `Secure` |
| Ephemeral disk on Render free | Uploaded banners would be lost on restart/spin-down | **Fixed**: `STORAGE_DRIVER=supabase` (private Supabase Storage bucket); production warns when local storage is used |
