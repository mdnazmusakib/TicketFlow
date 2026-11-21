-- 0006: lock down the Supabase Data API.
-- See DATABASE_DESIGN.md §7.
--
-- TicketFlow's Express backend is the only client. It connects with a
-- privileged Postgres role (table owner) over a direct/session-pooler
-- connection, so RLS does not apply to it. Browsers never talk to Supabase
-- directly. Enabling RLS with *no* policies therefore denies every row to the
-- `anon` and `authenticated` roles used by Supabase's PostgREST API, and the
-- explicit REVOKEs remove table privileges as a second layer.

DO $$
DECLARE
  t text;
  app_tables text[] := ARRAY[
    'users', 'venues', 'events', 'seat_categories', 'seats',
    'bookings', 'booking_seats', 'booking_status_history',
    'payments', 'refunds', 'payment_webhook_events', 'tickets',
    'notifications', 'idempotency_keys', 'audit_logs'
  ];
  api_role text;
BEGIN
  FOREACH t IN ARRAY app_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH t IN ARRAY app_tables LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, api_role);
      END LOOP;
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.set_updated_at(), public.prevent_mutation(), '
        'public.enforce_booking_status_transition(), '
        'public.enforce_booking_seat_state_transition() FROM %I', api_role);
    END IF;
  END LOOP;
END;
$$;
