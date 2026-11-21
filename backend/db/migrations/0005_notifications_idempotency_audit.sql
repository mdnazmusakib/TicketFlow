-- 0005: notifications (inbox + delivery queue), idempotency records, audit log.
-- See DATABASE_DESIGN.md §4.13–§4.15.

-- --------------------------------------------------------- notifications
CREATE TABLE public.notifications (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  booking_id       UUID         REFERENCES public.bookings (id) ON DELETE SET NULL,
  channel          VARCHAR(20)  NOT NULL,
  type             VARCHAR(40)  NOT NULL,
  title            VARCHAR(200) NOT NULL,
  message          TEXT         NOT NULL,
  -- e.g. 'BOOKING_CONFIRMED:<booking_id>:EMAIL' — makes dispatch idempotent.
  dedupe_key       VARCHAR(255) NOT NULL,
  delivery_status  VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  attempts         SMALLINT     NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  is_read          BOOLEAN      NOT NULL DEFAULT false,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT chk_notifications_channel CHECK (channel IN ('EMAIL', 'IN_APP')),
  CONSTRAINT chk_notifications_type CHECK (
    type IN ('BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'EVENT_REMINDER_1H')
  ),
  CONSTRAINT chk_notifications_delivery_status CHECK (
    delivery_status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')
  ),
  CONSTRAINT chk_notifications_attempts CHECK (attempts >= 0),
  CONSTRAINT chk_notifications_sent_at CHECK ((delivery_status = 'SENT') = (sent_at IS NOT NULL)),
  CONSTRAINT chk_notifications_read CHECK (
    (is_read = false AND read_at IS NULL) OR (is_read = true AND read_at IS NOT NULL)
  ),
  CONSTRAINT chk_notifications_read_in_app_only CHECK (is_read = false OR channel = 'IN_APP')
);

CREATE INDEX idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC)
  WHERE channel = 'IN_APP';
CREATE INDEX idx_notifications_user_unread
  ON public.notifications (user_id, created_at DESC)
  WHERE channel = 'IN_APP' AND is_read = false;
-- Delivery worker claim scan (FOR UPDATE SKIP LOCKED).
CREATE INDEX idx_notifications_delivery_queue
  ON public.notifications (next_attempt_at)
  WHERE delivery_status IN ('PENDING', 'FAILED');
CREATE INDEX idx_notifications_booking ON public.notifications (booking_id);

-- ------------------------------------------------------ idempotency_keys
CREATE TABLE public.idempotency_keys (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  endpoint        VARCHAR(200) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  -- SHA-256 of the canonical request body: same key + different body => 422.
  request_hash    CHAR(64)     NOT NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'IN_PROGRESS',
  response_status SMALLINT,
  response_body   JSONB,
  locked_until    TIMESTAMPTZ  NOT NULL,
  expires_at      TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_idempotency_scope UNIQUE (user_id, endpoint, idempotency_key),
  CONSTRAINT chk_idempotency_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  CONSTRAINT chk_idempotency_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_idempotency_completed CHECK (
    status <> 'COMPLETED' OR response_status IS NOT NULL
  ),
  CONSTRAINT chk_idempotency_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_idempotency_expires ON public.idempotency_keys (expires_at);

CREATE TRIGGER trg_idempotency_keys_updated_at
  BEFORE UPDATE ON public.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------ audit_logs
CREATE TABLE public.audit_logs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  action        VARCHAR(100) NOT NULL,
  entity_type   VARCHAR(50)  NOT NULL,
  entity_id     UUID,
  -- Redacted context only: never passwords, tokens, OTPs or card data.
  metadata      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip_address    INET,
  request_id    VARCHAR(100),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON public.audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON public.audit_logs (actor_user_id, created_at DESC);

CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_mutation();
