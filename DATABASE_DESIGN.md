# TicketFlow — Database Design

**Database:** Supabase PostgreSQL (verified on PostgreSQL 17; tests also run on 18)
**Ephemeral store:** Redis (seat-hold locks, OTP TTLs, counters)
**Source of truth for the schema:** `backend/db/migrations/0001…0006` (this document and the migrations must stay identical; any change ships as a new migration plus an update here)
**Money:** integer minor units (`BIGINT`, paisa for BDT), always stored with a 3-letter `currency`.
**Time:** all instants are `TIMESTAMPTZ` (UTC); venues keep an IANA `timezone` for display.

---

## 1. Design principles

1. **PostgreSQL is authoritative** for users, inventory, bookings, money, tickets and history. Redis only reduces contention; correctness never depends on it.
2. **Invariants live in the database**, not only in code: CHECK constraints, composite foreign keys, partial unique indexes and guard triggers. Application checks give friendly errors; the database guarantees correctness.
3. **Every multi-step change is one transaction** on one connection (`Database.withTransaction`). Separate Supabase REST calls are never treated as atomic.
4. **Financial and audit history is never deleted.** Bookings, payments, refunds, tickets, status history and audit logs use `ON DELETE RESTRICT`; history tables are append-only.
5. **Retried operations are idempotent** (unique idempotency keys, unique provider/webhook ids, unique notification dedupe keys).
6. **Charged prices are snapshots** (`booking_seats.price_minor`, `bookings.total_amount_minor`) and are immutable once written.
7. **The Supabase Data API is closed.** Only the Express backend talks to the database (RLS on, no policies, privileges revoked from `anon`/`authenticated`).

---

## 2. Entity overview

```text
users ─┬─< venues ─┬─< events ─┬─< seat_categories ─┬─< seats
       │           │           │                    │
       │           └───────────┤ (venue must belong │
       │                       │  to the organizer) │
       ├─< bookings >──────────┘                    │
       │      │                                     │
       │      ├─< booking_seats >───────────────────┘   (same-event composite FKs)
       │      │        └──1 tickets
       │      ├─< booking_status_history   (append-only)
       │      ├─< payments ─┬─< refunds
       │      │             └─< payment_webhook_events
       │      └─< notifications
       ├─< idempotency_keys
       └─< audit_logs                       (append-only)
```

| Domain | Tables |
| --- | --- |
| Identity | `users` |
| Catalogue | `venues`, `events`, `seat_categories`, `seats` |
| Booking | `bookings`, `booking_seats`, `booking_status_history` |
| Finance | `payments`, `refunds`, `payment_webhook_events` |
| Ticketing | `tickets` |
| Communication | `notifications` |
| Reliability & governance | `idempotency_keys`, `audit_logs`, `schema_migrations` |

All primary keys are `UUID DEFAULT gen_random_uuid()` (non-guessable, safe to expose in URLs).

---

## 3. Conventions

- Enumerations are `VARCHAR` + `CHECK (… IN (…))` instead of PostgreSQL `ENUM` types: adding a value is a simple constraint swap in a migration and mirrors the TypeScript union types.
- Every mutable table has `created_at` and `updated_at`; `updated_at` is maintained by the `set_updated_at()` trigger so no code path can forget it.
- Text columns have explicit maximum lengths and "not blank" checks where a blank value would be meaningless.
- Foreign key columns used in lookups are indexed explicitly (PostgreSQL does not index referencing columns automatically).
- `pg_trgm` is installed in the `extensions` schema (Supabase convention) for fuzzy event-title search.

---

## 4. Tables

### 4.1 `users`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `name` | VARCHAR(120) | NOT NULL, not blank |
| `email` | VARCHAR(254) | NOT NULL, basic format check, **unique on `lower(email)`** |
| `password_hash` | VARCHAR(255) | NOT NULL (bcrypt; plain passwords are never stored) |
| `role` | VARCHAR(20) | NOT NULL DEFAULT `CUSTOMER`; `CUSTOMER` \| `ORGANIZER` \| `ADMIN` |
| `email_verified` | BOOLEAN | NOT NULL DEFAULT false |
| `email_verified_at` | TIMESTAMPTZ | set iff `email_verified` (CHECK) |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true (soft deactivation; users with history are never deleted) |
| `last_login_at` | TIMESTAMPTZ | nullable |
| `created_at`, `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Indexes: `uq_users_email_lower` (unique), `idx_users_role`.
Why own auth instead of Supabase Auth: the requirements specify bcrypt + httpOnly JWT cookies + RBAC in the Express backend; the OTP lives in Redis.

### 4.2 `venues`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `organizer_id` | UUID | NOT NULL → `users.id` ON DELETE RESTRICT (owner) |
| `name` | VARCHAR(200) | NOT NULL, not blank |
| `address` | VARCHAR(300) | NOT NULL |
| `city` | VARCHAR(100) | NOT NULL, not blank (event search by city) |
| `country_code` | CHAR(2) | NOT NULL DEFAULT `BD`, `^[A-Z]{2}$` |
| `timezone` | VARCHAR(64) | NOT NULL DEFAULT `Asia/Dhaka` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Constraints/indexes: `UNIQUE (id, organizer_id)` (target of the events composite FK), unique `(organizer_id, lower(name), lower(city))`, `idx_venues_city_lower`.

### 4.3 `events`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `organizer_id` | UUID | NOT NULL → `users.id` RESTRICT |
| `venue_id` | UUID | NOT NULL; `(venue_id, organizer_id)` → `venues(id, organizer_id)` RESTRICT — **an event can only use its own organizer's venue** |
| `title` | VARCHAR(200) | NOT NULL, not blank; trigram index on `lower(title)` |
| `description` | TEXT | nullable |
| `start_at` | TIMESTAMPTZ | NOT NULL (drives 24h refund rule and 1h reminder) |
| `end_at` | TIMESTAMPTZ | nullable, `> start_at` |
| `status` | VARCHAR(20) | `DRAFT` (default) \| `PUBLISHED` \| `CANCELLED` \| `COMPLETED` |
| `pricing_strategy` | VARCHAR(20) | `BASE` (default) \| `EARLY_BIRD` |
| `early_bird_deadline` | TIMESTAMPTZ | required for `EARLY_BIRD`, must be `<= start_at`; NULL for `BASE` |
| `early_bird_discount_pct` | SMALLINT | required for `EARLY_BIRD`, 1–99; NULL for `BASE` |
| `currency` | CHAR(3) | NOT NULL DEFAULT `BDT` |
| `seat_rows` | SMALLINT | 1–52 (row labels A–Z, AA–AZ) |
| `seats_per_row` | SMALLINT | 1–100 |
| `banner_url` | TEXT | nullable (validated upload path) |
| `sales_start_at`, `sales_end_at` | TIMESTAMPTZ | optional window; start < end, end `<= start_at` |
| `published_at` | TIMESTAMPTZ | required when `PUBLISHED` |
| `cancelled_at` | TIMESTAMPTZ | set iff `CANCELLED` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Indexes: `idx_events_organizer_start (organizer_id, start_at DESC)` (organizer dashboard), `idx_events_status_start (status, start_at)` (public browse/date filter), `idx_events_venue`, `idx_events_title_trgm` (GIN, name search).

### 4.4 `seat_categories`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `event_id` | UUID | NOT NULL → `events.id` ON DELETE CASCADE |
| `name` | VARCHAR(60) | not blank, unique per event on `lower(name)` |
| `price_minor` | BIGINT | `>= 0` (catalogue price; charged price is snapshotted) |
| `sort_order` | SMALLINT | DEFAULT 0 |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

`UNIQUE (id, event_id)` is the target of the seats composite FK.

### 4.5 `seats`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `event_id` | UUID | NOT NULL → `events.id` ON DELETE CASCADE |
| `category_id` | UUID | `(category_id, event_id)` → `seat_categories(id, event_id)` (NO ACTION) — **category must belong to the same event** |
| `row_label` | VARCHAR(4) | `^[A-Z]{1,2}$` |
| `seat_number` | SMALLINT | `>= 1` |
| `created_at` | TIMESTAMPTZ | |

Constraints: `UNIQUE (event_id, row_label, seat_number)`, `UNIQUE (id, event_id)`; index `idx_seats_category`.
Decision: `seat_number` is an integer (not text) so seat maps sort and validate naturally. The category FK is `NO ACTION` (checked at statement end) so deleting a draft event cascades to categories and seats together.

### 4.6 `bookings`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `event_id` | UUID | NOT NULL → `events.id` RESTRICT |
| `customer_id` | UUID | NOT NULL → `users.id` RESTRICT |
| `status` | VARCHAR(20) | `HELD` (default) \| `PENDING_PAYMENT` \| `CONFIRMED` \| `EXPIRED` \| `CANCELLED` |
| `hold_expires_at` | TIMESTAMPTZ | required while `HELD`/`PENDING_PAYMENT` (now + 300 s) |
| `pricing_strategy` | VARCHAR(20) | snapshot of the strategy applied (`BASE`/`EARLY_BIRD`) |
| `total_amount_minor` | BIGINT | `>= 0`, server-calculated, **immutable** |
| `refund_amount_minor` | BIGINT | DEFAULT 0, `0 <= refund <= total`, non-zero only when `CANCELLED` |
| `currency` | CHAR(3) | immutable |
| `idempotency_key` | VARCHAR(255) | nullable; unique per customer (`uq_bookings_customer_idempotency`, partial) |
| `confirmed_at` / `cancelled_at` / `expired_at` | TIMESTAMPTZ | each required when in that status |
| `cancellation_reason` | TEXT | nullable |
| `reminder_sent_at` | TIMESTAMPTZ | set once the ≥1h pre-event reminder is dispatched; only on confirmed bookings |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Indexes:
- `idx_bookings_customer_created (customer_id, created_at DESC)` — "my bookings".
- `idx_bookings_customer_event_active (customer_id, event_id) WHERE status IN (HELD, PENDING_PAYMENT, CONFIRMED)` — per-user ticket limit lookup.
- `idx_bookings_hold_expiry (hold_expires_at) WHERE status IN (HELD, PENDING_PAYMENT)` — expiry worker.
- `idx_bookings_reminder_pending (event_id) WHERE status = 'CONFIRMED' AND reminder_sent_at IS NULL` — reminder worker.
- `idx_bookings_event_status (event_id, status)`.

`payment_provider` / `payment_ref` from the original sketch were moved to `payments`: one booking may have several payment attempts.

### 4.7 `booking_seats`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `booking_id`, `event_id` | UUID | `(booking_id, event_id)` → `bookings(id, event_id)` RESTRICT |
| `seat_id`, `event_id` | UUID | `(seat_id, event_id)` → `seats(id, event_id)` RESTRICT — **booking and seat must be in the same event** |
| `price_minor` | BIGINT | `>= 0`, price snapshot, immutable |
| `seat_state` | VARCHAR(10) | `HELD` (default) \| `BOOKED` \| `RELEASED` |
| `released_at` | TIMESTAMPTZ | set iff `RELEASED` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Double-booking guard:**

```sql
CREATE UNIQUE INDEX idx_active_seat_per_event
  ON booking_seats (event_id, seat_id)
  WHERE seat_state IN ('HELD', 'BOOKED');
```

Concurrent inserts for the same seat serialise on this index; exactly one commits, the others fail with `23505`. Released rows stay as history and can never be re-activated (trigger), so a freed seat is always re-allocated through a new row that is checked by the index again. Other: `UNIQUE (booking_id, seat_id)`, indexes on `booking_id`, `seat_id`.

The index cannot contain `now()`, so expiry is explicit: the expiry worker flips expired holds to `RELEASED` inside a transaction (§5.3).

### 4.8 `booking_status_history` (append-only)

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `booking_id` | UUID | → `bookings.id` RESTRICT |
| `from_status` | VARCHAR(20) | NULL only for the first row, which must be `→ HELD` |
| `to_status` | VARCHAR(20) | NOT NULL, `<> from_status` |
| `reason` | TEXT | e.g. `seat hold`, `payment verified`, `hold expired`, `customer cancelled` |
| `actor_user_id` | UUID | → `users.id`, NULL for system actions (workers, webhooks) |
| `changed_at` | TIMESTAMPTZ | DEFAULT now() |

`UPDATE`/`DELETE` are blocked by `prevent_mutation()`. Written in the same transaction as each status change. Index `(booking_id, changed_at)`.

### 4.9 `payments`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `booking_id` | UUID | → `bookings.id` RESTRICT |
| `provider` | VARCHAR(30) | `MOCK_PROVIDER_A` \| `MOCK_PROVIDER_B` \| `SSLCOMMERZ` |
| `provider_payment_id` | VARCHAR(255) | provider transaction id; `UNIQUE (provider, provider_payment_id)` |
| `amount_minor` | BIGINT | `> 0`, must equal the booking total (verified server-side) |
| `currency` | CHAR(3) | |
| `status` | VARCHAR(20) | `INITIATED` (default) \| `PENDING` \| `SUCCEEDED` \| `FAILED` \| `CANCELLED` |
| `idempotency_key` | VARCHAR(255) | NOT NULL, UNIQUE |
| `failure_reason` | TEXT | nullable |
| `provider_metadata` | JSONB | non-sensitive metadata only (never card data or secrets) |
| `paid_at` | TIMESTAMPTZ | set iff `SUCCEEDED` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**No double charge:** `uq_payments_one_success_per_booking` — unique `(booking_id) WHERE status = 'SUCCEEDED'`. Index `(booking_id, created_at DESC)`.

### 4.10 `refunds`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `booking_id` | UUID | → `bookings.id` RESTRICT |
| `payment_id` | UUID | → `payments.id` RESTRICT |
| `amount_minor` | BIGINT | `> 0` |
| `currency` | CHAR(3) | |
| `status` | VARCHAR(20) | `PENDING` (default) \| `PROCESSING` \| `SUCCEEDED` \| `FAILED` |
| `idempotency_key` | VARCHAR(255) | NOT NULL, UNIQUE |
| `provider_refund_id` | VARCHAR(255) | UNIQUE when present |
| `reason`, `failure_reason` | TEXT | |
| `processed_at` | TIMESTAMPTZ | required for `SUCCEEDED`/`FAILED` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Refunds are all-or-nothing (full refund if cancelled > 24 h before `start_at`, else none, so no row is created). `uq_refunds_one_active_per_payment` — unique `(payment_id) WHERE status IN (PENDING, PROCESSING, SUCCEEDED)` — prevents racing duplicate refunds; a failed refund may be retried with a new row. `bookings.refund_amount_minor` is updated in the same transaction as the successful refund.

### 4.11 `payment_webhook_events`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `provider` | VARCHAR(30) | same provider set |
| `provider_event_id` | VARCHAR(255) | `UNIQUE (provider, provider_event_id)` — duplicate deliveries collapse to one row |
| `event_type` | VARCHAR(100) | |
| `payment_id` | UUID | → `payments.id` RESTRICT, nullable until matched |
| `signature_verified` | BOOLEAN | NOT NULL |
| `payload` | JSONB | redacted raw payload (forensics) |
| `processing_status` | VARCHAR(20) | `PENDING` \| `PROCESSING` \| `PROCESSED` \| `FAILED` \| `REJECTED` |
| `error_message` | TEXT | |
| `received_at`, `processed_at` | TIMESTAMPTZ | |

`chk_webhook_verified_before_processing`: an unverified event can only be `PENDING` or `REJECTED`, never processed.

### 4.12 `tickets`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `booking_seat_id` | UUID | → `booking_seats.id` RESTRICT, **UNIQUE** (one ticket per booked seat) |
| `booking_id` | UUID | → `bookings.id` RESTRICT |
| `ticket_code` | VARCHAR(64) | UNIQUE, ≥ 16 chars, random (never a sequential id) |
| `status` | VARCHAR(20) | `ACTIVE` (default) \| `USED` \| `CANCELLED` |
| `issued_at` | TIMESTAMPTZ | |
| `checked_in_at` | TIMESTAMPTZ | set iff `USED` |
| `cancelled_at` | TIMESTAMPTZ | set iff `CANCELLED` |

Issued in the confirmation transaction.

### 4.13 `notifications`

Both the in-app inbox and the email delivery queue (one row per channel per message).

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `user_id` | UUID | → `users.id` ON DELETE CASCADE |
| `booking_id` | UUID | → `bookings.id` ON DELETE SET NULL |
| `channel` | VARCHAR(20) | `EMAIL` \| `IN_APP` |
| `type` | VARCHAR(40) | `BOOKING_CONFIRMED` \| `BOOKING_CANCELLED` \| `EVENT_REMINDER_1H` |
| `title` | VARCHAR(200) | |
| `message` | TEXT | |
| `dedupe_key` | VARCHAR(255) | NOT NULL UNIQUE, e.g. `EVENT_REMINDER_1H:<booking_id>:EMAIL` |
| `delivery_status` | VARCHAR(20) | `PENDING` \| `PROCESSING` \| `SENT` \| `FAILED` |
| `attempts` | SMALLINT | `>= 0` |
| `next_attempt_at` | TIMESTAMPTZ | retry scheduling |
| `last_error` | TEXT | |
| `sent_at` | TIMESTAMPTZ | set iff `SENT` |
| `is_read` / `read_at` | BOOLEAN / TIMESTAMPTZ | consistent pair; only `IN_APP` rows can be read |
| `created_at` | TIMESTAMPTZ | |

Indexes: inbox `(user_id, created_at DESC) WHERE channel = 'IN_APP'`, unread variant, delivery queue `(next_attempt_at) WHERE delivery_status IN (PENDING, FAILED)` claimed with `FOR UPDATE SKIP LOCKED`, `booking_id`.
Decision: a dedicated outbox table was folded into `notifications`. Rows are inserted in the same transaction as the booking change (transactional outbox), and `dedupe_key` makes confirmation/cancellation/reminder dispatch idempotent even if a worker retries. New channels only add a `channel` value and a `NotificationChannel` implementation.

### 4.14 `idempotency_keys`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | PK |
| `user_id` | UUID | → `users.id` ON DELETE CASCADE |
| `endpoint` | VARCHAR(200) | e.g. `POST /api/bookings/:id/pay` |
| `idempotency_key` | VARCHAR(255) | from the `Idempotency-Key` header |
| `request_hash` | CHAR(64) | SHA-256 of the canonical body: same key + different body is rejected |
| `status` | VARCHAR(20) | `IN_PROGRESS` \| `COMPLETED` |
| `response_status` / `response_body` | SMALLINT / JSONB | cached response replayed on retry; required when `COMPLETED` |
| `locked_until` | TIMESTAMPTZ | protects against concurrent duplicates |
| `expires_at` | TIMESTAMPTZ | retention (cleanup job); `> created_at` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

`UNIQUE (user_id, endpoint, idempotency_key)` implements the "Idempotency-Key + userId + endpoint" rule. Stored in PostgreSQL (not Redis) so a cached payment response survives restarts.

### 4.15 `audit_logs` (append-only)

`id`, `actor_user_id` (→ users, nullable for system), `action` VARCHAR(100), `entity_type` VARCHAR(50), `entity_id` UUID, `metadata` JSONB (redacted), `ip_address` INET, `request_id` VARCHAR(100), `created_at`. Indexes `(entity_type, entity_id, created_at DESC)`, `(actor_user_id, created_at DESC)`. `UPDATE`/`DELETE` blocked.

### 4.16 `schema_migrations`

Managed by the migration runner: `version` (PK), `name`, `checksum` (SHA-256 of the file), `applied_at`. RLS enabled and API roles revoked.

---

## 5. Booking lifecycle

### 5.1 Status transitions

| From | Allowed to |
| --- | --- |
| *(insert)* | `HELD` only |
| `HELD` | `PENDING_PAYMENT`, `EXPIRED`, `CANCELLED` |
| `PENDING_PAYMENT` | `CONFIRMED`, `EXPIRED`, `CANCELLED` |
| `CONFIRMED` | `CANCELLED` |
| `EXPIRED`, `CANCELLED` | — (terminal) |

Defined once in code (`backend/src/domain/lifecycle/bookingStateMachine.ts`) and mirrored by the `enforce_booking_status_transition()` trigger. An integration test checks all 20 status pairs against both and fails if they diverge. The trigger also blocks changes to `total_amount_minor`, `currency`, `customer_id` and `event_id`.

Seat allocations: `HELD → BOOKED | RELEASED`, `BOOKED → RELEASED`; `RELEASED` is terminal (`enforce_booking_seat_state_transition()`), and price/seat/booking are immutable.

### 5.2 Seat hold (implemented in a later phase, enabled by this schema)

1. Expire stale holds for the event (§5.3).
2. Acquire Redis locks `seat_hold:{eventId}:{seatId}` all-or-nothing (Lua script, owner token, TTL 300 s).
3. `BEGIN`; take `SELECT … FROM events WHERE id = $1 FOR SHARE` (organizer edits lock the event row `FOR UPDATE`, so a hold can never race a seat-map rebuild or reschedule), then `pg_advisory_xact_lock` on `(customer_id, event_id)` to serialise one customer's parallel requests; count active seats (`HELD`/`BOOKED` rows of active bookings) and reject if `count + requested > MAX_TICKETS_PER_USER_PER_EVENT` (default 6).
4. Insert `bookings` (`HELD`, `hold_expires_at = now() + 300 s`, server-computed total) and `booking_seats` (`HELD`, price snapshot); `idx_active_seat_per_event` is the final guard.
5. Insert history `NULL → HELD`; `COMMIT`; release only locks owned by this token (compare-and-delete).

### 5.3 Hold expiry

Worker selects `bookings WHERE status IN ('HELD','PENDING_PAYMENT') AND hold_expires_at <= now()` using `idx_bookings_hold_expiry` with `FOR UPDATE SKIP LOCKED`, and per booking in one transaction: status → `EXPIRED` + `expired_at`, seats → `RELEASED` + `released_at`, history row, then deletes the Redis locks.

### 5.4 Confirmation

In one transaction: lock the booking (`FOR UPDATE`), re-verify owner, state and `hold_expires_at > now()`, verify the payment server-side (amount, currency, signature), mark the payment `SUCCEEDED` (unique success index), booking → `CONFIRMED`, seats → `BOOKED`, issue tickets, write history, insert confirmation notifications (EMAIL + IN_APP). A payment that succeeds after the hold expired is never silently confirmed: it is refunded.

### 5.5 Cancellation and refund

`hoursUntilEvent = (events.start_at − now) / 1 h`. If `> 24`: full refund (`refunds` row + gateway refund, `refund_amount_minor = total`); otherwise refund 0. Booking → `CANCELLED`, seats → `RELEASED`, tickets → `CANCELLED`, history row and cancellation notifications, all in one transaction.

### 5.6 Pre-event reminder

Worker selects confirmed bookings with `reminder_sent_at IS NULL` whose event starts within the next hour, inserts `EVENT_REMINDER_1H` notifications (dedupe keys make re-runs harmless) and sets `reminder_sent_at`.

---

### 5.7 Organizer changes vs. active bookings (Phase 2)

Organizer mutations run in a transaction that locks the event row `FOR UPDATE` and re-checks state:

| Change | Allowed when |
| --- | --- |
| Title, description, banner, pricing strategy, category name/price | Event is DRAFT or PUBLISHED (bookings keep their price snapshot) |
| Venue, start/end time | No active bookings (CONFIRMED, or HELD/PENDING_PAYMENT with an unexpired hold) |
| Move seats to another category | None of those seats has an active allocation |
| Rebuild the seat map | The event has no booking history at all |
| Unpublish / cancel | No active bookings (refunding sold events comes with booking management) |
| Delete | DRAFT or CANCELLED and no booking history |

No schema change was needed in Phase 2: users, venues, events, categories and seats already carry every field used by authentication and event management.

## 6. Triggers and functions

| Function | Used by | Purpose |
| --- | --- | --- |
| `set_updated_at()` | users, venues, events, seat_categories, bookings, booking_seats, payments, refunds, idempotency_keys | Keep `updated_at` correct |
| `prevent_mutation()` | booking_status_history, audit_logs | Append-only history |
| `enforce_booking_status_transition()` | bookings (INSERT/UPDATE) | Transition map + immutable amounts/ownership |
| `enforce_booking_seat_state_transition()` | booking_seats (INSERT/UPDATE) | Seat state map + immutable snapshot |

All functions pin `search_path = public, pg_temp`.

---

## 7. Security (Supabase)

- The backend connects through the session pooler / direct connection with a privileged role (TLS; optional CA verification via `DATABASE_SSL_CA_PATH`).
- Browsers never connect to Supabase. Migration `0006` enables RLS on every table with **no policies** and revokes all privileges from `anon` and `authenticated`, so the PostgREST Data API returns nothing even with the public anon key. `schema_migrations` gets the same treatment. Verified on the live project by `npm run test:live`.
- New tables must be added to migration-level RLS/REVOKE (Supabase grants API roles default privileges on new public tables).
- No secrets, OTPs, tokens or card data are stored in plain form: passwords are bcrypt hashes, OTPs live hashed in Redis with a TTL, provider metadata and audit metadata are redacted.

---

## 8. Deletion and update behaviour

| Relationship | ON DELETE | Reason |
| --- | --- | --- |
| events, venues, bookings → users | RESTRICT | Users with history are deactivated (`is_active`), not deleted |
| events → venues | RESTRICT | Venue in use cannot disappear |
| seat_categories, seats → events | CASCADE | A draft event with no bookings can be deleted cleanly |
| bookings → events | RESTRICT | Events with bookings are cancelled, not deleted |
| booking_seats, payments, refunds, tickets, history → bookings | RESTRICT | Financial/audit history is permanent |
| notifications → users | CASCADE | Inbox belongs to the user |
| notifications → bookings | SET NULL | Keep the message if the booking reference goes |
| idempotency_keys → users | CASCADE | Ephemeral cache |

No foreign key uses `ON UPDATE CASCADE`: UUID primary keys never change.

---

## 9. Redis key families

| Key | Value | TTL | Purpose |
| --- | --- | --- | --- |
| `ticketflow:seat_hold:{eventId}:{seatId}` | owner token | 300 s | Hold coordination (not authoritative) |
| `ticketflow:otp:{email}` | OTP hash | 300 s | Signup verification |
| `ticketflow:otp_attempts:{email}` | counter | 300 s | Brute-force limit |

---

## 10. Key decisions

1. **Composite foreign keys** for every same-event relationship (seat ↔ category, booking ↔ seat, event ↔ venue owner) instead of app-only checks.
2. **Partial unique index** rather than a lock table for double-booking prevention: it is atomic, survives Redis failure and keeps released allocations as history.
3. **Separate `payments` and `refunds`** so retries, failures and provider callbacks are fully recorded; partial unique indexes stop double charges and duplicate refunds.
4. **Trigger-enforced state machines** duplicate the domain map as a safety net; a test keeps both identical.
5. **Notifications as a transactional outbox** with dedupe keys, instead of an extra outbox table.
6. **Deferred tables** (`event_staff`, payouts, promo codes, waitlists, check-in logs) are out of scope for the PRD and will be added as new migrations when needed.

---

## 11. Verification

| Check | Where |
| --- | --- |
| Migrations apply, are idempotent, detect edited files, roll back failures, serialise concurrent runs | `backend/tests/integration/database/migrations.test.ts` |
| Double booking (8 concurrent transactions → 1 winner), same-event FKs, transition map parity, immutability, append-only history, payment/refund/webhook uniqueness, email case-insensitivity, early-bird checks | `backend/tests/integration/database/schemaIntegrity.test.ts` |
| Transactions, retries, read-only mode, seed idempotency | `backend/tests/integration/database/transactionsAndSeed.test.ts` |
| Live Supabase: migrated, RLS/privileges locked, demo data, real transaction | `backend/tests/live/supabase.live.test.ts` |
