-- Varausjärjestelmä – D1 schema

CREATE TABLE IF NOT EXISTS businesses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  owner_name    TEXT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  phone         TEXT,
  address       TEXT,
  description   TEXT,
  business_id   TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  duration_min  INTEGER NOT NULL,
  price_cents   INTEGER,
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  category      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Viikoittainen aukioloaika (day_of_week: 0=Su, 1=Ma ... 6=La)
CREATE TABLE IF NOT EXISTS availability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day_of_week   INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  UNIQUE(business_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id      INTEGER NOT NULL REFERENCES services(id),
  date            TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bookings_biz_date ON bookings(business_id, date);
CREATE INDEX IF NOT EXISTS idx_services_biz ON services(business_id);
CREATE INDEX IF NOT EXISTS idx_availability_biz ON availability(business_id);
