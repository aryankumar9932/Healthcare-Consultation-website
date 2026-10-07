const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { analyzeDocument, chatWithHealthAssistant, predictNoShow, readPrescription, recommendSpecialty } = require("./ml");
const { normalizeOpenStreetMapElement } = require("./public/geo");
const mlService = require("./ml-client");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dbFile = process.env.DB_FILE || path.join(dataDir, "db.json");
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

const seed = {
  departments: [
    { id: 1, title: "Cardiology", description: "Expert care for heart and blood-vessel conditions.", image: "images/5fc6c72f4cd54.jpg" },
    { id: 2, title: "Gynecology", description: "Compassionate care for women's health at every stage.", image: "images/5fc6c31dcc11c.jpg" },
    { id: 3, title: "Neurology", description: "Diagnosis and treatment for the nervous system.", image: "images/5fc6c6e3193a5.png" },
    { id: 4, title: "Medicine", description: "Everyday primary care, prevention, and treatment.", image: "images/5fc6c797d059d.jpg" },
    { id: 5, title: "Dentistry", description: "Modern preventive and restorative dental care.", image: "images/5fc6c7e01b6be.jpg" },
    { id: 6, title: "Orthopedics", description: "Specialist care for bones, joints, and movement.", image: "images/5fe127a361f55.jpg" }
  ],
  doctors: [
    { id: 1, departmentId: 2, name: "Dr. Halima", specialty: "Gynecologist", bio: "Experienced women's health specialist.", fee: 650, image: "images/5ff394a115cbe.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 10:00 - 17:00"] },
    { id: 2, departmentId: 1, name: "Dr. Johny", specialty: "Cardiologist", bio: "Focused on preventive and interventional heart care.", fee: 400, image: "images/5ff4aebc6fe31.jpg", schedule: ["Sunday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 3, departmentId: 2, name: "Dr. Sansa", specialty: "Gynecologist", bio: "Patient-first care for every family.", fee: 650, image: "images/5ff4aed5e8e21.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 4, departmentId: 3, name: "Dr. John", specialty: "Neurologist", bio: "Helping patients understand and manage neurological health.", fee: 450, image: "images/5ff4aef3c8c25.jpg", schedule: ["Sunday 10:00 - 14:30", "Wednesday 11:00 - 18:00"] },
    { id: 5, departmentId: 4, name: "Dr. Lue", specialty: "Physician", bio: "Comprehensive primary and preventive care.", fee: 400, image: "images/5ff4af1bed6be.jpg", schedule: ["Sunday 10:00 - 17:00", "Monday 11:00 - 18:00"] },
    { id: 6, departmentId: 5, name: "Dr. Kaung", specialty: "Dentist", bio: "Comfortable, modern dental treatment.", fee: 450, image: "images/5ff4b00c9c319.jpg", schedule: ["Monday 10:00 - 17:00", "Wednesday 11:00 - 18:00"] },
    { id: 7, departmentId: 6, name: "Dr. Tomas", specialty: "Orthopedist", bio: "Restoring movement and quality of life.", fee: 650, image: "images/5ff4b029292e4.jpg", schedule: ["Sunday 10:00 - 14:30", "Tuesday 11:00 - 18:00"] }
  ],
  products: [
    { id: 1, name: "Sugatrol 100mg 10pcs", description: "Acarbose 100mg - Pacific Pharmaceuticals Ltd.", price: 240, image: "images/5fc6e8091e91d.jpg" },
    { id: 2, name: "Napa 500mg", description: "For temporary relief of headache and minor pain.", price: 50, image: "images/600e89f8523d9.jpg" }
  ],
  users: [],
  appointments: [],
  orders: [],
  clinics: []
};

function ensureDb() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify(seed, null, 2));
    return;
  }
  const current = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  let changed = false;
  const catalogues = new Set(["departments", "doctors", "products"]);
  for (const key of Object.keys(seed)) {
    if (!Array.isArray(current[key]) || (catalogues.has(key) && !current[key].length)) {
      current[key] = seed[key];
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(dbFile, JSON.stringify(current, null, 2));
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDb(db) {
  const temporaryFile = `${dbFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(db, null, 2));
  fs.renameSync(temporaryFile, dbFile);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || !/^[a-f\d]{128}$/i.test(hash)) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function sessionUser(user) {
  return { ...publicUser(user), isAdmin: isAdmin(user), canBootstrapAdmin: canBootstrapAdmin(user) };
}

function validBootstrapToken(value) {
  const expected = process.env.ADMIN_SETUP_TOKEN || "";
  const supplied = String(value || "");
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function idFor(list) {
  return list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

function requireUser(req, res, next) {
  const userId = Number(req.session && req.session.userId);
  const user = readDb().users.find(item => item.id === userId);
  if (!user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  next();
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) > Date.now();
}

function isAdmin(user) {
  return user.role === "admin";
}

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

let lastGeocodeAt = 0;
async function geocodeClinicAddress(address, clinics) {
  const existing = clinics.find(clinic => clinic.address.trim().toLowerCase() === address.toLowerCase());
  if (existing) return { latitude: existing.latitude, longitude: existing.longitude };

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
    const error = new Error("The address could not be found. Add the full clinic address and try again.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return { latitude, longitude };
}

function publicClinic(clinic, doctors) {
  const doctor = doctors.find(item => item.id === clinic.doctorId);
  return doctor ? { ...clinic, doctor: publicUser(doctor) } : null;
}

function createApp() {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(session({
    name: "careconnect.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  }));

  app.get("/api/health", (req, res) => res.json({ ok: true, mlRuntime: "gemini" }));
  app.get("/api/me", (req, res) => {
    const userId = Number(req.session && req.session.userId);
    const user = readDb().users.find(item => item.id === userId);
    res.json({ user: user ? sessionUser(user) : null });
  });
  app.get("/api/departments", (req, res) => res.json(readDb().departments));
  app.get("/api/doctors", (req, res) => {
    const db = readDb();
    const departmentId = Number(req.query.departmentId);
    res.json(departmentId ? db.doctors.filter(doctor => doctor.departmentId === departmentId) : db.doctors);
  });
  app.get("/api/products", (req, res) => res.json(readDb().products));
  app.get("/api/clinics", (req, res) => {
    const db = readDb();
    res.json(db.clinics.filter(clinic => clinic.verified)
      .map(clinic => publicClinic(clinic, db.doctors)).filter(Boolean));
  });
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

  app.post("/api/register", (req, res) => {
    const body = req.body || {};
    const db = readDb();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Enter a valid name and email, and a password of at least 8 characters." });
    }
    if (db.users.some(user => user.email.toLowerCase() === email)) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    const user = {
      id: idFor(db.users),
      name,
      email,
      phone: String(body.phone || "").trim().slice(0, 40),
      password: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeDb(db);
    req.session.userId = user.id;
    res.status(201).json({ user: sessionUser(user) });
  });

  app.post("/api/login", (req, res) => {
    const body = req.body || {};
    const db = readDb();
    const email = String(body.email || "").trim().toLowerCase();
    const user = db.users.find(item => item.email.toLowerCase() === email);
    if (!user || !verifyPassword(String(body.password || ""), user.password)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    req.session.userId = user.id;
    res.json({ user: sessionUser(user) });
  });

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

  app.post("/api/admin/bootstrap", requireUser, (req, res) => {
    if (isAdmin(req.user)) return res.status(409).json({ error: "This account is already an administrator." });
    if (!canBootstrapAdmin(req.user) || !validBootstrapToken((req.body || {}).setupToken)) {
      return res.status(403).json({ error: "Administrator setup is unavailable or the setup token is invalid." });
    }
    const db = readDb();
    const user = db.users.find(item => item.id === req.user.id);
    user.role = "admin";
    writeDb(db);
    res.json({ user: sessionUser(user) });
  });

  app.get("/api/admin/clinics", requireUser, requireAdmin, (req, res) => {
    const db = readDb();
    res.json(db.clinics.map(clinic => publicClinic(clinic, db.doctors)).filter(Boolean));
  });

  app.post("/api/admin/clinics", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const db = readDb();
      const doctor = db.doctors.find(item => item.id === Number(body.doctorId));
      const name = String(body.name || "").trim();
      const address = String(body.address || "").trim();
      if (!doctor || name.length < 2 || name.length > 120 || address.length < 8 || address.length > 300) {
        return res.status(400).json({ error: "Choose a doctor and enter the clinic name and full address." });
      }
      const coordinates = await geocodeClinicAddress(address, db.clinics);
      const clinic = {
        id: idFor(db.clinics),
        doctorId: doctor.id,
        name,
        address,
        ...coordinates,
        verified: false,
        createdAt: new Date().toISOString()
      };
      db.clinics.push(clinic);
      writeDb(db);
      res.status(201).json(publicClinic(clinic, db.doctors));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/admin/clinics/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const db = readDb();
      const clinic = db.clinics.find(item => item.id === Number(req.params.id));
      const doctor = db.doctors.find(item => item.id === Number(body.doctorId));
      const name = String(body.name || "").trim();
      const address = String(body.address || "").trim();
      if (!clinic) return res.status(404).json({ error: "Clinic not found." });
      if (!doctor || name.length < 2 || name.length > 120 || address.length < 8 || address.length > 300) {
        return res.status(400).json({ error: "Choose a doctor and enter the clinic name and full address." });
      }
      const addressChanged = address.toLowerCase() !== clinic.address.toLowerCase();
      const coordinates = !addressChanged
        ? { latitude: clinic.latitude, longitude: clinic.longitude }
        : await geocodeClinicAddress(address, db.clinics.filter(item => item.id !== clinic.id));
      Object.assign(clinic, { doctorId: doctor.id, name, address, ...coordinates, verified: addressChanged ? false : clinic.verified });
      writeDb(db);
      res.json(publicClinic(clinic, db.doctors));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/clinics/:id/verify", requireUser, requireAdmin, (req, res) => {
    const db = readDb();
    const clinic = db.clinics.find(item => item.id === Number(req.params.id));
    if (!clinic) return res.status(404).json({ error: "Clinic not found." });
    clinic.verified = true;
    clinic.verifiedAt = new Date().toISOString();
    writeDb(db);
    res.json(publicClinic(clinic, db.doctors));
  });

  app.delete("/api/admin/clinics/:id", requireUser, requireAdmin, (req, res) => {
    const db = readDb();
    const index = db.clinics.findIndex(item => item.id === Number(req.params.id));
    if (index === -1) return res.status(404).json({ error: "Clinic not found." });
    db.clinics.splice(index, 1);
    writeDb(db);
    res.status(204).end();
  });

  app.get("/api/appointments", requireUser, (req, res) => {
    const db = readDb();
    res.json(db.appointments
      .filter(item => item.userId === req.user.id)
      .map(item => ({ ...item, doctor: db.doctors.find(doctor => doctor.id === item.doctorId) })));
  });

  app.post("/api/appointments", requireUser, (req, res) => {
    const body = req.body || {};
    const db = readDb();
    const requestedDoctorId = Number(body.doctorId);
    const doctor = Number.isSafeInteger(requestedDoctorId) && requestedDoctorId > 0
      ? db.doctors.find(item => item.id === requestedDoctorId)
      : null;
    const date = String(body.date || "");
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    const providerAddress = typeof body.providerAddress === "string" ? body.providerAddress.trim() : "";
    const externalProvider = !doctor &&
      body.providerSource === "openstreetmap" &&
      body.providerCategory === "healthcare" &&
      providerName.length >= 2 && providerName.length <= 160 &&
      providerAddress.length <= 300;
    if ((!doctor && !externalProvider) || !validDate(date)) {
      return res.status(400).json({ error: "Choose a listed doctor or nearby healthcare provider and a future appointment date." });
    }
    const appointment = {
      id: idFor(db.appointments),
      userId: req.user.id,
      doctorId: doctor ? doctor.id : null,
      ...(doctor ? {} : {
        providerName,
        providerAddress,
        providerSource: "openstreetmap"
      }),
      date,
      notes: String(body.notes || "").trim().slice(0, 1000),
      status: doctor ? "Pending" : "Request saved · unconfirmed",
      createdAt: new Date().toISOString()
    };
    db.appointments.push(appointment);
    writeDb(db);
    res.status(201).json(appointment);
  });

  app.get("/api/orders", requireUser, (req, res) => {
    res.json(readDb().orders.filter(item => item.userId === req.user.id));
  });

  app.post("/api/orders", requireUser, (req, res) => {
    const body = req.body || {};
    const db = readDb();
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) {
      return res.status(400).json({ error: "Your cart is empty or contains too many items." });
    }
    const items = body.items.map(item => {
      const product = db.products.find(entry => entry.id === Number(item.productId));
      const quantity = Number(item.quantity);
      return product && Number.isInteger(quantity) && quantity > 0 && quantity <= 50
        ? { productId: product.id, name: product.name, quantity, price: product.price }
        : null;
    });
    if (items.some(item => !item) || !items.length) return res.status(400).json({ error: "The cart contains an invalid product or quantity." });
    const order = {
      id: idFor(db.orders),
      userId: req.user.id,
      items,
      total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      status: "Processing",
      createdAt: new Date().toISOString()
    };
    db.orders.push(order);
    writeDb(db);
    res.status(201).json(order);
  });

  app.post("/api/ml/recommendations", requireUser, async (req, res, next) => {
    try {
      const symptoms = String((req.body || {}).symptoms || "").trim();
      if (symptoms.length < 5 || symptoms.length > 1500) {
        return res.status(400).json({ error: "Describe your concern in 5 to 1,500 characters." });
      }
      const specialties = readDb().doctors.map(doctor => doctor.specialty);
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
      const db = readDb();
      const doctor = db.doctors.find(item => item.id === Number(body.doctorId));
      const date = String(body.date || "");
      if (!doctor || !validDate(date)) {
        return res.status(400).json({ error: "Choose a doctor and a future appointment date." });
      }
      const history = db.appointments.filter(item => item.userId === req.user.id);
      const when = new Date(date);
      const local = await mlService.noShow({
        lead_days: Math.max(0, Math.round((when - Date.now()) / 864e5)),
        hour: when.getHours(),
        dow: when.getDay(),
        prev_appts: history.length,
        prev_noshow: history.filter(item => item.status === "No-show").length,
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
        previousAppointments: history.length,
        previousNoShows: history.filter(item => item.status === "No-show").length
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
        const products = readDb().products;
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

  app.use("/admin/Res_img", express.static(path.join(root, "admin", "Res_img"), { fallthrough: false, index: false }));
  app.use(express.static(publicDir, { index: "index.html" }));
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

ensureDb();
const app = createApp();
if (require.main === module) {
  app.listen(port, () => console.log(`Healthcare Consultation running at http://localhost:${port}`));
}

module.exports = { app, hashPassword, verifyPassword };
