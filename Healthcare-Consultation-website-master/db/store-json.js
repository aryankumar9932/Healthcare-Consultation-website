// JSON-file store: zero-setup development/demo driver. Same async interface as the PostgreSQL store.
const fs = require("fs");
const path = require("path");
const { seed } = require("./seed");

function createJsonStore(dbFile) {
  const lockouts = new Map(); // dev-only, in memory
  let memorySessions = null;
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
    sessionStore(session) { memorySessions = memorySessions || new session.MemoryStore(); return memorySessions; },
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
    async createUser({ name, email, phone, password, dateOfBirth }) {
      const db = read();
      if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return null; // duplicate
      const user = { id: idFor(db.users), name, email, phone, password, ...(dateOfBirth ? { dateOfBirth } : {}), createdAt: new Date().toISOString() };
      db.users.push(user);
      write(db);
      return user;
    },
    async createDoctorUser({ name, email, phone, password, doctorId }) {
      const db = read();
      if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase()) ||
          db.users.some(u => u.doctorId === doctorId)) return null;
      const user = {
        id: idFor(db.users), name, email, phone, password, role: "doctor", doctorId,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      write(db);
      return user;
    },
    async listDoctorsWithoutAccount() {
      const db = read();
      const assigned = new Set(db.users.filter(user => user.role === "doctor").map(user => user.doctorId));
      return db.doctors.filter(doctor => !assigned.has(doctor.id));
    },
    async getDoctorByUserId(userId) {
      const db = read();
      const account = db.users.find(user => user.id === userId && user.role === "doctor");
      return account ? db.doctors.find(doctor => doctor.id === account.doctorId) || null : null;
    },
    async getDoctorAccountId(doctorId) {
      return read().users.find(user => user.role === "doctor" && user.doctorId === doctorId)?.id || null;
    },
    // ---- email verification / password reset ----
    async createAuthToken({ userId, purpose, hash, expiresAt }) {
      const db = read();
      db.authTokens = (db.authTokens || []).filter(t => !(t.userId === userId && t.purpose === purpose && !t.usedAt));
      db.authTokens.push({ id: idFor(db.authTokens), userId, purpose, hash, expiresAt: new Date(expiresAt).toISOString(), createdAt: new Date().toISOString() });
      write(db);
    },
    async consumeAuthToken(hash, purpose) {
      const db = read();
      const token = (db.authTokens || []).find(t => t.hash === hash && t.purpose === purpose && !t.usedAt && Date.parse(t.expiresAt) > Date.now());
      if (!token) return null;
      token.usedAt = new Date().toISOString();
      write(db);
      return { userId: token.userId };
    },
    async revokeAuthTokens(userId, purpose) {
      const db = read();
      db.authTokens = (db.authTokens || []).filter(t => !(t.userId === userId && t.purpose === purpose && !t.usedAt));
      write(db);
    },
    async lastAuthTokenIssuedAt(userId, purpose) {
      const times = (read().authTokens || []).filter(t => t.userId === userId && t.purpose === purpose).map(t => Date.parse(t.createdAt));
      return times.length ? new Date(Math.max(...times)) : null;
    },
    async markEmailVerified(userId) {
      const db = read();
      const user = db.users.find(u => u.id === userId);
      if (!user) return null;
      if (!user.emailVerifiedAt) { user.emailVerifiedAt = new Date().toISOString(); write(db); }
      return user;
    },
    async setUserPassword(userId, passwordHash) {
      const db = read();
      const user = db.users.find(u => u.id === userId);
      if (!user) return null;
      user.password = passwordHash;
      write(db);
      return user;
    },
    async destroyUserSessions(userId, exceptSid) {
      if (!memorySessions) return;
      const sessions = await new Promise((resolve, reject) => memorySessions.all((error, all) => (error ? reject(error) : resolve(all || {}))));
      const doomed = Object.entries(sessions).filter(([sid, data]) => data && Number(data.userId) === userId && sid !== exceptSid).map(([sid]) => sid);
      await Promise.all(doomed.map(sid => new Promise(resolve => memorySessions.destroy(sid, resolve))));
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
    async createAppointment({ userId, doctorId, providerName, providerAddress, providerSource, date, notes, symptoms, status }) {
      const db = read();
      const appointment = {
        id: idFor(db.appointments), userId, doctorId: doctorId || null,
        ...(doctorId ? {} : { providerName, providerAddress, providerSource }),
        date, notes, symptoms: symptoms || "", consultationNotes: "", status, paymentStatus: "unpaid", createdAt: new Date().toISOString()
      };
      db.appointments.push(appointment);
      write(db);
      return appointment;
    },
    async getAppointmentForPatient(appointmentId, userId) {
      return read().appointments.find(a => a.id === appointmentId && a.userId === userId) || null;
    },
    async cancelAppointment(appointmentId, userId, expectedStatus) {
      const db = read();
      const a = db.appointments.find(item => item.id === appointmentId && item.userId === userId);
      if (!a || a.status !== expectedStatus) return null;
      a.status = "Cancelled";
      a.cancelledAt = new Date().toISOString();
      write(db);
      return a;
    },
    async rescheduleAppointment(appointmentId, userId, expectedStatus, date, newStatus) {
      const db = read();
      const a = db.appointments.find(item => item.id === appointmentId && item.userId === userId);
      if (!a || a.status !== expectedStatus) return null;
      a.date = date;
      a.status = newStatus;
      delete a.reminder24SentAt;
      delete a.reminder1SentAt;
      write(db);
      return a;
    },
    async listAppointmentsForDoctor(doctorId) {
      const db = read();
      return db.appointments.filter(appointment => appointment.doctorId === doctorId)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
        .map(appointment => ({
          ...appointment,
          patient: (() => {
            const { password, ...patient } = db.users.find(user => user.id === appointment.userId) || {};
            return patient.id ? patient : null;
          })(),
          doctor: db.doctors.find(doctor => doctor.id === doctorId)
        }));
    },
    async getAppointmentForParticipant(appointmentId, userId) {
      const db = read();
      const appointment = db.appointments.find(item => item.id === appointmentId);
      if (!appointment) return null;
      const user = db.users.find(item => item.id === userId);
      const doctorAccount = user?.role === "doctor" && user.doctorId === appointment.doctorId;
      if (appointment.userId !== userId && !doctorAccount) return null;
      const { password: patientPassword, ...patient } = db.users.find(item => item.id === appointment.userId) || {};
      return {
        ...appointment,
        patient: patient.id ? patient : null,
        doctor: db.doctors.find(item => item.id === appointment.doctorId) || null
      };
    },
    async listAppointmentsNeedingReminder(kind, fromIso, toIso) {
      const flag = kind === "24h" ? "reminder24SentAt" : "reminder1SentAt";
      return read().appointments.filter(a => a.status === "Accepted" && !a[flag] &&
        Date.parse(a.date) > Date.parse(fromIso) && Date.parse(a.date) <= Date.parse(toIso));
    },
    async markReminderSent(appointmentId, kind) {
      const flag = kind === "24h" ? "reminder24SentAt" : "reminder1SentAt";
      const db = read();
      const a = db.appointments.find(item => item.id === appointmentId);
      if (!a || a[flag]) return false;
      a[flag] = new Date().toISOString();
      write(db);
      return true;
    },
    async createReview({ appointmentId, userId, doctorId, rating, comment }) {
      const db = read();
      db.reviews ||= [];
      if (db.reviews.some(review => review.appointmentId === appointmentId)) return null;
      const review = { id: idFor(db.reviews), appointmentId, userId, doctorId, rating, comment, createdAt: new Date().toISOString() };
      db.reviews.push(review);
      write(db);
      return review;
    },
    async reviewedAppointmentIds(userId) {
      return (read().reviews || []).filter(review => review.userId === userId).map(review => review.appointmentId);
    },
    async listReviewsForDoctor(doctorId) {
      const db = read();
      return (db.reviews || []).filter(review => review.doctorId === doctorId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 100)
        .map(review => ({ id: review.id, rating: review.rating, comment: review.comment, createdAt: review.createdAt,
          authorName: String(db.users.find(user => user.id === review.userId)?.name || "Patient").split(" ")[0] }));
    },
    async doctorRatings() {
      const out = {};
      for (const review of read().reviews || []) {
        const aggregate = out[review.doctorId] ||= { sum: 0, count: 0 };
        aggregate.sum += review.rating;
        aggregate.count += 1;
      }
      return Object.fromEntries(Object.entries(out).map(([id, aggregate]) => [id, {
        average: Math.round(aggregate.sum / aggregate.count * 10) / 10, count: aggregate.count
      }]));
    },
    async setPaymentOrder(appointmentId, userId, orderId) {
      const db = read();
      const appointment = db.appointments.find(item => item.id === appointmentId && item.userId === userId);
      if (!appointment || appointment.paymentStatus === "paid") return null;
      appointment.paymentOrderId = orderId;
      appointment.paymentStatus ||= "unpaid";
      write(db);
      return appointment;
    },
    async markPaid(orderId, paymentId) {
      const db = read();
      const appointment = db.appointments.find(item => item.paymentOrderId === orderId);
      if (!appointment) return null;
      appointment.paymentStatus = "paid";
      appointment.paymentId = paymentId;
      write(db);
      return appointment;
    },
    async updateAppointmentStatus(appointmentId, doctorId, expectedStatus, status) {
      const db = read();
      const appointment = db.appointments.find(item => item.id === appointmentId && item.doctorId === doctorId);
      if (!appointment || appointment.status !== expectedStatus) return null;
      appointment.status = status;
      if (status === "Completed") appointment.completedAt = new Date().toISOString();
      write(db);
      return appointment;
    },
    async saveConsultation(appointmentId, doctorId, patientId, notes) {
      const db = read();
      const appointment = db.appointments.find(item => item.id === appointmentId &&
        item.doctorId === doctorId && item.userId === patientId);
      if (!appointment) return null;
      appointment.consultationNotes = notes;
      write(db);
      return appointment;
    },
    async savePrescription(appointmentId, doctorId, patientId, encryptedData) {
      const db = read();
      const appointment = db.appointments.find(item => item.id === appointmentId &&
        item.doctorId === doctorId && item.userId === patientId);
      if (!appointment) return null;
      let prescription = db.prescriptions.find(item => item.appointmentId === appointmentId);
      if (prescription) {
        prescription.encryptedData = encryptedData.toString("base64");
        prescription.createdAt = new Date().toISOString();
      } else {
        prescription = {
          id: idFor(db.prescriptions), appointmentId, patientId, doctorId: db.users.find(user => user.doctorId === doctorId && user.role === "doctor").id,
          encryptedData: encryptedData.toString("base64"), createdAt: new Date().toISOString()
        };
        db.prescriptions.push(prescription);
      }
      write(db);
      return { id: prescription.id, appointmentId, patientId, createdAt: prescription.createdAt };
    },
    async listPrescriptionsForPatient(patientId) {
      const db = read();
      return db.prescriptions.filter(item => item.patientId === patientId).map(item => ({
        id: item.id, appointmentId: item.appointmentId, patientId: item.patientId,
        doctorId: item.doctorId, encryptedData: Buffer.from(item.encryptedData, "base64"), createdAt: item.createdAt
      }));
    },
    async saveMedicalReport({ patientId, uploadedBy, filename, mimeType, encryptedData }) {
      const db = read();
      const report = {
        id: idFor(db.medicalReports), patientId, uploadedBy, filename, mimeType,
        encryptedData: encryptedData.toString("base64"), createdAt: new Date().toISOString()
      };
      db.medicalReports.push(report);
      write(db);
      return { id: report.id, patientId, filename, mimeType, createdAt: report.createdAt };
    },
    async listMedicalReportsForPatient(patientId) {
      return read().medicalReports.filter(report => report.patientId === patientId).map(report => ({
        id: report.id, patientId, filename: report.filename, mimeType: report.mimeType, createdAt: report.createdAt
      }));
    },
    async getMedicalReportForParticipant(reportId, userId) {
      const db = read();
      const report = db.medicalReports.find(item => item.id === reportId);
      if (!report) return null;
      const user = db.users.find(item => item.id === userId);
      const appointmentAccess = user?.role === "doctor" && db.appointments.some(item =>
        item.userId === report.patientId && item.doctorId === user.doctorId);
      if (report.patientId !== userId && !appointmentAccess) return null;
      return {
        id: report.id, patientId: report.patientId, filename: report.filename, mimeType: report.mimeType,
        encryptedData: Buffer.from(report.encryptedData, "base64"), createdAt: report.createdAt
      };
    },
    async doctorAnalytics(doctorId) {
      const appointments = read().appointments.filter(item => item.doctorId === doctorId);
      return {
        total: appointments.length,
        completed: appointments.filter(item => item.status === "Completed").length,
        pending: appointments.filter(item => item.status === "Pending").length
      };
    },
    async patientAnalytics(patientId) {
      const db = read();
      const appointments = db.appointments.filter(item => item.userId === patientId);
      return {
        appointments: appointments.length,
        completed: appointments.filter(item => item.status === "Completed").length,
        pending: appointments.filter(item => item.status === "Pending").length,
        reports: db.medicalReports.filter(item => item.patientId === patientId).length,
        prescriptions: db.prescriptions.filter(item => item.patientId === patientId).length
      };
    },
    async adminAnalytics() {
      const db = read();
      const patients = db.users.filter(user => !user.role || user.role === "patient");
      const appointments = db.appointments;
      const specialtyCounts = new Map();
      const symptomCounts = new Map();
      for (const appointment of appointments) {
        const doctor = db.doctors.find(item => item.id === appointment.doctorId);
        if (doctor) specialtyCounts.set(doctor.specialty, (specialtyCounts.get(doctor.specialty) || 0) + 1);
        for (const term of String(appointment.symptoms || "").toLowerCase().match(/[a-z]{4,}/g) || []) {
          if (!["with", "from", "have", "that", "this", "when", "your", "been", "were", "pain"].includes(term)) {
            symptomCounts.set(term, (symptomCounts.get(term) || 0) + 1);
          }
        }
      }
      const completed = appointments.filter(item => item.status === "Completed").length;
      const now = new Date();
      const ageDistribution = { under18: 0, "18to39": 0, "40to64": 0, "65plus": 0, unavailable: 0 };
      for (const patient of patients) {
        if (!patient.dateOfBirth) { ageDistribution.unavailable += 1; continue; }
        const age = Math.floor((now - new Date(patient.dateOfBirth)) / 31557600000);
        const band = age < 18 ? "under18" : age < 40 ? "18to39" : age < 65 ? "40to64" : "65plus";
        ageDistribution[band] += 1;
      }
      return {
        totalPatients: patients.length,
        consultations: appointments.length,
        completed,
        completionRate: appointments.length ? Math.round(completed * 100 / appointments.length) : 0,
        mostRequestedSpecialty: [...specialtyCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || "Not available",
        ageDistribution,
        commonSymptoms: [...symptomCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([symptom, count]) => ({ symptom, count }))
      };
    },
    async updateDoctorAvailability(doctorId, schedule) {
      const db = read();
      const doctor = db.doctors.find(item => item.id === doctorId);
      if (!doctor) return null;
      doctor.schedule = schedule;
      write(db);
      return doctor;
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
