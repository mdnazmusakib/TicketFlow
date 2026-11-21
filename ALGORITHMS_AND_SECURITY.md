# Key Algorithms, Flows & Security Controls — TicketFlow

## 1. Key Algorithms & Flows

### 1.1 Signup + Email OTP (with Test Bypass)
- **Non-Test Mode**:
  1. Generate a 6-digit numeric OTP.
  2. Store OTP in Redis with a 5-minute TTL (`EX 300`).
  3. Send/log OTP to the user's email address.
  4. Verify OTP before setting `email_verified = true`.
- **Test Mode (`NODE_ENV === 'test'` or `TEST_BYPASS_OTP === 'true'`)**:
  - Allow signup/registration directly with `email_verified = true` without requiring OTP so automated test suites and bots can register cleanly.

### 1.2 Seat Hold (5-min TTL), Ticket Limit & Expiry
- **Acquire Hold**:
  1. Expire any stale `HELD` bookings for the event where `hold_expires_at <= NOW()`.
  2. Count existing active/confirmed seats (`HELD` or `BOOKED`) for `(userId, eventId)` and ensure `existingCount + requestedSeats.length <= MAX_TICKETS_PER_USER_PER_EVENT` (default `6`).
  3. Acquire Redis lock keys (`seat_hold:{eventId}:{seatId}`, `EX 300`) and run a PostgreSQL transaction inserting `HELD` booking + `HELD` `booking_seats` rows (`idx_active_seat_per_event` rejects concurrent duplicate holds).
  4. Append `null -> HELD` to `booking_status_history`.
- **Expire Stale Holds**:
  - For `HELD` bookings where `hold_expires_at <= NOW()`:
    1. Set `bookings.status = 'EXPIRED'`.
    2. Set `booking_seats.seat_state = 'RELEASED'`.
    3. Delete Redis lock keys (`seat_hold:{eventId}:{seatId}`).
    4. Append `HELD -> EXPIRED` to `booking_status_history`.
- **Pre-Commit Re-Verification**:
  - Inside the payment/confirmation transaction before finalizing, re-verify that the hold belongs to the user, has not expired (`hold_expires_at > NOW()`), and is still in a valid pre-confirmation state.

### 1.3 Payment & Idempotency (Mock Providers + SSLCommerz)
- **Unified Interface (`PaymentGateway`)**:
  - Methods: `initiatePayment(input)`, `verifyPayment(payload)`, `refundPayment(input)`.
  - Implementations: `MockProviderA`, `MockProviderB`, and `SslCommerzAdapter`. Switching providers does not alter core booking logic.
- **Idempotency**:
  - Key idempotency records by `Idempotency-Key + userId + endpoint`; return the cached response on retry so double-clicks or network retries never double-charge.
- **Webhook & Server-Side Verification**:
  - Verify SSLCommerz / webhook signature/validation hash and transaction amount/status server-side before marking a booking `CONFIRMED`.

### 1.4 Notifications & At-Least-1-Hour Pre-Event Reminder
- **Confirmation Email + In-App**: Immediately upon transitioning a booking to `CONFIRMED`, dispatch a **ticket purchase confirmation email** (with booking ID, event details, seats, and amount) and save an `IN_APP` notification.
- **Pre-Event Reminder (>= 1 Hour Before Event)**: A background scheduler/worker checks confirmed bookings where `event.start_at - now <= 1 hour` and `reminder_sent_at IS NULL`, sends an Email + In-App reminder notification at least 1 hour before event start, and marks `reminder_sent_at`.
- **Cancellation Notification**: Upon `CANCELLED`, dispatch Email + In-App notification including refund details.

### 1.5 Cancellation & 24-Hour Refund Rule
1. Compute `hoursUntilEvent = (event.start_at - now) / (1000 * 60 * 60)`.
2. If `hoursUntilEvent > 24`: `refundAmount = total_amount_minor` (trigger gateway refund via `PaymentGateway.refundPayment` if already paid).
3. Else (`hoursUntilEvent <= 24`): `refundAmount = 0` (no refund).
4. Transition booking status to `CANCELLED` (recording `booking_status_history`), release seats (`seat_state = 'RELEASED'`), and dispatch cancellation notifications.

---

## 2. Security Controls

- **Auth & Cookies**: Hash passwords with `bcrypt`; sign JWT with a strong secret stored in an `httpOnly`, `SameSite=Lax` cookie (`Secure` enabled in production).
- **RBAC & Ownership**: Middleware checks `req.user.role` for role/admin routes and enforces resource ownership (`event.organizer_id === req.user.id` and `booking.customer_id === req.user.id`).
- **Uploads**: `multer` filter allowing only `image/jpeg`, `image/png`, and `image/webp` up to `2MB`, saved with randomized UUID filenames.
- **Logging**: Pino/Winston logger with redaction paths for `password`, `token`, `authorization`, `cookie`, `otp`, `cardNumber`, `cvv`, and `secret`.
- **CORS & Rate Limit**: Explicit origin allowlist from `CORS_ORIGINS` env var; `express-rate-limit` on `/api/auth` and `/api/bookings` (hold/pay).
- **Production Mode**: `NODE_ENV=production` disables debug mode and verbose error stack traces.
- **CI Security**: Include `anthropics/claude-code-security-review` GitHub Action workflow alongside lint, build, Jest (unit + integration + coverage), and Playwright CLI tests.