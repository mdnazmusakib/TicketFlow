# Technical Requirements Document (TRD) — TicketFlow

## 1. Tech Stack & Infrastructure
- **Backend**: Node.js (LTS; ≥ 22, CI on 24) + TypeScript (strict mode) + Express.js 5.
- **Primary Database**: **Supabase PostgreSQL** (ACID transactions, partial unique indexes, relational integrity, status history, RLS lockdown).
- **Cache / Ephemeral Lock & OTP Store**: **Redis** (seat hold locks/TTLs, OTP storage with TTL, session revocation, shared rate-limit counters).
- **Frontend**: React 19 (Vite) + TypeScript + React Router.
- **Testing**: **Jest** (+ Supertest for API integration tests & coverage reports, embedded PostgreSQL) + **Playwright CLI** (E2E tests).
- **Deployment (no Docker)**: Render native Node web service for the API (Blueprint `render.yaml`, auto-deploy of `main` after CI checks pass, migrations in the build), Vercel for the web app (`frontend/vercel.json`, deploys `main`, rewrites `/api` to the API for first-party cookies), Supabase PostgreSQL + Storage, managed Redis (Upstash).
- **Engineering Aids**: Sequential Thinking for edge-case analysis, Context7 for up-to-date library docs, Caveman for concise specs, Strix & `anthropics/claude-code-security-review` for security verification.

## 2. Layered Backend Architecture
```text
backend/src/
├── config/            # env validation (+ production rules), redacted logger, cors
├── middlewares/       # auth (JWT cookie + requireRole), validate (zod), rateLimiter, upload, spa, errorHandler, requestId, requestLogger
├── controllers/       # HTTP request/response handling only
├── services/          # auth, events (+ banner), booking (lifecycle, holds, expiry), payments (idempotency, webhooks, refunds, cancellation), notifications (dispatcher, reminders, inbox), dashboard
├── domain/
│   ├── pricing/       # PricingStrategy interface, BasePriceStrategy, EarlyBirdStrategy, registry
│   ├── payments/      # PaymentGateway interface, refund rule
│   ├── notifications/ # NotificationChannel interface, templates, EmailSender interface
│   ├── lifecycle/     # Booking & seat state machines and valid transitions
│   ├── events/        # event/seat-map rules
│   └── uploads/       # image policy and content detection, FileStorage interface
├── infrastructure/    # Database (transactions), Redis locks/TTL/rate-limit store, payment adapters (MockProviderA/B, SslCommerzAdapter), SMTP/console email, local file storage
├── repositories/      # PostgreSQL & Redis data access
├── workers/           # booking expiry, notification/reminder interval worker
├── db/                # Migrator, Seeder, CLIs
├── routes/            # Express route definitions
├── app.ts · container.ts (composition root) · server.ts
backend/tests/         # unit, integration, concurrency, live, sandbox, e2e stack, helpers
e2e/                   # Playwright journeys
```

## 3. Implementation notes (deviations from the original outline)
- Ownership checks live in services (IDOR-safe 404s) rather than a separate `ownership` middleware; idempotency is a service (`IdempotencyService`) used by the payment route instead of a generic middleware. Both keep controllers HTTP-only.
- Payment adapters are infrastructure (they call external HTTP APIs); the `PaymentGateway` interface stays in the domain.
- Notification delivery uses a transactional outbox in the `notifications` table instead of a separate outbox table.
- Uploads: event banner images through `POST /api/organizer/events/:id/banner` (multer memory storage + magic-byte validation); files behind a `FileStorage` interface with two drivers: local disk (development) and Supabase Storage (ephemeral hosts such as Render free).
- Rate limiting counters are stored in Redis so limits hold across instances.
