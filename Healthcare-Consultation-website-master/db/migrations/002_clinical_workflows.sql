ALTER TABLE users ADD COLUMN doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN date_of_birth DATE;
CREATE UNIQUE INDEX users_doctor_account_idx ON users(doctor_id) WHERE doctor_id IS NOT NULL;

ALTER TABLE appointments ADD COLUMN symptoms TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN consultation_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN completed_at TIMESTAMPTZ;

CREATE TABLE prescriptions (
  id              SERIAL PRIMARY KEY,
  appointment_id  INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_user_id  INTEGER NOT NULL REFERENCES users(id),
  encrypted_data  BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_patient_idx ON prescriptions(patient_id, created_at);

CREATE TABLE medical_reports (
  id              SERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uploaded_by     INTEGER NOT NULL REFERENCES users(id),
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  encrypted_data  BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX medical_reports_patient_idx ON medical_reports(patient_id, created_at);
