-- 0009: per-booking financial snapshot (ticket subtotal, platform fee, VAT) and the
-- component split of every refund. See DATABASE_DESIGN.md §4.6, §4.10 and §5.8.
--
-- bookings.total_amount_minor keeps its meaning: the amount the customer is charged,
-- now = ticket_subtotal_minor + platform_fee_minor + vat_minor (grand total).
-- Existing bookings were sold without fees: they are backfilled with the whole amount as
-- ticket subtotal and zero fee/VAT, so historical totals never change.

-- ------------------------------------------------------------- bookings
ALTER TABLE public.bookings
  ADD COLUMN ticket_subtotal_minor       BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN platform_fee_minor          BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN platform_fee_per_seat_minor BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN vat_minor                   BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN vat_rate_bps                INTEGER NOT NULL DEFAULT 0;

UPDATE public.bookings SET ticket_subtotal_minor = total_amount_minor;

ALTER TABLE public.bookings
  ADD CONSTRAINT chk_bookings_charges CHECK (
    ticket_subtotal_minor >= 0
    AND platform_fee_minor >= 0
    AND platform_fee_per_seat_minor >= 0
    AND vat_minor >= 0
    AND vat_rate_bps BETWEEN 0 AND 10000
    AND total_amount_minor = ticket_subtotal_minor + platform_fee_minor + vat_minor
  );

-- The snapshot is as immutable as the charged amount itself.
CREATE OR REPLACE FUNCTION public.enforce_booking_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'HELD' THEN
      RAISE EXCEPTION 'booking must be created in HELD state, got %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'HELD'            AND NEW.status IN ('PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'))
      OR (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
      OR (OLD.status = 'CONFIRMED'       AND NEW.status = 'CANCELLED')
    ) THEN
      RAISE EXCEPTION 'invalid booking status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Charged amounts, their breakdown and ownership are immutable once the booking exists.
  IF NEW.total_amount_minor <> OLD.total_amount_minor
     OR NEW.ticket_subtotal_minor <> OLD.ticket_subtotal_minor
     OR NEW.platform_fee_minor <> OLD.platform_fee_minor
     OR NEW.platform_fee_per_seat_minor <> OLD.platform_fee_per_seat_minor
     OR NEW.vat_minor <> OLD.vat_minor
     OR NEW.vat_rate_bps <> OLD.vat_rate_bps
     OR NEW.customer_id <> OLD.customer_id
     OR NEW.event_id <> OLD.event_id
     OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'booking amount, charges, currency, customer and event are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- -------------------------------------------------------------- refunds
ALTER TABLE public.refunds
  ADD COLUMN ticket_minor       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN platform_fee_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN vat_minor          BIGINT NOT NULL DEFAULT 0;

UPDATE public.refunds SET ticket_minor = amount_minor;

ALTER TABLE public.refunds
  ADD CONSTRAINT chk_refunds_components CHECK (
    ticket_minor >= 0
    AND platform_fee_minor >= 0
    AND vat_minor >= 0
    AND amount_minor = ticket_minor + platform_fee_minor + vat_minor
  );

-- Finance report scans by time.
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON public.payments (paid_at) WHERE status = 'SUCCEEDED';
CREATE INDEX IF NOT EXISTS idx_refunds_processed_at ON public.refunds (processed_at) WHERE status = 'SUCCEEDED';
