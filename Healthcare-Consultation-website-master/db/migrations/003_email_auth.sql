-- Email verification, password reset, and per-user session revocation

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

-- One-time tokens. Only the SHA-256 hash of the token is stored.
CREATE TABLE auth_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

-- Lets us sign a user out everywhere (after a password reset/change) without scanning every session.
CREATE INDEX session_user_idx ON session ((sess->>'userId'));
