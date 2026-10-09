CREATE TABLE order_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

ALTER TABLE appointments
  ADD COLUMN refund_status TEXT,
  ADD COLUMN refund_id TEXT,
  ADD COLUMN refund_amount INTEGER,
  ADD COLUMN refunded_at TIMESTAMPTZ;
