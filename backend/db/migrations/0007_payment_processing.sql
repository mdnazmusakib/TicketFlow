-- 0007: payment processing support (Phase 4).
-- See DATABASE_DESIGN.md §4.9–§4.11 and §6 (payments).

-- Merchant transaction reference sent to providers (SSLCommerz `tran_id`
-- allows at most 30 characters, so a UUID cannot be used directly).
ALTER TABLE public.payments
  ADD COLUMN transaction_ref VARCHAR(30);

UPDATE public.payments
  SET transaction_ref = 'TF' || substr(replace(id::text, '-', ''), 1, 24)
  WHERE transaction_ref IS NULL;

ALTER TABLE public.payments
  ALTER COLUMN transaction_ref SET NOT NULL,
  ADD CONSTRAINT uq_payments_transaction_ref UNIQUE (transaction_ref),
  ADD CONSTRAINT chk_payments_transaction_ref CHECK (transaction_ref ~ '^[A-Za-z0-9_-]{8,30}$');

-- At most one in-flight payment attempt per booking: a second attempt (any
-- idempotency key, any provider) must wait until the first is resolved.
CREATE UNIQUE INDEX uq_payments_one_open_per_booking
  ON public.payments (booking_id)
  WHERE status IN ('INITIATED', 'PENDING');

-- Reconciliation worker scan for attempts with an unknown outcome.
CREATE INDEX idx_payments_open
  ON public.payments (updated_at)
  WHERE status IN ('INITIATED', 'PENDING');

-- Refund retry bookkeeping.
ALTER TABLE public.refunds
  ADD COLUMN attempt SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN next_retry_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_refunds_attempt CHECK (attempt BETWEEN 1 AND 20);

CREATE UNIQUE INDEX uq_refunds_payment_attempt ON public.refunds (payment_id, attempt);

-- Retry / status-poll worker scan.
CREATE INDEX idx_refunds_due
  ON public.refunds (next_retry_at)
  WHERE status IN ('PENDING', 'PROCESSING', 'FAILED');

-- Payment status guard (mirrors domain/payments/paymentStateMachine.ts):
--   INITIATED -> PENDING | SUCCEEDED | FAILED | CANCELLED
--   PENDING   -> SUCCEEDED | FAILED | CANCELLED
--   FAILED / CANCELLED -> SUCCEEDED   (provider verification proves money was captured)
--   SUCCEEDED is terminal; amount, currency, booking and provider are immutable.
CREATE OR REPLACE FUNCTION public.enforce_payment_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INITIATED' THEN
      RAISE EXCEPTION 'payment must be created in INITIATED state, got %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'INITIATED' AND NEW.status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    OR (OLD.status IN ('FAILED', 'CANCELLED') AND NEW.status = 'SUCCEEDED')
  ) THEN
    RAISE EXCEPTION 'invalid payment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.provider <> OLD.provider
     OR NEW.transaction_ref <> OLD.transaction_ref THEN
    RAISE EXCEPTION 'payment amount, currency, booking, provider and reference are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payments_transition
  BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_transition();

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.enforce_payment_transition() FROM %I', api_role);
    END IF;
  END LOOP;
END;
$$;
