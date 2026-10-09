const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const PDFDocument = require("pdfkit");
const { analyzeDocument, chatWithHealthAssistant, predictNoShow, readPrescription, recommendSpecialty } = require("./ml");
const { normalizeOpenStreetMapElement } = require("./public/geo");
const mlService = require("./ml-client");
const { createStore } = require("./db");
const { applySecurityHeaders, csrfToken, csrfProtection, defaultLimits, limiter } = require("./security");
const { createMailer, templates } = require("./mailer");
const { PURPOSES, TTL_MS, generateToken, hashToken, looksLikeToken } = require("./authtokens");
const { encryptionKey, encryptClinicalData, decryptClinicalData, extractReportMeasurements, extractReportHistory } = require("./clinical");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dbFile = process.env.DB_FILE || path.join(dataDir, "db.json");
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const clinicalEncryptionKey = encryptionKey(process.env.REPORT_ENCRYPTION_KEY || sessionSecret);

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}
if (process.env.NODE_ENV === "production" && !process.env.APP_URL) {
  throw new Error("APP_URL (for example https://care.example.com) must be set in production: it is used for links in emails.");
}
// Links in emails are built from this fixed value, never from the request's Host header (prevents poisoned reset links).
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const mailer = createMailer();
// Email confirmation is enforced when emails can actually be delivered (or when REQUIRE_VERIFIED_EMAIL=true).
const verificationRequired = () => process.env.REQUIRE_VERIFIED_EMAIL
  ? process.env.REQUIRE_VERIFIED_EMAIL === "true"
  : mailer.canDeliver;

const store = createStore({ dbFile });
const ready = store.init();
ready.catch(() => {}); // surfaced by the readiness middleware / start-up handler

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || !/^[a-f\d]{128}$/i.test(hash)) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

// Used to spend the same time on unknown accounts as on real ones (prevents user enumeration by timing).
const DUMMY_HASH = hashPassword("not-a-real-password");

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function sessionUser(user) {
  return { ...publicUser(user), emailVerified: Boolean(user.emailVerifiedAt), emailVerificationRequired: verificationRequired(), isAdmin: isAdmin(user), canBootstrapAdmin: canBootstrapAdmin(user) };
}

function validBootstrapToken(value) {
  const expected = process.env.ADMIN_SETUP_TOKEN || "";
  const supplied = String(value || "");
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

// Wrap async route handlers so rejected promises reach the error middleware.
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const requireUser = wrap(async (req, res, next) => {
  const userId = Number(req.session && req.session.userId);
  const user = Number.isSafeInteger(userId) ? await store.getUserById(userId) : null;
  if (!user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  next();
});

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) > Date.now();
}

const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || "Asia/Kolkata";
const SLOT_RE = /^\s*([A-Za-z]+)\s+(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*$/;

function clinicLocalParts(isoDate) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TIMEZONE, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(isoDate));
  const get = type => parts.find(part => part.type === type).value;
  return { weekday: get("weekday").toLowerCase(), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function withinDoctorSchedule(doctor, isoDate) {
  const slots = (Array.isArray(doctor.schedule) ? doctor.schedule : []).map(slot => SLOT_RE.exec(slot)).filter(Boolean);
  if (!slots.length) return true;
  const { weekday, minutes } = clinicLocalParts(isoDate);
  return slots.some(match => match[1].toLowerCase() === weekday &&
    minutes >= Number(match[2]) * 60 + Number(match[3]) && minutes < Number(match[4]) * 60 + Number(match[5]));
}

const isActive = appointment => !["Rejected", "Cancelled"].includes(appointment.status);
const clinicDayKey = iso => new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TIMEZONE }).format(new Date(iso));
const parseId = value => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
const CHANGEABLE = ["Pending", "Accepted", "Request saved · unconfirmed"];
const MIN_NOTICE_MS = 2 * 60 * 60 * 1000;

async function checkBookable({ doctor, date, userId, ignoreAppointmentId = null }) {
  if (!doctor) return null;
  if (!withinDoctorSchedule(doctor, date)) return { status: 400, error: "This doctor is not available at that day or time. Please choose a time within their listed schedule." };
  const slotTime = Date.parse(date);
  const counts = appointment => appointment.id !== ignoreAppointmentId && isActive(appointment);
  if ((await store.listAppointmentsForDoctor(doctor.id)).some(appointment => counts(appointment) && Date.parse(appointment.date) === slotTime)) {
    return { status: 409, error: "That time slot is already booked. Please choose another time." };
  }
  if ((await store.listAppointmentsForUser(userId)).some(appointment => appointment.doctorId === doctor.id && counts(appointment) && clinicDayKey(appointment.date) === clinicDayKey(date))) {
    return { status: 409, error: "You already have an appointment with this doctor on that day." };
  }
  return null;
}

const SLOT_MINUTES = 30;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const pad2 = value => String(value).padStart(2, "0");
function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = type => Number(parts.find(part => part.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(utcMs / 1000) * 1000;
}
function clinicLocalToUtcMs(dateStr, minutes) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day) + minutes * 60000;
  return guess - tzOffsetMs(guess);
}

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const PAYMENT_CURRENCY = process.env.PAYMENT_CURRENCY || "INR";
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function startReminderJob({ intervalMs = 5 * 60 * 1000 } = {}) {
  const HOUR = 3600000;
  const kinds = [{ key: "24h", min: HOUR, max: 24 * HOUR }, { key: "1h", min: 0, max: HOUR }];
  async function tick() {
    const now = Date.now();
    for (const kind of kinds) {
      const due = await store.listAppointmentsNeedingReminder(kind.key, new Date(now + kind.min).toISOString(), new Date(now + kind.max).toISOString());
      for (const appointment of due) {
        const user = await store.getUserById(appointment.userId);
        if (!user?.email || mailer.mode === "disabled" || !(await store.markReminderSent(appointment.id, kind.key))) continue;
        const doctor = appointment.doctorId ? await store.getDoctor(appointment.doctorId) : null;
        const when = new Date(appointment.date).toLocaleString("en-IN", { timeZone: CLINIC_TIMEZONE, dateStyle: "full", timeStyle: "short" });
        await mailer.send({ to: user.email, subject: "Appointment reminder", text: `Hello ${user.name},\n\nThis is a reminder of your appointment${doctor ? ` with ${doctor.name}` : ""} on ${when} (${CLINIC_TIMEZONE}).\n\nYou can cancel or reschedule from your CareConnect appointments page.` })
          .catch(error => console.error("Reminder email failed:", error.message));
      }
    }
  }
  const run = () => tick().catch(error => console.error("Reminder job failed:", error.message));
  const timer = setInterval(run, intervalMs);
  const first = setTimeout(run, 10 * 1000); // also check shortly after startup
  timer.unref();
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}

async function notify(userId, type, message, link = "/appointments") {
  if (!userId) return;
  try { await store.createNotification({ userId, type, message: String(message).slice(0, 300), link }); }
  catch (error) { console.error("Notification failed:", error.message); }
}

function isAdmin(user) {
  return user.role === "admin";
}

const requireDoctor = wrap(async (req, res, next) => {
  if (req.user.role !== "doctor" || !Number.isSafeInteger(Number(req.user.doctorId))) {
    return res.status(403).json({ error: "Verified doctor access is required." });
  }
  const doctor = await store.getDoctorByUserId(req.user.id);
  if (!doctor) return res.status(403).json({ error: "This doctor account is not linked to an active directory profile." });
  req.doctor = doctor;
  next();
});

const requirePatient = (req, res, next) => {
  if (req.user.role !== "patient" && req.user.role !== undefined) {
    return res.status(403).json({ error: "Patient access is required." });
  }
  next();
};

function canBootstrapAdmin(user) {
  return Boolean(
    process.env.ADMIN_EMAIL &&
    process.env.ADMIN_SETUP_TOKEN &&
    process.env.ADMIN_SETUP_TOKEN.length >= 32 &&
    user.email.toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase() &&
    !isAdmin(user)
  );
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Administrator access is required." });
  next();
}

// Replace the session id after a privilege change (prevents session fixation).
// The session is saved to the store *before* the response is sent: express-session otherwise starts
// sending the response while the (PostgreSQL) write is still in flight, so a fast follow-up request
// could arrive before the new session exists.
const startSession = (req, userId) => new Promise((resolve, reject) => {
  req.session.regenerate(error => {
    if (error) return reject(error);
    req.session.userId = userId;
    req.session.save(saveError => (saveError ? reject(saveError) : resolve()));
  });
});

const requireVerifiedEmail = (req, res, next) => {
  if (!verificationRequired() || req.user.emailVerifiedAt) return next();
  res.status(403).json({
    error: "Please confirm your email address first. Check your inbox for the confirmation link, or request a new one.",
    code: "EMAIL_NOT_VERIFIED"
  });
};

// Emails are sent after the response, so delivery problems never break sign-up or leak whether an account exists.
const background = task => Promise.resolve(task).catch(error => console.error("Email delivery failed:", error.code || error.message));

async function sendVerificationEmail(user) {
  const { token, hash } = generateToken();
  await store.createAuthToken({ userId: user.id, purpose: PURPOSES.verifyEmail, hash, expiresAt: Date.now() + TTL_MS.verify_email });
  await mailer.send({ to: user.email, ...templates.verifyEmail({ name: user.name, url: `${appUrl}/verify-email?token=${token}`, hours: TTL_MS.verify_email / 3600000 }) });
}
async function sendPasswordResetEmail(user) {
  const { token, hash } = generateToken();
  await store.createAuthToken({ userId: user.id, purpose: PURPOSES.resetPassword, hash, expiresAt: Date.now() + TTL_MS.reset_password });
  await mailer.send({ to: user.email, ...templates.resetPassword({ name: user.name, url: `${appUrl}/reset-password?token=${token}`, minutes: TTL_MS.reset_password / 60000 }) });
}
const validPassword = value => typeof value === "string" && value.length >= 8 && value.length <= 128;

let lastGeocodeAt = 0;
async function searchOpenStreetMapAddress(address) {
  const delay = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  lastGeocodeAt = Date.now();

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": `CareConnect/1.0 (${process.env.OSM_CONTACT_EMAIL || "local healthcare directory"})` },
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    const error = new Error("OpenStreetMap address search is unavailable. Try again later.");
    error.status = 503;
    error.expose = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`OpenStreetMap address search returned HTTP ${response.status}.`);
    error.status = 503;
    error.expose = true;
    throw error;
  }
  const results = await response.json();
  const latitude = Number(results[0]?.lat);
  const longitude = Number(results[0]?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const error = new Error("That place could not be found. Try a town, city, or full address.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return {
    latitude,
    longitude,
    label: String(results[0].display_name || address).slice(0, 300)
  };
}

async function geocodeClinicAddress(address, excludeId) {
  const existing = await store.findClinicByAddress(address, excludeId);
  if (existing) return { latitude: existing.latitude, longitude: existing.longitude };
  const { latitude, longitude } = await searchOpenStreetMapAddress(address);
  return { latitude, longitude };
}

function publicClinic(clinic) {
  return { ...clinic, doctor: publicUser(clinic.doctor) };
}

function validDateOfBirth(value) {
  if (!value) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  const age = (Date.now() - date.getTime()) / 31557600000;
  return date.toISOString().slice(0, 10) === value && age >= 0 && age <= 125;
}

function createApp(options = {}) {
  const limits = { ...defaultLimits(), resendCooldownMs: 60 * 1000, ...(options.limits || {}) };
  const app = express();
  const activeVideoCalls = new Map();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4 } });
  app.disable("x-powered-by");
  applySecurityHeaders(app);
  app.post("/api/webhooks/razorpay", express.raw({ type: "application/json", limit: "64kb" }), wrap(async (req, res) => {
    await ready;
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.sendStatus(503);
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
    const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
    if (!safeEqual(expected, req.get("x-razorpay-signature") || "")) return res.sendStatus(400);
    let event;
    try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (payment?.order_id && payment?.id) await store.markPaid(payment.order_id, String(payment.id));
    }
    res.sendStatus(200);
  }));
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, res, next) => ready.then(() => next(), next)); // wait for DB migrations on first requests
  app.use(session({
    name: "careconnect.sid",
    secret: sessionSecret,
    store: store.sessionStore(session),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  }));

  const apiLimiter = limiter(limits.api, "Too many requests. Please slow down and try again later.");
  const authLimiter = limiter(limits.auth, "Too many sign-in attempts from this network. Try again later.");
  const aiLimiter = limiter(limits.ai, "AI request limit reached. Please try again later.");
  app.use("/api", apiLimiter);
  app.use("/api/login", authLimiter);
  app.use("/api/register", authLimiter);
  app.use("/api/ml", aiLimiter);
  app.use("/api/password", limiter(limits.reset, "Too many password requests from this network. Try again later."));
  app.use("/api/email", limiter(limits.email, "Too many email requests from this network. Try again later."));
  app.use("/api", csrfProtection);

  app.get("/api/csrf", (req, res) => res.json({ csrfToken: csrfToken(req) }));
  app.get("/api/health", wrap(async (req, res) => {
    await ready;
    res.json({ ok: true, mlRuntime: "gemini", database: store.driver });
  }));
  app.get("/api/me", wrap(async (req, res) => {
    const userId = Number(req.session && req.session.userId);
    const user = Number.isSafeInteger(userId) ? await store.getUserById(userId) : null;
    res.json({ user: user ? sessionUser(user) : null });
  }));
  app.get("/api/notifications", requireUser, wrap(async (req, res) => {
    res.json(await store.listNotifications(req.user.id));
  }));
  app.post("/api/notifications/read", requireUser, wrap(async (req, res) => {
    const raw = (req.body || {}).id;
    const id = raw === undefined || raw === null ? null : parseId(raw);
    if (raw !== undefined && raw !== null && !id) return res.status(400).json({ error: "Invalid notification." });
    res.json({ marked: await store.markNotificationsRead(req.user.id, id) });
  }));
  app.get("/api/departments", wrap(async (req, res) => res.json(await store.listDepartments())));
  app.get("/api/doctors", wrap(async (req, res) => {
    const departmentId = Number(req.query.departmentId);
    res.json(await store.listDoctors(departmentId || undefined));
  }));
  app.get("/api/doctors/ratings", wrap(async (req, res) => res.json(await store.doctorRatings())));
  app.get("/api/doctors/:id/reviews", wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid doctor." });
    res.json(await store.listReviewsForDoctor(id));
  }));
  app.get("/api/doctors/:id/slots", wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const doctor = id ? await store.getDoctor(id) : null;
    const dateStr = String(req.query.date || "");
    const probe = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T00:00:00Z`) : null;
    if (!doctor || !probe || Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== dateStr) return res.status(400).json({ error: "Choose a listed doctor and a valid date (YYYY-MM-DD)." });
    const weekday = WEEKDAYS[probe.getUTCDay()];
    const ranges = (doctor.schedule || []).map(schedule => SLOT_RE.exec(schedule)).filter(Boolean)
      .filter(match => match[1].toLowerCase() === weekday)
      .map(match => [Number(match[2]) * 60 + Number(match[3]), Number(match[4]) * 60 + Number(match[5])]);
    const taken = new Set((await store.listAppointmentsForDoctor(doctor.id)).filter(isActive).map(appointment => Date.parse(appointment.date)));
    const slots = [];
    for (const [start, end] of ranges) for (let minute = start; minute + SLOT_MINUTES <= end; minute += SLOT_MINUTES) {
      const ms = clinicLocalToUtcMs(dateStr, minute);
      if (ms > Date.now() && !taken.has(ms)) slots.push({ start: new Date(ms).toISOString(), label: `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}` });
    }
    res.json({ date: dateStr, timezone: CLINIC_TIMEZONE, slots });
  }));
  app.get("/api/products", wrap(async (req, res) => res.json(await store.listProducts())));
  app.get("/api/clinics", wrap(async (req, res) => {
    res.json((await store.listClinics({ verifiedOnly: true })).map(publicClinic));
  }));
  app.post("/api/location/geocode", requireUser, wrap(async (req, res) => {
    const query = String((req.body || {}).query || "").trim();
    if (query.length < 3 || query.length > 200) {
      return res.status(400).json({ error: "Enter a place name or address between 3 and 200 characters." });
    }
    res.json(await searchOpenStreetMapAddress(query));
  }));
  app.post("/api/nearby", requireUser, async (req, res, next) => {
    const latitude = Number((req.body || {}).latitude);
    const longitude = Number((req.body || {}).longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: "A valid latitude and longitude are required." });
    }
    const radius = 50000;
    const query = `[out:json][timeout:20];(nwr["amenity"="pharmacy"](around:${radius},${latitude},${longitude});nwr["healthcare"="pharmacy"](around:${radius},${latitude},${longitude});nwr["shop"="chemist"](around:${radius},${latitude},${longitude});)->.pharmacies;(nwr["amenity"~"^(doctors|clinic|hospital|dentist)$"](around:${radius},${latitude},${longitude});nwr["healthcare"~"^(doctor|clinic|hospital|dentist|medical_centre)$"](around:${radius},${latitude},${longitude});)->.healthcare;.pharmacies out center tags 100;.healthcare out center tags 80;`;
    try {
      const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "CareConnect/1.0 (nearby healthcare directory)"
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(25000)
      });

      if (!response.ok) {
        const error = new Error(`OpenStreetMap nearby search returned HTTP ${response.status}. Please try again later.`);
        error.status = 503;
        error.expose = true;
        throw error;
      }
      const result = await response.json();
      if (!Array.isArray(result.elements)) throw new Error("OpenStreetMap returned an invalid nearby search response.");
      res.json(result.elements.map(normalizeOpenStreetMapElement).filter(Boolean));
    } catch (cause) {
      if (cause.expose) return next(cause);
      const error = new Error(cause.name === "AbortError" || cause.name === "TimeoutError"
        ? "OpenStreetMap nearby search timed out. Wait a moment and try again."
        : "OpenStreetMap nearby search is unavailable. Please try again later.");
      error.status = 503;
      error.expose = true;
      next(error);
    }
  });

  app.post("/api/register", wrap(async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const dateOfBirth = String(body.dateOfBirth || "");
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128 ||
        !validDateOfBirth(dateOfBirth)) {
      return res.status(400).json({ error: "Enter a valid name and email, and a password of at least 8 characters." });
    }
    const user = await store.createUser({
      name, email, phone: String(body.phone || "").trim().slice(0, 40), password: hashPassword(password),
      dateOfBirth: dateOfBirth || undefined
    });
    if (!user) return res.status(409).json({ error: "An account with that email already exists." });
    await startSession(req, user.id);
    res.status(201).json({ user: sessionUser(user) });
    background(sendVerificationEmail(user));
  }));

  app.post("/api/login", wrap(async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    const password = String(body.password || "").slice(0, 128);
    const lock = await store.getLoginLock(email);
    if (lock.locked) {
      const minutes = Math.max(1, Math.ceil((new Date(lock.until) - Date.now()) / 60000));
      res.setHeader("Retry-After", String(minutes * 60));
      return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
    }
    const user = await store.getUserByEmail(email);
    const valid = verifyPassword(password, user ? user.password : DUMMY_HASH) && Boolean(user);
    if (!valid) {
      await store.recordLoginFailure(email, limits.lockout);
      return res.status(401).json({ error: "Invalid email or password." });
    }
    await store.clearLoginFailures(email);
    await startSession(req, user.id);
    res.json({ user: sessionUser(user) });
  }));

  app.post("/api/logout", (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie("careconnect.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production"
      });
      res.status(204).end();
    });
  });

  // ---- Email confirmation ----
  app.post("/api/email/verify", wrap(async (req, res) => {
    const token = (req.body || {}).token;
    const spent = looksLikeToken(token) ? await store.consumeAuthToken(hashToken(token), PURPOSES.verifyEmail) : null;
    if (!spent) return res.status(400).json({ error: "This confirmation link is invalid or has expired. Sign in and request a new one." });
    await store.markEmailVerified(spent.userId);
    res.json({ verified: true });
  }));
  app.post("/api/email/verify/resend", requireUser, wrap(async (req, res) => {
    if (req.user.emailVerifiedAt) return res.json({ alreadyVerified: true });
    if (!mailer.canDeliver) return res.status(503).json({ error: "Email delivery is not configured on this server." });
    const last = await store.lastAuthTokenIssuedAt(req.user.id, PURPOSES.verifyEmail);
    const wait = last ? limits.resendCooldownMs - (Date.now() - last.getTime()) : 0;
    if (wait > 0) {
      res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another email.` });
    }
    await sendVerificationEmail(req.user);
    res.status(202).json({ sent: true });
  }));

  // ---- Password reset and change ----
  app.post("/api/password/forgot", wrap(async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase().slice(0, 254);
    const user = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? await store.getUserByEmail(email) : null;
    if (user) {
      const last = await store.lastAuthTokenIssuedAt(user.id, PURPOSES.resetPassword);
      if (!last || Date.now() - last.getTime() >= limits.resendCooldownMs) background(sendPasswordResetEmail(user));
    }
    // Same answer whether or not the account exists (no account enumeration).
    res.status(202).json({ message: "If an account exists for that email, we have sent a link to reset the password." });
  }));
  app.post("/api/password/reset", wrap(async (req, res) => {
    const { token, password } = req.body || {};
    if (!validPassword(password)) return res.status(400).json({ error: "Choose a password of 8 to 128 characters." }); // checked first so a typo does not burn the link
    const spent = looksLikeToken(token) ? await store.consumeAuthToken(hashToken(token), PURPOSES.resetPassword) : null;
    if (!spent) return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
    const user = await store.setUserPassword(spent.userId, hashPassword(password));
    await store.markEmailVerified(user.id); // receiving the link proves control of the mailbox
    await store.revokeAuthTokens(user.id, PURPOSES.resetPassword);
    await store.clearLoginFailures(user.email.toLowerCase());
    await store.destroyUserSessions(user.id); // sign out everywhere, including anyone who had the old password
    background(mailer.send({ to: user.email, ...templates.passwordChanged({ name: user.name }) }));
    res.json({ ok: true });
  }));
  app.post("/api/password/change", requireUser, wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!validPassword(newPassword) || typeof currentPassword !== "string") {
      return res.status(400).json({ error: "Enter your current password and a new password of 8 to 128 characters." });
    }
    if (newPassword === currentPassword) return res.status(400).json({ error: "Choose a password different from the current one." });
    const key = req.user.email.toLowerCase();
    const lock = await store.getLoginLock(key); // a stolen session must not be able to brute-force the password
    if (lock.locked) return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    if (!verifyPassword(currentPassword.slice(0, 128), req.user.password)) {
      await store.recordLoginFailure(key, limits.lockout);
      return res.status(401).json({ error: "Your current password is incorrect." });
    }
    await store.clearLoginFailures(key);
    await store.setUserPassword(req.user.id, hashPassword(newPassword));
    await store.destroyUserSessions(req.user.id, req.sessionID); // other devices are signed out
    background(mailer.send({ to: req.user.email, ...templates.passwordChanged({ name: req.user.name }) }));
    res.json({ ok: true });
  }));

  app.post("/api/admin/bootstrap", requireUser, wrap(async (req, res) => {
    if (isAdmin(req.user)) return res.status(409).json({ error: "This account is already an administrator." });
    if (!canBootstrapAdmin(req.user) || !validBootstrapToken((req.body || {}).setupToken)) {
      return res.status(403).json({ error: "Administrator setup is unavailable or the setup token is invalid." });
    }
    const user = await store.setUserRole(req.user.id, "admin");
    res.json({ user: sessionUser(user) });
  }));

  app.get("/api/admin/doctors/unassigned", requireUser, requireAdmin, wrap(async (req, res) => {
    res.json(await store.listDoctorsWithoutAccount());
  }));
  app.post("/api/admin/doctor-accounts", requireUser, requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const doctorId = Number(body.doctorId);
    const doctor = Number.isSafeInteger(doctorId) ? await store.getDoctor(doctorId) : null;
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!doctor || name.length < 2 || name.length > 100 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: "Choose a directory doctor and provide a valid email, name, and temporary password of at least 12 characters." });
    }
    const user = await store.createDoctorUser({
      name, email, phone: String(body.phone || "").trim().slice(0, 40),
      password: hashPassword(password), doctorId
    });
    if (!user) return res.status(409).json({ error: "That email or doctor profile already has an account." });
    res.status(201).json({ user: sessionUser(user), doctor });
    background(sendVerificationEmail(user));
  }));
  app.get("/api/admin/analytics", requireUser, requireAdmin, wrap(async (req, res) => {
    res.json(await store.adminAnalytics());
  }));

  app.get("/api/admin/clinics", requireUser, requireAdmin, wrap(async (req, res) => {
    res.json((await store.listClinics()).map(publicClinic));
  }));

  app.post("/api/admin/clinics", requireUser, requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const doctorId = Number(body.doctorId);
    const doctor = Number.isSafeInteger(doctorId) && doctorId > 0 ? await store.getDoctor(doctorId) : null;
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    if (!doctor || name.length < 2 || name.length > 120 || address.length < 8 || address.length > 300) {
      return res.status(400).json({ error: "Choose a doctor and enter the clinic name and full address." });
    }
    const coordinates = await geocodeClinicAddress(address);
    const clinic = await store.createClinic({ doctorId: doctor.id, name, address, ...coordinates });
    res.status(201).json(publicClinic(clinic));
  }));

  app.put("/api/admin/clinics/:id", requireUser, requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const clinicId = Number(req.params.id);
    const clinic = Number.isSafeInteger(clinicId) ? await store.getClinic(clinicId) : null;
    const doctorId = Number(body.doctorId);
    const doctor = Number.isSafeInteger(doctorId) && doctorId > 0 ? await store.getDoctor(doctorId) : null;
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    if (!clinic) return res.status(404).json({ error: "Clinic not found." });
    if (!doctor || name.length < 2 || name.length > 120 || address.length < 8 || address.length > 300) {
      return res.status(400).json({ error: "Choose a doctor and enter the clinic name and full address." });
    }
    const addressChanged = address.toLowerCase() !== clinic.address.toLowerCase();
    const coordinates = !addressChanged
      ? { latitude: clinic.latitude, longitude: clinic.longitude }
      : await geocodeClinicAddress(address, clinic.id);
    const updated = await store.updateClinic(clinic.id, {
      doctorId: doctor.id, name, address, ...coordinates, verified: addressChanged ? false : clinic.verified
    });
    res.json(publicClinic(updated));
  }));

  app.post("/api/admin/clinics/:id/verify", requireUser, requireAdmin, wrap(async (req, res) => {
    const clinicId = Number(req.params.id);
    const clinic = Number.isSafeInteger(clinicId) ? await store.verifyClinic(clinicId) : null;
    if (!clinic) return res.status(404).json({ error: "Clinic not found." });
    res.json(publicClinic(clinic));
  }));

  app.delete("/api/admin/clinics/:id", requireUser, requireAdmin, wrap(async (req, res) => {
    const clinicId = Number(req.params.id);
    if (!Number.isSafeInteger(clinicId) || !(await store.deleteClinic(clinicId))) {
      return res.status(404).json({ error: "Clinic not found." });
    }
    res.status(204).end();
  }));

  app.get("/api/appointments", requireUser, requirePatient, wrap(async (req, res) => {
    const [appointments, reviewed] = await Promise.all([store.listAppointmentsForUser(req.user.id), store.reviewedAppointmentIds(req.user.id)]);
    res.json(appointments.map(appointment => ({ ...appointment, reviewed: reviewed.includes(appointment.id) })));
  }));

  app.post("/api/appointments", requireUser, requirePatient, requireVerifiedEmail, wrap(async (req, res) => {
    const body = req.body || {};
    const requestedDoctorId = Number(body.doctorId);
    const doctor = Number.isSafeInteger(requestedDoctorId) && requestedDoctorId > 0
      ? await store.getDoctor(requestedDoctorId)
      : null;
    const date = String(body.date || "");
    const symptoms = String(body.symptoms || "").trim();
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    const providerAddress = typeof body.providerAddress === "string" ? body.providerAddress.trim() : "";
    const externalProvider = !doctor &&
      body.providerSource === "openstreetmap" &&
      body.providerCategory === "healthcare" &&
      providerName.length >= 2 && providerName.length <= 160 &&
      providerAddress.length <= 300;
    if ((!doctor && !externalProvider) || !validDate(date) || symptoms.length > 1500) {
      return res.status(400).json({ error: "Choose a listed doctor or nearby healthcare provider and a future appointment date." });
    }
    const problem = await checkBookable({ doctor, date, userId: req.user.id });
    if (problem) return res.status(problem.status).json({ error: problem.error });
    let appointment;
    try {
      appointment = await store.createAppointment({
        userId: req.user.id,
        doctorId: doctor ? doctor.id : null,
        providerName, providerAddress, providerSource: "openstreetmap",
        date, symptoms,
        notes: String(body.notes || "").trim().slice(0, 1000),
        status: doctor ? "Pending" : "Request saved · unconfirmed"
      });
    } catch (error) {
      if (error.code === "23505" && error.constraint === "appointments_doctor_slot_uniq") return res.status(409).json({ error: "That time slot is already booked. Please choose another time." });
      throw error;
    }
    if (doctor) await notify(await store.getDoctorAccountId(doctor.id), "appointment_new",
      `New appointment request from ${req.user.name} on ${new Date(date).toLocaleString("en-IN", { timeZone: CLINIC_TIMEZONE })}.`, "/doctor");
    res.status(201).json(appointment);
  }));

  app.post("/api/appointments/:id/cancel", requireUser, requirePatient, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const appointment = id ? await store.getAppointmentForPatient(id, req.user.id) : null;
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    if (!CHANGEABLE.includes(appointment.status)) return res.status(409).json({ error: "This appointment can no longer be cancelled." });
    if (appointment.paymentStatus === "paid") return res.status(409).json({ error: "This appointment is paid. Please contact support to cancel and request a refund." });
    if (Date.parse(appointment.date) - Date.now() < MIN_NOTICE_MS) return res.status(409).json({ error: "Appointments cannot be cancelled within 2 hours of the start time." });
    const updated = await store.cancelAppointment(id, req.user.id, appointment.status);
    if (!updated) return res.status(409).json({ error: "The appointment changed. Refresh and try again." });
    if (appointment.doctorId) await notify(await store.getDoctorAccountId(appointment.doctorId), "appointment_cancelled",
      `${req.user.name} cancelled the appointment on ${new Date(appointment.date).toLocaleString("en-IN", { timeZone: CLINIC_TIMEZONE })}.`, "/doctor");
    res.json(updated);
  }));
  app.post("/api/appointments/:id/reschedule", requireUser, requirePatient, requireVerifiedEmail, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const date = String((req.body || {}).date || "");
    const appointment = id ? await store.getAppointmentForPatient(id, req.user.id) : null;
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    if (!CHANGEABLE.includes(appointment.status)) return res.status(409).json({ error: "This appointment can no longer be rescheduled." });
    if (appointment.paymentStatus === "paid") return res.status(409).json({ error: "Paid appointments cannot be rescheduled. Please contact support." });
    if (!validDate(date)) return res.status(400).json({ error: "Choose a future date and time." });
    if (Date.parse(appointment.date) - Date.now() < MIN_NOTICE_MS) return res.status(409).json({ error: "Appointments cannot be rescheduled within 2 hours of the start time." });
    if (appointment.doctorId) {
      const doctor = await store.getDoctor(appointment.doctorId);
      const problem = await checkBookable({ doctor, date, userId: req.user.id, ignoreAppointmentId: id });
      if (problem) return res.status(problem.status).json({ error: problem.error });
    }
    const status = appointment.doctorId ? "Pending" : appointment.status;
    let updated;
    try { updated = await store.rescheduleAppointment(id, req.user.id, appointment.status, date, status); }
    catch (error) {
      if (error.code === "23505" && error.constraint === "appointments_doctor_slot_uniq") return res.status(409).json({ error: "That time slot is already booked. Please choose another time." });
      throw error;
    }
    if (!updated) return res.status(409).json({ error: "The appointment changed. Refresh and try again." });
    if (appointment.doctorId) await notify(await store.getDoctorAccountId(appointment.doctorId), "appointment_rescheduled",
      `${req.user.name} requested a new time: ${new Date(date).toLocaleString("en-IN", { timeZone: CLINIC_TIMEZONE })}. Please confirm.`, "/doctor");
    res.json(updated);
  }));
  app.post("/api/appointments/:id/review", requireUser, requirePatient, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const rating = Number((req.body || {}).rating);
    const comment = String((req.body || {}).comment || "").trim();
    const appointment = id ? await store.getAppointmentForPatient(id, req.user.id) : null;
    if (!appointment || !appointment.doctorId) return res.status(404).json({ error: "Appointment not found." });
    if (appointment.status !== "Completed") return res.status(409).json({ error: "You can review a doctor after the appointment is completed." });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length > 1000) return res.status(400).json({ error: "Choose a rating from 1 to 5 and keep the comment under 1000 characters." });
    const review = await store.createReview({ appointmentId: id, userId: req.user.id, doctorId: appointment.doctorId, rating, comment });
    if (!review) return res.status(409).json({ error: "You have already reviewed this appointment." });
    await notify(await store.getDoctorAccountId(appointment.doctorId), "review", `You received a new ${rating}-star review.`, "/doctor");
    res.status(201).json({ id: review.id });
  }));
  app.post("/api/appointments/:id/pay/order", requireUser, requirePatient, requireVerifiedEmail, wrap(async (req, res) => {
    if (!RZP_KEY_ID || !RZP_KEY_SECRET) return res.status(503).json({ error: "Online payments are not configured." });
    const id = parseId(req.params.id);
    const appointment = id ? await store.getAppointmentForPatient(id, req.user.id) : null;
    if (!appointment || !appointment.doctorId) return res.status(404).json({ error: "Appointment not found." });
    if (!["Pending", "Accepted"].includes(appointment.status)) return res.status(409).json({ error: "This appointment cannot be paid for." });
    if (appointment.paymentStatus === "paid") return res.status(409).json({ error: "This appointment is already paid." });
    const doctor = await store.getDoctor(appointment.doctorId);
    if (!doctor || !Number.isFinite(Number(doctor.fee)) || Number(doctor.fee) <= 0) return res.status(409).json({ error: "The consultation fee is unavailable." });
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64")}` },
      body: JSON.stringify({ amount: Math.round(Number(doctor.fee) * 100), currency: PAYMENT_CURRENCY, receipt: `appt_${id}`, notes: { appointmentId: String(id) } }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return res.status(502).json({ error: "Could not start the payment. Please try again." });
    const order = await response.json();
    const saved = await store.setPaymentOrder(id, req.user.id, order.id);
    if (!saved) return res.status(409).json({ error: "The appointment changed. Refresh and try again." });
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: RZP_KEY_ID });
  }));
  app.post("/api/appointments/:id/pay/verify", requireUser, requirePatient, wrap(async (req, res) => {
    if (!RZP_KEY_SECRET) return res.status(503).json({ error: "Online payments are not configured." });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    const id = parseId(req.params.id);
    const appointment = id ? await store.getAppointmentForPatient(id, req.user.id) : null;
    if (!appointment || !orderId || !paymentId || appointment.paymentOrderId !== orderId) return res.status(400).json({ error: "Payment does not match this appointment." });
    const expected = crypto.createHmac("sha256", RZP_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    if (!safeEqual(expected, signature || "")) return res.status(400).json({ error: "Payment signature could not be verified." });
    const paid = await store.markPaid(orderId, String(paymentId));
    if (!paid) return res.status(404).json({ error: "Payment order not found." });
    await notify(req.user.id, "payment", "Payment received for your appointment. Thank you!");
    await notify(await store.getDoctorAccountId(appointment.doctorId), "payment", `${req.user.name} paid the consultation fee.`, "/doctor");
    res.json(paid);
  }));

  app.get("/api/doctor/me", requireUser, requireDoctor, (req, res) => {
    res.json({ doctor: req.doctor, user: sessionUser(req.user) });
  });
  app.get("/api/doctor/appointments", requireUser, requireDoctor, wrap(async (req, res) => {
    const appointments = await store.listAppointmentsForDoctor(req.doctor.id);
    const reportsByPatient = new Map();
    for (const appointment of appointments) {
      if (!reportsByPatient.has(appointment.userId)) {
        reportsByPatient.set(appointment.userId, await store.listMedicalReportsForPatient(appointment.userId));
      }
      appointment.reports = reportsByPatient.get(appointment.userId);
      appointment.prescriptionAvailable = (await store.listPrescriptionsForPatient(appointment.userId))
        .some(prescription => prescription.appointmentId === appointment.id);
    }
    res.json(appointments);
  }));
  app.get("/api/doctor/analytics", requireUser, requireDoctor, wrap(async (req, res) => {
    res.json(await store.doctorAnalytics(req.doctor.id));
  }));
  app.put("/api/doctor/availability", requireUser, requireDoctor, wrap(async (req, res) => {
    const schedule = (req.body || {}).schedule;
    if (!Array.isArray(schedule) || schedule.length > 14 ||
        schedule.some(slot => typeof slot !== "string" || slot.trim().length < 3 || slot.length > 100)) {
      return res.status(400).json({ error: "Availability must contain up to 14 day and time entries." });
    }
    res.json({ doctor: await store.updateDoctorAvailability(req.doctor.id, schedule.map(slot => slot.trim())) });
  }));
  app.post("/api/doctor/appointments/:id/status", requireUser, requireDoctor, wrap(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const status = String((req.body || {}).status || "");
    const appointment = (await store.listAppointmentsForDoctor(req.doctor.id))
      .find(item => item.id === appointmentId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    const allowed = appointment.status === "Pending" && ["Accepted", "Rejected"].includes(status) ||
      appointment.status === "Accepted" && status === "Completed";
    if (!allowed) return res.status(409).json({ error: "That appointment status transition is not allowed." });
    const updated = await store.updateAppointmentStatus(appointmentId, req.doctor.id, appointment.status, status);
    if (!updated) return res.status(409).json({ error: "The appointment changed before the status could be saved. Refresh and try again." });
    await notify(appointment.userId, "appointment_status",
      `Your appointment on ${new Date(appointment.date).toLocaleString("en-IN", { timeZone: CLINIC_TIMEZONE })} was ${status.toLowerCase()} by ${req.doctor.name}.`);
    res.json(updated);
  }));
  app.put("/api/doctor/appointments/:id/consultation", requireUser, requireDoctor, wrap(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const notes = String((req.body || {}).notes || "").trim();
    const appointment = (await store.listAppointmentsForDoctor(req.doctor.id))
      .find(item => item.id === appointmentId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    if (!["Accepted", "Completed"].includes(appointment.status)) {
      return res.status(409).json({ error: "Accept the appointment before adding consultation notes." });
    }
    if (!notes || notes.length > 12000) {
      return res.status(400).json({ error: "Consultation notes must contain 1 to 12,000 characters." });
    }
    res.json(await store.saveConsultation(appointmentId, req.doctor.id, appointment.userId, notes));
  }));
  app.post("/api/doctor/appointments/:id/prescription", requireUser, requireDoctor, wrap(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const appointment = (await store.listAppointmentsForDoctor(req.doctor.id))
      .find(item => item.id === appointmentId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found." });
    if (!["Accepted", "Completed"].includes(appointment.status)) {
      return res.status(409).json({ error: "Accept the appointment before creating a prescription." });
    }
    const body = req.body || {};
    const instructions = String(body.instructions || "").trim();
    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 30 || instructions.length > 4000) {
      return res.status(400).json({ error: "Enter 1 to 30 prescribed medicines and valid instructions." });
    }
    const normalized = items.map(item => ({
      medicine: String(item && item.medicine || "").trim(),
      dosage: String(item && item.dosage || "").trim(),
      duration: String(item && item.duration || "").trim(),
      instructions: String(item && item.instructions || "").trim()
    }));
    if (normalized.some(item => !item.medicine || item.medicine.length > 160 ||
        !item.dosage || item.dosage.length > 100 || !item.duration || item.duration.length > 100 ||
        item.instructions.length > 300)) {
      return res.status(400).json({ error: "Each medicine needs a name, dosage, and duration; check field lengths." });
    }
    const encryptedData = encryptClinicalData(Buffer.from(JSON.stringify({
      instructions, items: normalized, createdAt: new Date().toISOString()
    })), clinicalEncryptionKey);
    const prescription = await store.savePrescription(appointmentId, req.doctor.id, appointment.userId, encryptedData);
    if (!prescription) return res.status(404).json({ error: "The appointment could not be linked to this prescription." });
    res.status(201).json(prescription);
  }));

  app.get("/api/doctor/patients/:patientId/reports", requireUser, requireDoctor, wrap(async (req, res) => {
    const patientId = Number(req.params.patientId);
    if (!(await store.listAppointmentsForDoctor(req.doctor.id)).some(appointment => appointment.userId === patientId)) {
      return res.status(404).json({ error: "Patient record not found." });
    }
    res.json(await store.listMedicalReportsForPatient(patientId));
  }));

  app.get("/api/patient/analytics", requireUser, requirePatient, wrap(async (req, res) => {
    res.json(await store.patientAnalytics(req.user.id));
  }));
  app.get("/api/patient/reports", requireUser, requirePatient, wrap(async (req, res) => {
    const reports = await store.listMedicalReportsForPatient(req.user.id);
    res.json(await Promise.all(reports.map(async report => {
      const saved = await store.getMedicalReportForParticipant(report.id, req.user.id);
      const payload = JSON.parse(decryptClinicalData(saved.encryptedData, clinicalEncryptionKey).toString("utf8"));
      return {
        ...report, measurements: payload.measurements, history: payload.history,
        extractionSource: payload.extractionSource
      };
    })));
  }));
  app.get("/api/patient/prescriptions", requireUser, requirePatient, wrap(async (req, res) => {
    const prescriptions = await store.listPrescriptionsForPatient(req.user.id);
    res.json(await Promise.all(prescriptions.map(async prescription => {
      const details = JSON.parse(decryptClinicalData(prescription.encryptedData, clinicalEncryptionKey).toString("utf8"));
      const appointment = await store.getAppointmentForParticipant(prescription.appointmentId, req.user.id);
      return {
        id: prescription.id, appointmentId: prescription.appointmentId,
        doctorName: appointment?.doctor?.name || "CareConnect doctor",
        createdAt: prescription.createdAt, ...details
      };
    })));
  }));
  app.post("/api/patient/reports", requireUser, requirePatient, requireVerifiedEmail, upload.single("report"), wrap(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Choose a medical report file to upload." });
    const extension = path.extname(file.originalname).toLowerCase();
    const supported = {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".txt": "text/plain",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    };
    if (!supported[extension] || supported[extension] !== file.mimetype) {
      return res.status(400).json({ error: "Upload a PDF, DOCX, TXT, PNG, JPG, or WEBP report." });
    }
    const isImage = extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".webp";
    const validSignature = extension === ".pdf" ? file.buffer.subarray(0, 5).toString() === "%PDF-" :
      extension === ".docx" ? file.buffer.subarray(0, 2).toString() === "PK" :
        extension === ".png" ? file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
          extension === ".jpg" || extension === ".jpeg" ? file.buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])) :
            extension === ".webp" ? file.buffer.subarray(0, 4).toString() === "RIFF" && file.buffer.subarray(8, 12).toString() === "WEBP" :
              extension === ".txt";
    if (!validSignature) return res.status(400).json({ error: "The uploaded report file does not match its file type." });
    let extractedText;
    let extractionSource = "Local PDF/DOCX/TXT text extraction";
    if (extension === ".pdf") extractedText = (await pdfParse(file.buffer)).text;
    else if (extension === ".docx") extractedText = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    else if (extension === ".txt") extractedText = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    else {
      if (req.body.externalAiConsent !== "true") {
        return res.status(400).json({ error: "Image text extraction sends the image to Gemini. Confirm that consent before uploading." });
      }
      const result = await analyzeDocument({
        image: { mime: file.mimetype, data: file.buffer.toString("base64") }
      });
      extractedText = [result.summary, ...result.keyFindings].join("\n");
      extractionSource = "Gemini image extraction; clinician verification required";
    }
    extractedText = String(extractedText || "").slice(0, 12000);
    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No readable text was extracted from the report. Try a text-based PDF or DOCX." });
    }
    const payload = {
      fileData: file.buffer.toString("base64"),
      extractedText,
      measurements: extractReportMeasurements(extractedText),
      history: extractReportHistory(extractedText),
      extractionSource
    };
    const encryptedData = encryptClinicalData(Buffer.from(JSON.stringify(payload)), clinicalEncryptionKey);
    const filename = path.basename(file.originalname).replace(/[\r\n"]/g, "_").slice(0, 180);
    const report = await store.saveMedicalReport({
      patientId: req.user.id, uploadedBy: req.user.id, filename, mimeType: file.mimetype, encryptedData
    });
    res.status(201).json({
      ...report, measurements: payload.measurements, history: payload.history, extractionSource
    });
  }));
  app.get("/api/reports/:id/file", requireUser, wrap(async (req, res) => {
    const report = await store.getMedicalReportForParticipant(Number(req.params.id), req.user.id);
    if (!report) return res.status(404).json({ error: "Report not found." });
    const payload = JSON.parse(decryptClinicalData(report.encryptedData, clinicalEncryptionKey).toString("utf8"));
    const fileData = Buffer.from(payload.fileData, "base64");
    res.setHeader("Content-Type", report.mimeType);
    res.setHeader("Content-Length", fileData.length);
    const disposition = ["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(report.mimeType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${report.filename.replace(/[\r\n"]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(fileData);
  }));
  app.get("/api/prescriptions/:id/pdf", requireUser, requirePatient, wrap(async (req, res) => {
    const prescriptions = await store.listPrescriptionsForPatient(req.user.id);
    const prescription = prescriptions.find(item => item.id === Number(req.params.id));
    if (!prescription) return res.status(404).json({ error: "Prescription not found." });
    const details = JSON.parse(decryptClinicalData(prescription.encryptedData, clinicalEncryptionKey).toString("utf8"));
    const appointment = await store.getAppointmentForParticipant(prescription.appointmentId, req.user.id);
    if (!appointment) return res.status(404).json({ error: "Prescription appointment not found." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="careconnect-prescription-${prescription.id}.pdf"`);
    const pdf = new PDFDocument({ size: "A4", margin: 54 });
    pdf.pipe(res);
    pdf.fontSize(20).text("CareConnect Prescription");
    pdf.moveDown().fontSize(11).text(`Patient: ${appointment.patient.name}`);
    pdf.text(`Prescriber: ${appointment.doctor?.name || "CareConnect doctor"}`);
    pdf.text(`Consultation: ${new Date(appointment.date).toLocaleString()}`);
    pdf.moveDown().fontSize(14).text("Medicines");
    details.items.forEach((item, index) => {
      pdf.moveDown(0.5).fontSize(11).text(`${index + 1}. ${item.medicine}`);
      pdf.text(`Dosage: ${item.dosage}   Duration: ${item.duration}`);
      if (item.instructions) pdf.text(`Instructions: ${item.instructions}`);
    });
    if (details.instructions) pdf.moveDown().text(`Additional instructions: ${details.instructions}`);
    pdf.moveDown().fontSize(9).fillColor("#555").text("This document records instructions entered by the prescriber. Contact your doctor or pharmacist with questions. Do not change prescribed treatment without professional advice.");
    pdf.end();
  }));

  app.get("/api/video/appointments/:id/signals", requireUser, wrap(async (req, res) => {
    const appointment = await store.getAppointmentForParticipant(Number(req.params.id), req.user.id);
    if (!appointment || appointment.status !== "Accepted" || !appointment.doctorId) {
      return res.status(404).json({ error: "An accepted appointment is required for this video consultation." });
    }
    const after = Number(req.query.after || 0);
    if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "Invalid video signal cursor." });
    const cutoff = Date.now() - 15 * 60 * 1000;
    const signals = (activeVideoCalls.get(appointment.id) || []).filter(signal => signal.createdAt >= cutoff);
    activeVideoCalls.set(appointment.id, signals);
    res.json({ signals: signals.filter(signal => signal.id > after && signal.senderId !== req.user.id).slice(0, 50) });
  }));
  app.post("/api/video/appointments/:id/signals", requireUser, wrap(async (req, res) => {
    const appointment = await store.getAppointmentForParticipant(Number(req.params.id), req.user.id);
    if (!appointment || appointment.status !== "Accepted" || !appointment.doctorId) {
      return res.status(404).json({ error: "An accepted appointment is required for this video consultation." });
    }
    const signal = (req.body || {}).signal;
    if (!signal || !["offer", "answer", "candidate"].includes(signal.type) ||
        Buffer.byteLength(JSON.stringify(signal)) > 20000) {
      return res.status(400).json({ error: "Invalid video consultation signal." });
    }
    if (["offer", "answer"].includes(signal.type) &&
        (!signal.description || typeof signal.description.sdp !== "string" || signal.description.sdp.length > 18000)) {
      return res.status(400).json({ error: "Invalid WebRTC session description." });
    }
    if (signal.type === "candidate" &&
        (!signal.candidate || typeof signal.candidate.candidate !== "string" || signal.candidate.candidate.length > 3000)) {
      return res.status(400).json({ error: "Invalid WebRTC ICE candidate." });
    }
    const now = Date.now();
    const cutoff = now - 15 * 60 * 1000;
    const signals = (activeVideoCalls.get(appointment.id) || []).filter(item => item.createdAt >= cutoff);
    if (signals.length >= 200) return res.status(429).json({ error: "This video consultation signal queue is full. Rejoin the call." });
    const id = (signals.at(-1)?.id || 0) + 1;
    signals.push({ id, senderId: req.user.id, signal, createdAt: now });
    activeVideoCalls.set(appointment.id, signals);
    res.status(202).json({ id });
  }));

  app.get("/api/orders", requireUser, wrap(async (req, res) => {
    res.json(await store.listOrdersForUser(req.user.id));
  }));

  app.post("/api/orders", requireUser, requireVerifiedEmail, wrap(async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) {
      return res.status(400).json({ error: "Your cart is empty or contains too many items." });
    }
    const ids = [...new Set(body.items.map(item => Number(item && item.productId)).filter(Number.isSafeInteger))];
    const products = await store.getProductsByIds(ids);
    const items = body.items.map(item => {
      const product = products.find(entry => entry.id === Number(item && item.productId));
      const quantity = Number(item && item.quantity);
      return product && Number.isInteger(quantity) && quantity > 0 && quantity <= 50
        ? { productId: product.id, name: product.name, quantity, price: product.price }
        : null;
    });
    if (items.some(item => !item) || !items.length) return res.status(400).json({ error: "The cart contains an invalid product or quantity." });
    const order = await store.createOrder({
      userId: req.user.id,
      items,
      total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      status: "Processing"
    });
    res.status(201).json(order);
  }));

  app.post("/api/ml/recommendations", requireUser, async (req, res, next) => {
    try {
      const symptoms = String((req.body || {}).symptoms || "").trim();
      if (symptoms.length < 5 || symptoms.length > 1500) {
        return res.status(400).json({ error: "Describe your concern in 5 to 1,500 characters." });
      }
      const specialties = (await store.listDoctors()).map(doctor => doctor.specialty);
      const local = await mlService.specialty(symptoms, specialties);
      const matchedSpecialty = local && specialties.find(
        item => item.toLowerCase() === String(local.specialty || "").toLowerCase()
      );
      const confidence = Number(local && local.confidence);
      const isEmergency = local && typeof local.emergency_warning === "string" && local.emergency_warning.length > 0;
      if (matchedSpecialty && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
          ["routine", "soon", "urgent"].includes(local.urgency) &&
          (!local.low_confidence || isEmergency)) {
        return res.json({
          specialty: matchedSpecialty,
          urgency: local.urgency,
          rationale: isEmergency
            ? local.emergency_warning
            : `Matched with ${Math.round(confidence * 100)}% confidence by the CareConnect model.`,
          alternatives: Array.isArray(local.alternatives) ? local.alternatives : [],
          disclaimer: local.disclaimer || "General guidance only, not a diagnosis.",
          source: "careconnect-ml"
        });
      }
      if (local && (!matchedSpecialty || !Number.isFinite(confidence) ||
          confidence < 0 || confidence > 1 || !["routine", "soon", "urgent"].includes(local.urgency))) {
        console.warn("CareConnect ML service returned an invalid specialty result; using Gemini fallback.");
      }
      res.json(await recommendSpecialty(symptoms, specialties));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ml/no-show", requireUser, async (req, res, next) => {
    try {
      const body = req.body || {};
      const requestedId = Number(body.doctorId);
      const doctor = Number.isSafeInteger(requestedId) && requestedId > 0 ? await store.getDoctor(requestedId) : null;
      const date = String(body.date || "");
      if (!doctor || !validDate(date)) {
        return res.status(400).json({ error: "Choose a doctor and a future appointment date." });
      }
      const history = await store.appointmentStats(req.user.id);
      const when = new Date(date);
      const local = await mlService.noShow({
        lead_days: Math.max(0, Math.round((when - Date.now()) / 864e5)),
        hour: when.getHours(),
        dow: when.getDay(),
        prev_appts: history.total,
        prev_noshow: history.noShows,
        age: 40,
        reminder: 1,
        fee: doctor.fee
      });
      const probability = Number(local && local.probability);
      if (Number.isFinite(probability) && probability >= 0 && probability <= 100 &&
          ["low", "moderate", "high"].includes(local.risk)) {
        return res.json({
          probability: Math.round(probability),
          risk: local.risk,
          factors: [],
          disclaimer: local.disclaimer || "Experimental operational estimate only; never use this to deny or delay care.",
          source: "careconnect-ml"
        });
      }
      if (local) {
        console.warn("CareConnect ML service returned an invalid attendance estimate; using Gemini fallback.");
      }
      const result = await predictNoShow({
        doctor: doctor.specialty,
        appointmentDate: date,
        previousAppointments: history.total,
        previousNoShows: history.noShows
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ml/chat", requireUser, upload.single("document"), async (req, res, next) => {
    try {
      const body = req.body || {};
      const message = String(body.message || "").trim();
      if (message.length > 2000) return res.status(400).json({ error: "Messages must be 2,000 characters or fewer." });
      if (!message && !req.file) return res.status(400).json({ error: "Enter a message or attach a document." });

      let history;
      try {
        history = JSON.parse(body.history || "[]");
      } catch {
        return res.status(400).json({ error: "The conversation could not be read. Start a new chat and try again." });
      }
      if (!Array.isArray(history) || history.length > 12 ||
          history.some(turn => !turn || !["user", "assistant"].includes(turn.role) ||
            typeof turn.content !== "string" || !turn.content.trim() || turn.content.length > 2000) ||
          history.reduce((total, turn) => total + turn.content.length, 0) > 12000) {
        return res.status(400).json({ error: "The conversation is too long or contains invalid messages. Start a new chat." });
      }

      let documentText;
      let image;
      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase();
        const mime = req.file.mimetype;
        if (ext === ".txt" && mime === "text/plain") {
          try {
            documentText = new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer);
          } catch {
            return res.status(400).json({ error: "The text file is not valid UTF-8." });
          }
        } else if (ext === ".pdf" && mime === "application/pdf" && req.file.buffer.subarray(0, 5).toString() === "%PDF-") {
          let parsed;
          try {
            parsed = await pdfParse(req.file.buffer);
          } catch {
            return res.status(400).json({ error: "The PDF could not be read. Check that it is a valid PDF and try again." });
          }
          if (parsed.text.trim()) documentText = parsed.text;
          else image = { mime, data: req.file.buffer.toString("base64") };
        } else if (ext === ".docx" && mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && req.file.buffer.subarray(0, 2).toString() === "PK") {
          try {
            documentText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
          } catch {
            return res.status(400).json({ error: "The DOCX file could not be read. Check that it is a valid document and try again." });
          }
        } else if (
          [".png", ".jpg", ".jpeg", ".webp"].includes(ext) &&
          { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] === mime
        ) {
          image = { mime, data: req.file.buffer.toString("base64") };
        } else {
          return res.status(400).json({ error: "Use a valid PDF, DOCX, TXT, PNG, JPG, or WEBP file." });
        }
        if (documentText !== undefined && !documentText.trim()) {
          return res.status(400).json({ error: "No readable text was found in that file." });
        }
        if (documentText !== undefined && documentText.length > 12000) {
          return res.status(400).json({ error: "This document contains more than 12,000 characters of readable text. Upload a shorter excerpt." });
        }
      }

      res.json(await chatWithHealthAssistant({ message, history, documentText, image }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ml/documents", requireUser, upload.single("document"), async (req, res, next) => {
    try {
      const body = req.body || {};
      const mode = body.mode || "summary";
      const typedText = String(body.documentText || "").trim();
      if (!["summary", "prescription"].includes(mode)) {
        return res.status(400).json({ error: "Choose document summary or prescription reading." });
      }
      if (typedText.length > 12000) return res.status(400).json({ error: "Pasted text must be 12,000 characters or fewer." });
      if (Boolean(req.file) === Boolean(typedText)) {
        return res.status(400).json({ error: "Paste document text or choose one file, not both." });
      }
      let extractedText = typedText || undefined;
      let image;
      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase();
        const mime = req.file.mimetype;
        if (ext === ".txt" && mime === "text/plain") {
          extractedText = new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer);
        } else if (ext === ".pdf" && mime === "application/pdf" && req.file.buffer.subarray(0, 5).toString() === "%PDF-") {
          extractedText = (await pdfParse(req.file.buffer)).text;
        } else if (ext === ".docx" && mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && req.file.buffer.subarray(0, 2).toString() === "PK") {
          extractedText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
        } else if (
          [".png", ".jpg", ".jpeg", ".webp"].includes(ext) &&
          { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] === mime
        ) {
          image = { mime, data: req.file.buffer.toString("base64") };
        } else {
          return res.status(400).json({ error: "Use a valid PDF, DOCX, TXT, PNG, JPG, or WEBP file." });
        }
      }
      if (extractedText !== undefined && !extractedText.trim()) {
        return res.status(400).json({ error: "No readable text was found in that file." });
      }
      if (mode === "prescription") {
        const products = await store.listProducts();
        return res.json(await readPrescription({ text: extractedText, image, products }));
      }
      res.json(await analyzeDocument({ text: extractedText, image }));
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("encoded data")) {
        return res.status(400).json({ error: "The text file is not valid UTF-8." });
      }
      next(error);
    }
  });

  app.use(express.static(publicDir, { index: "index.html" }));
  app.get(["/dashboard", "/doctors", "/hospitals", "/nearby", "/ai-tools", "/ml-service", "/pharmacy", "/appointments", "/doctor"], (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
  // Pages opened from email links carry a one-time token in the URL: never cache them or leak them via Referer.
  app.get(["/verify-email", "/reset-password"], (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.use((req, res) => res.status(404).json({ error: "Not found." }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Files must be 8 MB or smaller." : "The uploaded file could not be accepted." });
    }
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return res.status(503).json({ error: "Gemini took too long to respond. Try again or use a smaller document." });
    }
    if (!error.expose) console.error(error);
    const status = error.status || 500;
    const message = error.expose || status < 500
      ? error.message
      : "The request could not be completed. Please try again.";
    res.status(status).json({ error: message });
  });
  return app;
}

const app = createApp();
if (require.main === module) {
  ready.then(() => {
    if (process.env.REMINDERS !== "off" && process.env.NODE_ENV !== "test") startReminderJob();
    app.listen(port, () => console.log(`Healthcare Consultation running at http://localhost:${port} (database: ${store.driver}, email: ${mailer.mode})`));
    if (mailer.mode === "disabled") {
      console.warn("WARNING: email is not configured (set SMTP_URL or SMTP_HOST). Verification and password-reset emails cannot be sent, and email confirmation is not enforced.");
    } else if (mailer.mode === "console") {
      console.warn("NOTE: email transport is 'console': messages (including links) are printed here instead of being sent.");
    }
  }).catch(error => {
    console.error("Failed to initialise the database:", error.message);
    process.exit(1);
  });
}

module.exports = { app, createApp, store, ready, mailer, hashPassword, verifyPassword };
