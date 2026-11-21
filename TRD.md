# Technical Requirements Document (TRD) — TicketFlow

## 1. Tech Stack & Infrastructure
- **Backend**: Node.js (LTS) + TypeScript (strict mode) + Express.js.
- **Primary Database**: **Supabase PostgreSQL** (ACID transactions, partial unique indexes, relational integrity, status history).
- **Cache / Ephemeral Lock & OTP Store**: **Redis** (seat hold locks/TTLs, OTP storage with TTL, optional rate-limit/event-list cache).
- **Frontend**: React (Vite or Next.js) + TypeScript.
- **Testing**: **Jest** (+ Supertest for API integration tests & coverage reports) + **Playwright CLI** (E2E tests).
- **Engineering Aids**: Sequential Thinking for edge-case analysis, Context7 for up-to-date library docs, Caveman for concise specs, Strix & `anthropics/claude-code-security-review` for security verification.

## 2. Layered Backend Architecture
```text
src/
├── config/            # env validation, redacted logger, cors, supabase db, redis
├── middlewares/       # auth, rbac, ownership, rateLimit, validate, upload, errorHandler, idempotency
├── controllers/       # HTTP request/response handling only
├── services/          # business logic, booking lifecycle, hold/expiry, refund, reminder scheduler
├── domain/
│   ├── pricing/       # PricingStrategy interface, BasePriceStrategy, EarlyBirdStrategy
│   ├── payments/      # PaymentGateway interface, MockProviderA, MockProviderB, SslCommerzAdapter
│   ├── notifications/ # NotificationChannel interface, EmailChannel, InAppChannel, Dispatcher
│   └── lifecycle/     # Booking state machine & valid transitions
├── repositories/      # PostgreSQL & Redis data access
├── routes/            # Express route definitions
└── tests/             # Jest unit & integration tests