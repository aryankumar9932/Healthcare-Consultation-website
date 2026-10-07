-- CareConnect initial schema
CREATE TABLE departments (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE doctors (
  id            SERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name          TEXT NOT NULL,
  specialty     TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  fee           INTEGER NOT NULL CHECK (fee >= 0),
  image         TEXT NOT NULL DEFAULT '',
  schedule      JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX doctors_department_idx ON doctors(department_id);

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  image       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'patient' CHECK (role IN ('patient', 'doctor', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE clinics (
  id          SERIAL PRIMARY KEY,
  doctor_id   INTEGER NOT NULL REFERENCES doctors(id),
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clinics_doctor_idx ON clinics(doctor_id);
CREATE INDEX clinics_address_idx ON clinics (lower(address));

CREATE TABLE appointments (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id        INTEGER REFERENCES doctors(id),
  provider_name    TEXT,
  provider_address TEXT,
  provider_source  TEXT,
  scheduled_for    TIMESTAMPTZ NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (doctor_id IS NOT NULL OR provider_name IS NOT NULL)
);
CREATE INDEX appointments_user_idx ON appointments(user_id, created_at);
CREATE INDEX appointments_doctor_time_idx ON appointments(doctor_id, scheduled_for);

CREATE TABLE orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total      NUMERIC(12,2) NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at);

CREATE TABLE order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name       TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  price      NUMERIC(10,2) NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

-- Account lockout state (shared across app instances)
CREATE TABLE login_attempts (
  email        TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side sessions (connect-pg-simple)
CREATE TABLE session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session(expire);
