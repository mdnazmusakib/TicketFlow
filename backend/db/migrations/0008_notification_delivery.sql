-- 0008: notification delivery hardening (Phase 5).
-- See DATABASE_DESIGN.md §4.13 and §5.6.

-- SKIPPED: a queued notification that must no longer be sent (e.g. a reminder
-- whose event already started before delivery succeeded).
ALTER TABLE public.notifications
  DROP CONSTRAINT chk_notifications_delivery_status,
  ADD CONSTRAINT chk_notifications_delivery_status CHECK (
    delivery_status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED')
  );

-- The delivery worker also reclaims PROCESSING rows whose lease expired
-- (worker crashed mid-delivery), so the queue index must cover them.
DROP INDEX IF EXISTS public.idx_notifications_delivery_queue;
CREATE INDEX idx_notifications_delivery_queue
  ON public.notifications (next_attempt_at)
  WHERE delivery_status IN ('PENDING', 'PROCESSING', 'FAILED');

-- Reminder scan: confirmed bookings without a reminder, by event start.
CREATE INDEX idx_events_start_published
  ON public.events (start_at)
  WHERE status = 'PUBLISHED';
