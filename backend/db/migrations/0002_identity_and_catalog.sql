-- 0002: users, venues, events, seat categories, seats.
-- See DATABASE_DESIGN.md §4.1–§4.5.

-- ---------------------------------------------------------------- users
CREATE TABLE public.users (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(120) NOT NULL,
  email             VARCHAR(254) NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  role              VARCHAR(20)  NOT NULL DEFAULT 'CUSTOMER',
  email_verified    BOOLEAN      NOT NULL DEFAULT false,
  email_verified_at TIMESTAMPTZ,
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_users_role CHECK (role IN ('CUSTOMER', 'ORGANIZER', 'ADMIN')),
  CONSTRAINT chk_users_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT chk_users_email_verified_at CHECK (
    (email_verified = false AND email_verified_at IS NULL)
    OR (email_verified = true AND email_verified_at IS NOT NULL)
  )
);

-- Case-insensitive uniqueness; the application also stores emails lower-cased.
CREATE UNIQUE INDEX uq_users_email_lower ON public.users (lower(email));
CREATE INDEX idx_users_role ON public.users (role);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- --------------------------------------------------------------- venues
CREATE TABLE public.venues (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  name         VARCHAR(200) NOT NULL,
  address      VARCHAR(300) NOT NULL,
  city         VARCHAR(100) NOT NULL,
  country_code CHAR(2)      NOT NULL DEFAULT 'BD',
  timezone     VARCHAR(64)  NOT NULL DEFAULT 'Asia/Dhaka',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_venues_id_organizer UNIQUE (id, organizer_id),
  CONSTRAINT chk_venues_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_venues_city_not_blank CHECK (length(btrim(city)) > 0),
  CONSTRAINT chk_venues_country_code CHECK (country_code ~ '^[A-Z]{2}$')
);

CREATE UNIQUE INDEX uq_venues_organizer_name_city
  ON public.venues (organizer_id, lower(name), lower(city));
CREATE INDEX idx_venues_city_lower ON public.venues (lower(city));

CREATE TRIGGER trg_venues_updated_at
  BEFORE UPDATE ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- --------------------------------------------------------------- events
CREATE TABLE public.events (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id            UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  venue_id                UUID         NOT NULL,
  title                   VARCHAR(200) NOT NULL,
  description             TEXT,
  start_at                TIMESTAMPTZ  NOT NULL,
  end_at                  TIMESTAMPTZ,
  status                  VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  pricing_strategy        VARCHAR(20)  NOT NULL DEFAULT 'BASE',
  early_bird_deadline     TIMESTAMPTZ,
  early_bird_discount_pct SMALLINT,
  currency                CHAR(3)      NOT NULL DEFAULT 'BDT',
  seat_rows               SMALLINT     NOT NULL,
  seats_per_row           SMALLINT     NOT NULL,
  banner_url              TEXT,
  sales_start_at          TIMESTAMPTZ,
  sales_end_at            TIMESTAMPTZ,
  published_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Venue must belong to the same organizer as the event.
  CONSTRAINT fk_events_venue_same_organizer FOREIGN KEY (venue_id, organizer_id)
    REFERENCES public.venues (id, organizer_id) ON DELETE RESTRICT,
  CONSTRAINT chk_events_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_events_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED')),
  CONSTRAINT chk_events_pricing_strategy CHECK (pricing_strategy IN ('BASE', 'EARLY_BIRD')),
  CONSTRAINT chk_events_pricing_fields CHECK (
    (pricing_strategy = 'BASE'
      AND early_bird_deadline IS NULL AND early_bird_discount_pct IS NULL)
    OR (pricing_strategy = 'EARLY_BIRD'
      AND early_bird_deadline IS NOT NULL
      AND early_bird_discount_pct BETWEEN 1 AND 99
      AND early_bird_deadline <= start_at)
  ),
  CONSTRAINT chk_events_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_events_seat_map CHECK (seat_rows BETWEEN 1 AND 52 AND seats_per_row BETWEEN 1 AND 100),
  CONSTRAINT chk_events_end_after_start CHECK (end_at IS NULL OR end_at > start_at),
  CONSTRAINT chk_events_sales_window CHECK (
    (sales_start_at IS NULL OR sales_end_at IS NULL OR sales_start_at < sales_end_at)
    AND (sales_end_at IS NULL OR sales_end_at <= start_at)
  ),
  CONSTRAINT chk_events_published_at CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT chk_events_cancelled_at CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
  )
);

CREATE INDEX idx_events_organizer_start ON public.events (organizer_id, start_at DESC);
CREATE INDEX idx_events_venue ON public.events (venue_id);
CREATE INDEX idx_events_status_start ON public.events (status, start_at);
CREATE INDEX idx_events_title_trgm
  ON public.events USING gin (lower(title) extensions.gin_trgm_ops);

CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------ seat_categories
CREATE TABLE public.seat_categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  name        VARCHAR(60) NOT NULL,
  price_minor BIGINT      NOT NULL,
  sort_order  SMALLINT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_seat_categories_id_event UNIQUE (id, event_id),
  CONSTRAINT chk_seat_categories_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_seat_categories_price CHECK (price_minor >= 0)
);

CREATE UNIQUE INDEX uq_seat_categories_event_name
  ON public.seat_categories (event_id, lower(name));

CREATE TRIGGER trg_seat_categories_updated_at
  BEFORE UPDATE ON public.seat_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------- seats
CREATE TABLE public.seats (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  category_id UUID        NOT NULL,
  row_label   VARCHAR(4)  NOT NULL,
  seat_number SMALLINT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_seats_event_row_number UNIQUE (event_id, row_label, seat_number),
  CONSTRAINT uq_seats_id_event UNIQUE (id, event_id),
  -- Category must belong to the same event as the seat. NO ACTION (deferred to end of
  -- statement) lets an event-level cascade remove categories and seats together.
  CONSTRAINT fk_seats_category_same_event FOREIGN KEY (category_id, event_id)
    REFERENCES public.seat_categories (id, event_id) ON DELETE NO ACTION,
  CONSTRAINT chk_seats_row_label CHECK (row_label ~ '^[A-Z]{1,2}$'),
  CONSTRAINT chk_seats_number CHECK (seat_number >= 1)
);

CREATE INDEX idx_seats_category ON public.seats (category_id);
