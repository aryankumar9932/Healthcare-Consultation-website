ALTER TABLE appointments
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN reminder_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN reminder_1h_sent_at TIMESTAMPTZ,
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN payment_order_id TEXT,
  ADD COLUMN payment_id TEXT;

CREATE UNIQUE INDEX appointments_doctor_slot_uniq
  ON appointments (doctor_id, scheduled_for)
  WHERE doctor_id IS NOT NULL AND status NOT IN ('Rejected', 'Cancelled');

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reviews_doctor_idx ON reviews (doctor_id);
