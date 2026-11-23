# Product Requirements Document (PRD) — TicketFlow

## 1. Objective
Build **TicketFlow**, an event ticket booking platform (similar to Ticketmaster or BookMyShow) where **Organizers** create events with seat maps and pricing strategies, and **Customers** browse events, hold seats within ticket limits, pay reliably, receive timely email and in-app notifications, and cancel bookings under clear refund rules.

## 2. User Roles & Demo Access
- **Organizer**: Creates and manages **only their own** events, venues, schedules, seat maps (`rows × seats`), seat categories with prices, and pricing strategy.
- **Customer**: Searches/browses events, holds seats within per-user limits, pays via mock providers or SSLCommerz, views bookings & in-app notifications, and cancels bookings.
- **Protected / Admin Routes**: Enforced authentication, RBAC, and resource ownership rules so no user can access another user's private routes/data.
- **Demo Accounts**: Ready-to-use **Organizer** and **Customer** test credentials documented in `README.md` and login screen.

## 3. Core Functional Requirements
1. **Authentication + Email OTP + Test Bypass**:
   - User registration with email OTP verification.
   - **Test Environment Bypass**: When running automated tests (`NODE_ENV=test` or `TEST_BYPASS_OTP=true`), email OTP verification is bypassed automatically so automated bots/tests can sign up and authenticate reliably.
   - Login/logout with `httpOnly` cookie JWT + `bcrypt` password hashing + RBAC.
2. **Event Management**:
   - Venue, date-time, seat map (`rows × seats`), seat categories with prices, and pricing strategy selection; Organizers can only manage their own events.
3. **Browse Events**:
   - Search by name/city/date, filters, and pagination.
4. **Temporary Seat Hold & Expiry**:
   - Seat selection with a temporary hold (5 minutes); a held seat cannot be taken by anyone else; the hold is released automatically when it expires.
5. **Single-User Ticket Limit**:
   - A single user cannot book/hold more than the maximum allowed tickets per event (default `6` tickets per user per event across active holds and confirmed bookings).
6. **Booking Lifecycle**:
   - States: `HELD -> PENDING_PAYMENT -> CONFIRMED | EXPIRED | CANCELLED`; only valid status transitions allowed; keep a full status history.
7. **Payments & Idempotency**:
   - Payment with at least **2 mock payment providers** (`MockProviderA`, `MockProviderB`) plus **SSLCommerz** behind one common interface; switching providers must not change booking code; payment must be idempotent (no double charge on retry); verify webhooks server-side.
8. **Pricing Strategies**:
   - At least **2 strategies** (`BasePriceStrategy`, `EarlyBirdStrategy`); Organizer chooses the pricing strategy per event.
9. **Notifications & Reminders**:
   - Users must receive a **ticket purchase confirmation email** (plus In-App notification) upon booking confirmation.
   - Users must receive a **pre-event notification at least 1 hour before the event starts** (Email + In-App).
   - Users must receive cancellation notifications (Email + In-App) upon booking cancellation.
   - Adding a new notification channel must not require changing core booking code.
10. **Zero Double Booking**:
    - Under concurrent requests for the same seat at the same moment, only one succeeds.
11. **Cancellation & Refund Rule**:
    - Full refund if cancelled **more than 24 hours** before the event start time; otherwise no refund (`0`).
12. **Operational & Security Baseline**:
    - Input validation, file upload validation, central error handling, redacted structured logging, environment-based config, no secrets committed to repository, protected admin/private routes, rate limiting, strict CORS, disabled production debugging, and security review.

## 4. Testing, CI/CD & Documentation Deliverables
- **Testing**: Unit & integration tests via **Jest** (with coverage report in CI) + E2E tests via **Playwright CLI**.
- **CI/CD**: On push/PR: lint + build + unit/integration tests + coverage + `anthropics/claude-code-security-review`; on merge to `main`: automatic deployment of frontend and backend.
- **Hosting & Docs**: Live frontend, backend, and database; complete `README.md`, `ARCHITECTURE.md`, `AI_USAGE.md`, `PRD.md`, `TRD.md`, `DATABASE_DESIGN.md`, and `ALGORITHMS_AND_SECURITY.md`.
## 5. Implementation Notes (Phase 6)
- **Platform fee & VAT**: every booked seat carries a BDT 10 platform charge (TicketFlow revenue) and 2% VAT on the ticket price (tax liability), both configurable; the customer pays tickets + platform charge + VAT, shown as a breakdown before payment and on the receipt. Eligible cancellations refund the ticket price; platform charge and VAT are refundable only when configured. Financial reports keep ticket sales, platform revenue and VAT separate.
- **Admin**: an `ADMIN` role (seeded demo admin, never self-registered) has read-only platform oversight (`/admin`: totals, failed refunds, open payments, notification delivery, user directory) and can manage any organizer's events and venues.
- **Dashboards**: customers get a dashboard (bookings, payments, refunds, notifications); organizers get sales, occupancy and per-event booking overviews (customer emails masked).
- **File uploads**: implemented for event banner images (JPEG/PNG/WebP, ≤ 2 MB, content-verified, random file names).
- **Reminders**: sent when the event starts between 1 hour and `REMINDER_WINDOW_MINUTES` (default 2 hours) from now, so they always arrive at least 1 hour before the start, exactly once.
- **Deployment (free tier, no Docker)**: API on Render (native Node, deploys `main` after CI checks pass), web app on Vercel (deploys `main`; proxies `/api` so the session cookie stays first-party), Supabase PostgreSQL + Storage, Upstash Redis. Live hosting is configured by the repository owner (see `COMPLIANCE_MATRIX.md`).
