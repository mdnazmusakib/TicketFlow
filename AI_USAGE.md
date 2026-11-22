# AI Usage — TicketFlow

## 1. How AI was used

TicketFlow was built in six phases with **Claude Code** (Anthropic) working as a pair programmer on the repository owner's machine, with a human in the loop for every phase:

| Phase | Scope | AI role | Human role |
| --- | --- | --- | --- |
| 1 | Monorepo, database design, migrations, Redis primitives, frontend foundation | drafted `DATABASE_DESIGN.md` and migrations, wrote infrastructure code and tests | set requirements (PRD/TRD/CLAUDE.md), created Supabase and Redis, filled `backend/.env` |
| 2 | Auth, OTP, RBAC, events, discovery | implemented services, routes, React pages, tests | reviewed and tested on localhost |
| 3 | Pricing, holds, ticket limit, concurrency | implemented strategies, locks, lifecycle, concurrency suite | reviewed |
| 4 | Payments, cancellation, refunds, SSLCommerz | implemented adapters, idempotency, webhooks, refunds | provided SSLCommerz sandbox credentials |
| 5 | Notifications, reminders, dashboards | outbox, reminder worker, inbox, dashboards | reviewed |
| 6 | Testing, security audit, CI/CD, deployment, docs | E2E suite, upload security, CI workflows, Render/Vercel deployment, audit, docs | reviews and commits all changes, chose a Docker-free free-tier setup, configures hosting and secrets |

Engineering aids named in the TRD: Context7-style documentation lookup (library APIs were checked against official docs, e.g. the SSLCommerz v4 Refund API spec was fetched and the adapter fixed to send the mandatory `refund_trans_id`), sequential reasoning for edge cases (late captures, lease expiry, reminder windows), concise "caveman" communication, and `anthropics/claude-code-security-review` in CI. Strix was not run (see the compliance matrix).

## 2. Guardrails that were followed

- **No secrets to the AI**: the assistant never read or modified any `.env` file (enforced by a deny rule in the Claude Code settings). Scripts that need credentials load them with `dotenv` and never print values.
- **No git operations by the AI**: every commit and push was done by the repository owner after review.
- **Verification over claims**: each phase ended with lint, typecheck, build and the test suites actually run, with results reported (including failures). Live services (Supabase, Redis, SSLCommerz sandbox) were exercised with dedicated suites rather than assumed.
- **Architecture rules** from `.claude/CLAUDE.md` (layering, SOLID, patterns only where needed) were enforced in code review and partly by ESLint import rules.

## 3. Where AI output needed correction

Examples kept as lessons (all fixed and covered by tests):
- SSLCommerz sandbox reports `PROCESSING` for an unpaid session; the first adapter treated unknown statuses as failures. Now only explicit failures close an attempt.
- The SSLCommerz refund request lacked the mandatory `refund_trans_id` (new in the 2025 API); found by checking the official spec.
- A documentation edit using `String.replace` with a `$` + backtick sequence duplicated half of `DATABASE_DESIGN.md`; detected later and repaired, and edits now use replacer functions.
- Shell heredocs occasionally dropped backslashes in regular expressions; files are now written with editor tools instead.
- A schema test expected SQLSTATE `23001` for an `ON DELETE RESTRICT` violation: true on PostgreSQL 18 (local embedded server) but CI and Supabase run PostgreSQL 17, which reports `23503`. The test now accepts both and checks the row survives, and the error mapper handles both codes.
- The first deployment proposal used Docker; at the owner's request it was replaced by a Render native Node service + Vercel, which also exposed the cross-site cookie and ephemeral-disk issues that were then fixed (Vercel proxy, Supabase Storage driver).
- PostgreSQL parameter type inference (`inconsistent types deduced for parameter`) required explicit casts in several queries.

## 4. Responsibility

AI-generated code is treated like any contributor's code: it is reviewed, tested and owned by the repository owner. Security-relevant logic (auth, payments, refunds, uploads) has dedicated unit, integration and end-to-end tests so regressions are caught regardless of who writes the change.
