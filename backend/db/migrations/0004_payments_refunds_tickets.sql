-- 0004: payments, refunds, payment webhook events, tickets.
-- See DATABASE_DESIGN.md §4.9–§4.12.

-- -------------------------------------------------------------- payments
CREATE TABLE public.payments (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID         NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  provider            VARCHAR(30)  NOT NULL,
  provider_payment_id VARCHAR(255),
  amount_minor        BIGINT       NOT NULL,
  currency            CHAR(3)      NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'INITIATED',
  idempotency_key     VARCHAR(255) NOT NULL,
  failure_reason      TEXT,
  -- Non-sensitive provider metadata only (never card data / secrets).
  provider_metadata   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_payments_provider_payment UNIQUE (provider, provider_payment_id),
  CONSTRAINT chk_payments_provider CHECK (
    provider IN ('MOCK_PROVIDER_A', 'MOCK_PROVIDER_B', 'SSLCOMMERZ')
  ),
  CONSTRAINT chk_payments_status CHECK (
    status IN ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT chk_payments_amount CHECK (amount_minor > 0),
  CONSTRAINT chk_payments_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_payments_paid_at CHECK ((status = 'SUCCEEDED') = (paid_at IS NOT NULL))
);

-- No double charge: at most one successful capture per booking.
CREATE UNIQUE INDEX uq_payments_one_success_per_booking
  ON public.payments (booking_id)
  WHERE status = 'SUCCEEDED';
CREATE INDEX idx_payments_booking_created ON public.payments (booking_id, created_at DESC);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- --------------------------------------------------------------- refunds
CREATE TABLE public.refunds (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID         NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  payment_id         UUID         NOT NULL REFERENCES public.payments (id) ON DELETE RESTRICT,
  amount_minor       BIGINT       NOT NULL,
  currency           CHAR(3)      NOT NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  idempotency_key    VARCHAR(255) NOT NULL,
  provider_refund_id VARCHAR(255),
  reason             TEXT,
  failure_reason     TEXT,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_refunds_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_refunds_provider_refund_id UNIQUE (provider_refund_id),
  CONSTRAINT chk_refunds_status CHECK (
    status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')
  ),
  CONSTRAINT chk_refunds_amount CHECK (amount_minor > 0),
  CONSTRAINT chk_refunds_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_refunds_processed_at CHECK (
    status NOT IN ('SUCCEEDED', 'FAILED') OR processed_at IS NOT NULL
  )
);

-- Refund policy is all-or-nothing, so a payment has at most one live refund.
-- Failed refunds may be retried with a new row.
CREATE UNIQUE INDEX uq_refunds_one_active_per_payment
  ON public.refunds (payment_id)
  WHERE status IN ('PENDING', 'PROCESSING', 'SUCCEEDED');
CREATE INDEX idx_refunds_booking_created ON public.refunds (booking_id, created_at DESC);

CREATE TRIGGER trg_refunds_updated_at
  BEFORE UPDATE ON public.refunds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------ payment_webhook_events
CREATE TABLE public.payment_webhook_events (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           VARCHAR(30)  NOT NULL,
  provider_event_id  VARCHAR(255) NOT NULL,
  event_type         VARCHAR(100) NOT NULL,
  payment_id         UUID         REFERENCES public.payments (id) ON DELETE RESTRICT,
  signature_verified BOOLEAN      NOT NULL,
  payload            JSONB        NOT NULL,
  processing_status  VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  error_message      TEXT,
  received_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  -- Duplicate deliveries collapse onto one row => processed at most once.
  CONSTRAINT uq_webhook_provider_event UNIQUE (provider, provider_event_id),
  CONSTRAINT chk_webhook_provider CHECK (
    provider IN ('MOCK_PROVIDER_A', 'MOCK_PROVIDER_B', 'SSLCOMMERZ')
  ),
  CONSTRAINT chk_webhook_processing_status CHECK (
    processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'REJECTED')
  ),
  -- Unverified payloads are stored for forensics but can never be processed.
  CONSTRAINT chk_webhook_verified_before_processing CHECK (
    signature_verified = true OR processing_status IN ('REJECTED', 'PENDING')
  )
);

CREATE INDEX idx_webhook_pending
  ON public.payment_webhook_events (received_at)
  WHERE processing_status IN ('PENDING', 'FAILED');
CREATE INDEX idx_webhook_payment ON public.payment_webhook_events (payment_id);

-- --------------------------------------------------------------- tickets
CREATE TABLE public.tickets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_seat_id UUID        NOT NULL REFERENCES public.booking_seats (id) ON DELETE RESTRICT,
  booking_id      UUID        NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  ticket_code     VARCHAR(64) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_at   TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  CONSTRAINT uq_tickets_booking_seat UNIQUE (booking_seat_id),
  CONSTRAINT uq_tickets_code UNIQUE (ticket_code),
  CONSTRAINT chk_tickets_status CHECK (status IN ('ACTIVE', 'USED', 'CANCELLED')),
  CONSTRAINT chk_tickets_code_length CHECK (length(ticket_code) >= 16),
  CONSTRAINT chk_tickets_checked_in CHECK ((status = 'USED') = (checked_in_at IS NOT NULL)),
  CONSTRAINT chk_tickets_cancelled CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX idx_tickets_booking ON public.tickets (booking_id);
