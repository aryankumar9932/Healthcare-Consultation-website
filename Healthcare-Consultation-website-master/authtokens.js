// One-time, hashed tokens for email verification and password reset.
// The raw token only ever exists in the email link; the database stores its SHA-256 hash,
// so a database leak does not hand out working reset links.
const crypto = require("crypto");

const PURPOSES = { verifyEmail: "verify_email", resetPassword: "reset_password" };
const TTL_MS = { verify_email: 24 * 3600 * 1000, reset_password: 60 * 60 * 1000 };

function generateToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
const hashToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");
const looksLikeToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

module.exports = { PURPOSES, TTL_MS, generateToken, hashToken, looksLikeToken };
