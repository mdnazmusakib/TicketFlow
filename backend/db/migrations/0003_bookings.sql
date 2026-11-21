-- 0003: bookings, booking seats, booking status history + lifecycle guards.
-- See DATABASE_DESIGN.md §4.6–§4.8 and §5.

-- -------------------------------------------------------------- bookings
CREATE TABLE public.bookings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID        NOT NULL REFERENCES public.events (id) ON DELETE RESTRICT,
  customer_id         UUID        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  status              VARCHAR(20) NOT NULL DEFAULT 'HELD',
  hold_expires_at     TIMESTAMPTZ,
  pricing_strategy    VARCHAR(20) NOT NULL,
  total_amount_minor  BIGINT      NOT NULL,
  refund_amount_minor BIGINT      NOT NULL DEFAULT 0,
  currency            CHAR(3)     NOT NULL,
  idempotency_key     VARCHAR(255),
  confirmed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  expired_at          TIMESTAMPTZ,
  cancellation_reason TEXT,
  reminder_sent_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bookings_id_event UNIQUE (id, event_id),
  CONSTRAINT chk_bookings_status CHECK (
    status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT chk_bookings_pricing_strategy CHECK (pricing_strategy IN ('BASE', 'EARLY_BIRD')),
  CONSTRAINT chk_bookings_amounts CHECK (
    total_amount_minor >= 0
    AND refund_amount_minor >= 0
    AND refund_amount_minor <= total_amount_minor
  ),
  CONSTRAINT chk_bookings_currency CHECK (currency ~ '^[A-Z]{3}$'),
  -- Pre-confirmation states always carry an expiry the expiry worker can act on.
  CONSTRAINT chk_bookings_hold_expiry CHECK (
    status NOT IN ('HELD', 'PENDING_PAYMENT') OR hold_expires_at IS NOT NULL
  ),
  CONSTRAINT chk_bookings_confirmed_at CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL),
  CONSTRAINT chk_bookings_cancelled_at CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
  CONSTRAINT chk_bookings_expired_at CHECK (status <> 'EXPIRED' OR expired_at IS NOT NULL),
  CONSTRAINT chk_bookings_refund_only_when_cancelled CHECK (
    refund_amount_minor = 0 OR status = 'CANCELLED'
  ),
  CONSTRAINT chk_bookings_reminder_only_when_confirmed CHECK (
    reminder_sent_at IS NULL OR confirmed_at IS NOT NULL
  )
);

-- Retry protection for hold creation, scoped per customer.
CREATE UNIQUE INDEX uq_bookings_customer_idempotency
  ON public.bookings (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_bookings_customer_created ON public.bookings (customer_id, created_at DESC);
CREATE INDEX idx_bookings_event_status ON public.bookings (event_id, status);
-- Per-user ticket limit lookup: active bookings for (customer, event).
CREATE INDEX idx_bookings_customer_event_active
  ON public.bookings (customer_id, event_id)
  WHERE status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED');
-- Expiry worker scan.
CREATE INDEX idx_bookings_hold_expiry
  ON public.bookings (hold_expires_at)
  WHERE status IN ('HELD', 'PENDING_PAYMENT');
-- Pre-event reminder worker scan.
CREATE INDEX idx_bookings_reminder_pending
  ON public.bookings (event_id)
  WHERE status = 'CONFIRMED' AND reminder_sent_at IS NULL;

CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Database-level mirror of the domain transition map
-- (backend/src/domain/lifecycle/bookingStateMachine.ts). Defense in depth:
-- even a buggy code path cannot perform an illegal transition.
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

  -- Charged amounts and ownership are immutable once the booking exists.
  IF NEW.total_amount_minor <> OLD.total_amount_minor
     OR NEW.customer_id <> OLD.customer_id
     OR NEW.event_id <> OLD.event_id
     OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'booking amount, currency, customer and event are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bookings_status_transition
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_status_transition();

-- --------------------------------------------------------- booking_seats
CREATE TABLE public.booking_seats (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID        NOT NULL,
  event_id    UUID        NOT NULL,
  seat_id     UUID        NOT NULL,
  price_minor BIGINT      NOT NULL,
  seat_state  VARCHAR(10) NOT NULL DEFAULT 'HELD',
  released_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Booking and seat must both belong to this event.
  CONSTRAINT fk_booking_seats_booking_same_event FOREIGN KEY (booking_id, event_id)
    REFERENCES public.bookings (id, event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_booking_seats_seat_same_event FOREIGN KEY (seat_id, event_id)
    REFERENCES public.seats (id, event_id) ON DELETE RESTRICT,
  CONSTRAINT uq_booking_seats_booking_seat UNIQUE (booking_id, seat_id),
  CONSTRAINT chk_booking_seats_price CHECK (price_minor >= 0),
  CONSTRAINT chk_booking_seats_state CHECK (seat_state IN ('HELD', 'BOOKED', 'RELEASED')),
  CONSTRAINT chk_booking_seats_released_at CHECK ((seat_state = 'RELEASED') = (released_at IS NOT NULL))
);

-- THE double-booking guard: at most one active allocation per seat.
CREATE UNIQUE INDEX idx_active_seat_per_event
  ON public.booking_seats (event_id, seat_id)
  WHERE seat_state IN ('HELD', 'BOOKED');
CREATE INDEX idx_booking_seats_booking ON public.booking_seats (booking_id);
CREATE INDEX idx_booking_seats_seat ON public.booking_seats (seat_id);

CREATE TRIGGER trg_booking_seats_updated_at
  BEFORE UPDATE ON public.booking_seats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- HELD -> BOOKED | RELEASED, BOOKED -> RELEASED, RELEASED is terminal.
-- Released rows are kept as history and can never be re-activated, so a freed
-- seat is always re-allocated through a new row (re-checked by the unique index).
CREATE OR REPLACE FUNCTION public.enforce_booking_seat_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.seat_state <> 'HELD' THEN
      RAISE EXCEPTION 'booking seat must be created in HELD state, got %', NEW.seat_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.seat_state IS DISTINCT FROM OLD.seat_state AND NOT (
    (OLD.seat_state = 'HELD' AND NEW.seat_state IN ('BOOKED', 'RELEASED'))
    OR (OLD.seat_state = 'BOOKED' AND NEW.seat_state = 'RELEASED')
  ) THEN
    RAISE EXCEPTION 'invalid seat state transition % -> %', OLD.seat_state, NEW.seat_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.price_minor <> OLD.price_minor
     OR NEW.seat_id <> OLD.seat_id
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.event_id <> OLD.event_id THEN
    RAISE EXCEPTION 'booking seat price, seat, booking and event are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_booking_seats_state_transition
  BEFORE INSERT OR UPDATE ON public.booking_seats
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_seat_state_transition();

-- ------------------------------------------------ booking_status_history
CREATE TABLE public.booking_status_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID        NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  from_status   VARCHAR(20),
  to_status     VARCHAR(20) NOT NULL,
  reason        TEXT,
  actor_user_id UUID        REFERENCES public.users (id) ON DELETE RESTRICT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bsh_from_status CHECK (
    from_status IS NULL
    OR from_status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT chk_bsh_to_status CHECK (
    to_status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT chk_bsh_changes_status CHECK (from_status IS DISTINCT FROM to_status),
  CONSTRAINT chk_bsh_initial_is_held CHECK (from_status IS NOT NULL OR to_status = 'HELD')
);

CREATE INDEX idx_bsh_booking_changed ON public.booking_status_history (booking_id, changed_at);

CREATE TRIGGER trg_bsh_append_only
  BEFORE UPDATE OR DELETE ON public.booking_status_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_mutation();
