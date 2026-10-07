// JSON-file store: zero-setup development/demo driver. Same async interface as the PostgreSQL store.
const fs = require("fs");
const path = require("path");
const { seed } = require("./seed");

function createJsonStore(dbFile) {
  const lockouts = new Map(); // dev-only, in memory
  const idFor = list => list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;

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
  const read = () => { ensureDb(); return JSON.parse(fs.readFileSync(dbFile, "utf8")); };
  const write = db => {
    const tmp = `${dbFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbFile);
  };
  const withDoctor = (clinic, doctors) => {
    const doctor = doctors.find(d => d.id === clinic.doctorId);
    return doctor ? { ...clinic, doctor } : null;
  };

  return {
    driver: "json",
    sessionStore: () => undefined, // express-session MemoryStore
    async init() { ensureDb(); },
    async close() {},
    async reset() { fs.rmSync(dbFile, { force: true }); lockouts.clear(); ensureDb(); },

    async listDepartments() { return read().departments; },
    async listDoctors(departmentId) {
      const { doctors } = read();
      return departmentId ? doctors.filter(d => d.departmentId === departmentId) : doctors;
    },
    async getDoctor(id) { return read().doctors.find(d => d.id === id) || null; },
    async listProducts() { return read().products; },
    async getProductsByIds(ids) { return read().products.filter(p => ids.includes(p.id)); },

    async getUserById(id) { return read().users.find(u => u.id === id) || null; },
    async getUserByEmail(email) {
      return read().users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
    },
    async createUser({ name, email, phone, password }) {
      const db = read();
      if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return null; // duplicate
      const user = { id: idFor(db.users), name, email, phone, password, createdAt: new Date().toISOString() };
      db.users.push(user);
      write(db);
      return user;
    },
    async setUserRole(id, role) {
      const db = read();
      const user = db.users.find(u => u.id === id);
      if (!user) return null;
      user.role = role;
      write(db);
      return user;
    },

    async listClinics({ verifiedOnly = false } = {}) {
      const db = read();
      return db.clinics.filter(c => !verifiedOnly || c.verified).map(c => withDoctor(c, db.doctors)).filter(Boolean);
    },
    async getClinic(id) {
      const db = read();
      const clinic = db.clinics.find(c => c.id === id);
      return clinic ? withDoctor(clinic, db.doctors) : null;
    },
    async findClinicByAddress(address, excludeId) {
      return read().clinics.find(c => c.id !== excludeId && c.address.trim().toLowerCase() === address.trim().toLowerCase()) || null;
    },
    async createClinic(data) {
      const db = read();
      const clinic = { id: idFor(db.clinics), ...data, verified: false, createdAt: new Date().toISOString() };
      db.clinics.push(clinic);
      write(db);
      return withDoctor(clinic, db.doctors);
    },
    async updateClinic(id, patch) {
      const db = read();
      const clinic = db.clinics.find(c => c.id === id);
      if (!clinic) return null;
      Object.assign(clinic, patch);
      write(db);
      return withDoctor(clinic, db.doctors);
    },
    async verifyClinic(id) {
      const db = read();
      const clinic = db.clinics.find(c => c.id === id);
      if (!clinic) return null;
      clinic.verified = true;
      clinic.verifiedAt = new Date().toISOString();
      write(db);
      return withDoctor(clinic, db.doctors);
    },
    async deleteClinic(id) {
      const db = read();
      const index = db.clinics.findIndex(c => c.id === id);
      if (index === -1) return false;
      db.clinics.splice(index, 1);
      write(db);
      return true;
    },

    async listAppointmentsForUser(userId) {
      const db = read();
      return db.appointments.filter(a => a.userId === userId)
        .map(a => ({ ...a, doctor: db.doctors.find(d => d.id === a.doctorId) }));
    },
    async appointmentStats(userId) {
      const mine = read().appointments.filter(a => a.userId === userId);
      return { total: mine.length, noShows: mine.filter(a => a.status === "No-show").length };
    },
    async createAppointment({ userId, doctorId, providerName, providerAddress, providerSource, date, notes, status }) {
      const db = read();
      const appointment = {
        id: idFor(db.appointments), userId, doctorId: doctorId || null,
        ...(doctorId ? {} : { providerName, providerAddress, providerSource }),
        date, notes, status, createdAt: new Date().toISOString()
      };
      db.appointments.push(appointment);
      write(db);
      return appointment;
    },

    async listOrdersForUser(userId) { return read().orders.filter(o => o.userId === userId); },
    async createOrder({ userId, items, total, status }) {
      const db = read();
      const order = { id: idFor(db.orders), userId, items, total, status, createdAt: new Date().toISOString() };
      db.orders.push(order);
      write(db);
      return order;
    },

    async getLoginLock(email) {
      const entry = lockouts.get(email);
      return entry && entry.until && entry.until > Date.now() ? { locked: true, until: new Date(entry.until) } : { locked: false };
    },
    async recordLoginFailure(email, { maxFailures, lockMs }) {
      const entry = lockouts.get(email) || { failures: 0, until: 0 };
      if (entry.until && entry.until <= Date.now()) { entry.failures = 0; entry.until = 0; }
      entry.failures += 1;
      if (entry.failures >= maxFailures) entry.until = Date.now() + lockMs;
      lockouts.set(email, entry);
      return entry.until ? { locked: true, until: new Date(entry.until) } : { locked: false };
    },
    async clearLoginFailures(email) { lockouts.delete(email); }
  };
}

module.exports = { createJsonStore };
