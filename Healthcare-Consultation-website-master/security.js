// Security middleware: HTTP headers/CSP, rate limiting, CSRF protection, login lockout settings.
const crypto = require("crypto");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const isProd = () => process.env.NODE_ENV === "production";
const intEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function defaultLimits() {
  return {
    api:     { windowMs: 15 * 60 * 1000, limit: intEnv("RATE_LIMIT_API", 600) },   // all /api traffic per IP
    auth:    { windowMs: 15 * 60 * 1000, limit: intEnv("RATE_LIMIT_AUTH", 20) },   // login + register per IP
    ai:      { windowMs: 60 * 60 * 1000, limit: intEnv("RATE_LIMIT_AI", 60) },     // paid AI endpoints per IP
    lockout: { maxFailures: intEnv("LOGIN_MAX_FAILURES", 5), lockMs: intEnv("LOGIN_LOCK_MINUTES", 15) * 60 * 1000 }
  };
}

function limiter({ windowMs, limit }, message) {
  return rateLimit({
    windowMs, limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: message }
  });
}

function applySecurityHeaders(app) {
  if (process.env.TRUST_PROXY) {
    // e.g. TRUST_PROXY=1 behind one load balancer; needed for correct client IPs and Secure cookies.
    const v = process.env.TRUST_PROXY;
    app.set("trust proxy", /^\d+$/.test(v) ? Number(v) : v === "true" ? true : v);
  }
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://unpkg.com"],
        "style-src": ["'self'", "https://unpkg.com"],
        "img-src": ["'self'", "data:", "blob:", "https://unpkg.com", "https://*.tile.openstreetmap.org"],
        "connect-src": ["'self'"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        ...(isProd() ? { "upgrade-insecure-requests": [] } : {})
      }
    },
    crossOriginEmbedderPolicy: false, // third-party map tiles do not send CORP headers
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: isProd() ? { maxAge: 15552000, includeSubDomains: true } : false
  }));
  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), payment=(), geolocation=(self)");
    next();
  });
}

// Synchroniser-token CSRF protection bound to the server-side session.
function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const supplied = String(req.get("x-csrf-token") || "");
  const ok = expected && supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!ok) return res.status(403).json({ error: "Your session security token is missing or expired. Please retry.", code: "CSRF" });
  next();
}

module.exports = { applySecurityHeaders, csrfToken, csrfProtection, defaultLimits, limiter };
