// PostgreSQL store. Same async interface as the JSON store.
const { Pool } = require("pg");
const { migrate } = require("./migrate");
const { seed } = require("./seed");

const iso = value => (value instanceof Date ? value.toISOString() : value);
const num = value => (value === null || value === undefined ? value : Number(value));

const mapUser = r => r && ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, password: r.password,
  ...(r.doctor_id ? { doctorId: r.doctor_id } : {}),
  ...(r.date_of_birth ? { dateOfBirth: iso(r.date_of_birth) } : {}),
  ...(r.email_verified_at ? { emailVerifiedAt: iso(r.email_verified_at) } : {}),
  ...(r.role !== "patient" ? { role: r.role } : {}), createdAt: iso(r.created_at)
});
const mapDoctor = r => r && ({
  id: r.id, departmentId: r.department_id, name: r.name, specialty: r.specialty, bio: r.bio,
  fee: r.fee, image: r.image, schedule: r.schedule
});
const mapClinic = r => r && ({
  id: r.id, doctorId: r.doctor_id, name: r.name, address: r.address,
  latitude: r.latitude, longitude: r.longitude, verified: r.verified,
  ...(r.verified_at ? { verifiedAt: iso(r.verified_at) } : {}), createdAt: iso(r.created_at)
});
const CLINIC_DOCTOR_SQL = `
  SELECT c.*, d.department_id AS d_department_id, d.name AS d_name, d.specialty AS d_specialty,
         d.bio AS d_bio, d.fee AS d_fee, d.image AS d_image, d.schedule AS d_schedule
  FROM clinics c JOIN doctors d ON d.id = c.doctor_id`;
const mapClinicWithDoctor = r => r && ({
  ...mapClinic(r),
  doctor: mapDoctor({ id: r.doctor_id, department_id: r.d_department_id, name: r.d_name, specialty: r.d_specialty,
    bio: r.d_bio, fee: r.d_fee, image: r.d_image, schedule: r.d_schedule })
});
const mapAppointment = r => r && ({
  id: r.id, userId: r.user_id, doctorId: r.doctor_id,
  ...(r.doctor_id ? {} : { providerName: r.provider_name, providerAddress: r.provider_address, providerSource: r.provider_source }),
  date: iso(r.scheduled_for), notes: r.notes, symptoms: r.symptoms || "",
  consultationNotes: r.consultation_notes || "", completedAt: iso(r.completed_at),
  status: r.status, createdAt: iso(r.created_at), cancelledAt: iso(r.cancelled_at),
  paymentStatus: r.payment_status, paymentOrderId: r.payment_order_id
});

function createPgStore(connectionString, options = {}) {
  const pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10), ssl: options.ssl });
  const q = (text, params) => pool.query(text, params);

  async function seedCatalogue() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727275)");
      if (!(await client.query("SELECT 1 FROM departments LIMIT 1")).rowCount) {
        for (const d of seed.departments) {
          await client.query("INSERT INTO departments(id,title,description,image) VALUES ($1,$2,$3,$4)", [d.id, d.title, d.description, d.image]);
        }
        for (const d of seed.doctors) {
          await client.query(`INSERT INTO doctors(id,department_id,name,specialty,bio,fee,image,schedule)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [d.id, d.departmentId, d.name, d.specialty, d.bio, d.fee, d.image, JSON.stringify(d.schedule)]);
        }
        await client.query("SELECT setval('departments_id_seq', (SELECT max(id) FROM departments))");
        await client.query("SELECT setval('doctors_id_seq', (SELECT max(id) FROM doctors))");
      }
      if (!(await client.query("SELECT 1 FROM products LIMIT 1")).rowCount) {
        for (const p of seed.products) {
          await client.query("INSERT INTO products(id,name,description,price,image) VALUES ($1,$2,$3,$4,$5)", [p.id, p.name, p.description, p.price, p.image]);
        }
        await client.query("SELECT setval('products_id_seq', (SELECT max(id) FROM products))");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    driver: "postgres",
    pool,
    sessionStore(session) {
      const PgSession = require("connect-pg-simple")(session);
      return new PgSession({ pool, tableName: "session", createTableIfMissing: false });
    },
    async init() { await migrate(pool); await seedCatalogue(); },
    async close() { await pool.end(); },
    async reset() {
      await q(`TRUNCATE order_items, orders, appointments, clinics, users, login_attempts, session RESTART IDENTITY CASCADE`);
    },

    async listDepartments() { return (await q("SELECT * FROM departments ORDER BY id")).rows; },
    async listDoctors(departmentId) {
      const { rows } = departmentId
        ? await q("SELECT * FROM doctors WHERE department_id=$1 ORDER BY id", [departmentId])
        : await q("SELECT * FROM doctors ORDER BY id");
      return rows.map(mapDoctor);
    },
    async getDoctor(id) { return mapDoctor((await q("SELECT * FROM doctors WHERE id=$1", [id])).rows[0]) || null; },
    async listProducts() {
      return (await q("SELECT * FROM products ORDER BY id")).rows.map(r => ({ ...r, price: num(r.price) }));
    },
    async getProductsByIds(ids) {
      if (!ids.length) return [];
      return (await q("SELECT * FROM products WHERE id = ANY($1::int[])", [ids])).rows.map(r => ({ ...r, price: num(r.price) }));
    },

    async getUserById(id) { return mapUser((await q("SELECT * FROM users WHERE id=$1", [id])).rows[0]) || null; },
    async getUserByEmail(email) {
      return mapUser((await q("SELECT * FROM users WHERE lower(email)=lower($1)", [email])).rows[0]) || null;
    },
    async createUser({ name, email, phone, password, dateOfBirth }) {
      try {
        const { rows } = await q("INSERT INTO users(name,email,phone,password,date_of_birth) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [name, email, phone, password, dateOfBirth || null]);
        return mapUser(rows[0]);
      } catch (error) {
        if (error.code === "23505") return null; // unique violation: duplicate email
        throw error;
      }
    },
    async createDoctorUser({ name, email, phone, password, doctorId }) {
      try {
        const { rows } = await q("INSERT INTO users(name,email,phone,password,role,doctor_id) VALUES ($1,$2,$3,$4,'doctor',$5) RETURNING *",
          [name, email, phone, password, doctorId]);
        return mapUser(rows[0]);
      } catch (error) {
        if (error.code === "23505") return null;
        throw error;
      }
    },
    async listDoctorsWithoutAccount() {
      return (await q("SELECT d.* FROM doctors d LEFT JOIN users u ON u.doctor_id=d.id WHERE u.id IS NULL ORDER BY d.name")).rows.map(mapDoctor);
    },
    async getDoctorByUserId(userId) {
      return mapDoctor((await q("SELECT d.* FROM doctors d JOIN users u ON u.doctor_id=d.id WHERE u.id=$1 AND u.role='doctor'", [userId])).rows[0]) || null;
    },
    async getDoctorAccountId(doctorId) {
      const { rows } = await q("SELECT id FROM users WHERE doctor_id=$1 AND role='doctor'", [doctorId]);
      return rows[0]?.id || null;
    },
    // ---- email verification / password reset ----
    async createAuthToken({ userId, purpose, hash, expiresAt }) {
      // At most one live token per user and purpose: issuing a new one revokes the previous link.
      await q("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL", [userId, purpose]);
      await q("DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'");
      await q("INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,$4)", [userId, purpose, hash, new Date(expiresAt)]);
    },
    // Atomically spends a token. Returns { userId } or null (unknown, expired, or already used).
    async consumeAuthToken(hash, purpose) {
      const { rows } = await q("UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [hash, purpose]);
      return rows[0] ? { userId: rows[0].user_id } : null;
    },
    async revokeAuthTokens(userId, purpose) {
      await q("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL", [userId, purpose]);
    },
    async lastAuthTokenIssuedAt(userId, purpose) {
      const { rows } = await q("SELECT max(created_at) AS at FROM auth_tokens WHERE user_id=$1 AND purpose=$2", [userId, purpose]);
      return rows[0].at ? new Date(rows[0].at) : null;
    },
    async markEmailVerified(userId) {
      return mapUser((await q("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING *", [userId])).rows[0]) || null;
    },
    async setUserPassword(userId, passwordHash) {
      return mapUser((await q("UPDATE users SET password=$2 WHERE id=$1 RETURNING *", [userId, passwordHash])).rows[0]) || null;
    },
    // Signs the user out everywhere, optionally keeping one session (the one making the change).
    async destroyUserSessions(userId, exceptSid) {
      await q("DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2", [String(userId), exceptSid || ""]);
    },

    async setUserRole(id, role) {
      return mapUser((await q("UPDATE users SET role=$2 WHERE id=$1 RETURNING *", [id, role])).rows[0]) || null;
    },

    async listClinics({ verifiedOnly = false } = {}) {
      const { rows } = await q(`${CLINIC_DOCTOR_SQL} ${verifiedOnly ? "WHERE c.verified" : ""} ORDER BY c.id`);
      return rows.map(mapClinicWithDoctor);
    },
    async getClinic(id) {
      return mapClinicWithDoctor((await q(`${CLINIC_DOCTOR_SQL} WHERE c.id=$1`, [id])).rows[0]) || null;
    },
    async findClinicByAddress(address, excludeId) {
      const { rows } = await q("SELECT * FROM clinics WHERE lower(trim(address))=lower(trim($1)) AND id IS DISTINCT FROM $2 LIMIT 1", [address, excludeId ?? null]);
      return mapClinic(rows[0]) || null;
    },
    async createClinic({ doctorId, name, address, latitude, longitude }) {
      const { rows } = await q("INSERT INTO clinics(doctor_id,name,address,latitude,longitude) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [doctorId, name, address, latitude, longitude]);
      return this.getClinic(rows[0].id);
    },
    async updateClinic(id, patch) {
      const map = { doctorId: "doctor_id", name: "name", address: "address", latitude: "latitude", longitude: "longitude", verified: "verified" };
      const sets = []; const values = [id];
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) { values.push(patch[key]); sets.push(`${column}=$${values.length}`); }
      }
      if (patch.verified === false) sets.push("verified_at=NULL");
      if (!sets.length) return this.getClinic(id);
      const { rowCount } = await q(`UPDATE clinics SET ${sets.join(",")} WHERE id=$1`, values);
      return rowCount ? this.getClinic(id) : null;
    },
    async verifyClinic(id) {
      const { rowCount } = await q("UPDATE clinics SET verified=true, verified_at=now() WHERE id=$1", [id]);
      return rowCount ? this.getClinic(id) : null;
    },
    async deleteClinic(id) { return (await q("DELETE FROM clinics WHERE id=$1", [id])).rowCount > 0; },

    async listAppointmentsForUser(userId) {
      const { rows } = await q(`SELECT a.*, d.department_id AS d_department_id, d.name AS d_name, d.specialty AS d_specialty,
          d.bio AS d_bio, d.fee AS d_fee, d.image AS d_image, d.schedule AS d_schedule
        FROM appointments a LEFT JOIN doctors d ON d.id=a.doctor_id WHERE a.user_id=$1 ORDER BY a.id`, [userId]);
      return rows.map(r => ({
        ...mapAppointment(r),
        doctor: r.doctor_id ? mapDoctor({ id: r.doctor_id, department_id: r.d_department_id, name: r.d_name, specialty: r.d_specialty,
          bio: r.d_bio, fee: r.d_fee, image: r.d_image, schedule: r.d_schedule }) : undefined
      }));
    },
    async appointmentStats(userId) {
      const { rows } = await q("SELECT count(*)::int AS total, count(*) FILTER (WHERE status='No-show')::int AS no_shows FROM appointments WHERE user_id=$1", [userId]);
      return { total: rows[0].total, noShows: rows[0].no_shows };
    },
    async createAppointment({ userId, doctorId, providerName, providerAddress, providerSource, date, notes, symptoms, status }) {
      const { rows } = await q(`INSERT INTO appointments(user_id,doctor_id,provider_name,provider_address,provider_source,scheduled_for,notes,symptoms,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [userId, doctorId || null, doctorId ? null : providerName, doctorId ? null : providerAddress, doctorId ? null : providerSource, new Date(date), notes, symptoms || "", status]);
      return mapAppointment(rows[0]);
    },
    async getAppointmentForPatient(appointmentId, userId) {
      const { rows } = await q("SELECT * FROM appointments WHERE id=$1 AND user_id=$2", [appointmentId, userId]);
      return mapAppointment(rows[0]) || null;
    },
    async cancelAppointment(appointmentId, userId, expectedStatus) {
      const { rows } = await q(`UPDATE appointments SET status='Cancelled', cancelled_at=now()
        WHERE id=$1 AND user_id=$2 AND status=$3 RETURNING *`, [appointmentId, userId, expectedStatus]);
      return mapAppointment(rows[0]) || null;
    },
    async rescheduleAppointment(appointmentId, userId, expectedStatus, date, newStatus) {
      const { rows } = await q(`UPDATE appointments SET scheduled_for=$4, status=$5,
        reminder_24h_sent_at=NULL, reminder_1h_sent_at=NULL
        WHERE id=$1 AND user_id=$2 AND status=$3 RETURNING *`, [appointmentId, userId, expectedStatus, date, newStatus]);
      return mapAppointment(rows[0]) || null;
    },
    async listAppointmentsNeedingReminder(kind, fromIso, toIso) {
      const col = kind === "24h" ? "reminder_24h_sent_at" : "reminder_1h_sent_at";
      const { rows } = await q(`SELECT * FROM appointments WHERE status='Accepted' AND ${col} IS NULL
        AND scheduled_for > $1 AND scheduled_for <= $2`, [fromIso, toIso]);
      return rows.map(mapAppointment);
    },
    async markReminderSent(appointmentId, kind) {
      const col = kind === "24h" ? "reminder_24h_sent_at" : "reminder_1h_sent_at";
      const { rowCount } = await q(`UPDATE appointments SET ${col}=now() WHERE id=$1 AND ${col} IS NULL`, [appointmentId]);
      return rowCount === 1;
    },
    async createReview({ appointmentId, userId, doctorId, rating, comment }) {
      const { rows } = await q(`INSERT INTO reviews (appointment_id, user_id, doctor_id, rating, comment)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (appointment_id) DO NOTHING RETURNING *`, [appointmentId, userId, doctorId, rating, comment]);
      return rows[0] || null;
    },
    async reviewedAppointmentIds(userId) {
      return (await q("SELECT appointment_id FROM reviews WHERE user_id=$1", [userId])).rows.map(row => row.appointment_id);
    },
    async listReviewsForDoctor(doctorId) {
      const { rows } = await q(`SELECT r.id, r.rating, r.comment, r.created_at, split_part(u.name, ' ', 1) AS author_name
        FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.doctor_id=$1 ORDER BY r.created_at DESC LIMIT 100`, [doctorId]);
      return rows.map(row => ({ id: row.id, rating: row.rating, comment: row.comment, createdAt: iso(row.created_at), authorName: row.author_name }));
    },
    async doctorRatings() {
      const { rows } = await q("SELECT doctor_id, ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*)::int AS count FROM reviews GROUP BY doctor_id");
      return Object.fromEntries(rows.map(row => [row.doctor_id, { average: Number(row.average), count: row.count }]));
    },
    async setPaymentOrder(appointmentId, userId, orderId) {
      const { rows } = await q("UPDATE appointments SET payment_order_id=$3 WHERE id=$1 AND user_id=$2 AND payment_status<>'paid' RETURNING *", [appointmentId, userId, orderId]);
      return mapAppointment(rows[0]) || null;
    },
    async markPaid(orderId, paymentId) {
      const { rows } = await q("UPDATE appointments SET payment_status='paid', payment_id=$2 WHERE payment_order_id=$1 RETURNING *", [orderId, paymentId]);
      return mapAppointment(rows[0]) || null;
    },
    async listAppointmentsForDoctor(doctorId) {
      const { rows } = await q(`SELECT a.*, u.id AS p_id, u.name AS p_name, u.email AS p_email, u.phone AS p_phone,
          u.date_of_birth AS p_date_of_birth, d.department_id AS d_department_id, d.name AS d_name, d.specialty AS d_specialty,
          d.bio AS d_bio, d.fee AS d_fee, d.image AS d_image, d.schedule AS d_schedule
        FROM appointments a JOIN users u ON u.id=a.user_id LEFT JOIN doctors d ON d.id=a.doctor_id
        WHERE a.doctor_id=$1 ORDER BY a.scheduled_for`, [doctorId]);
      return rows.map(r => ({
        ...mapAppointment(r),
        patient: { id: r.p_id, name: r.p_name, email: r.p_email, phone: r.p_phone, dateOfBirth: iso(r.p_date_of_birth) },
        doctor: r.doctor_id ? mapDoctor({ id: r.doctor_id, department_id: r.d_department_id, name: r.d_name, specialty: r.d_specialty,
          bio: r.d_bio, fee: r.d_fee, image: r.d_image, schedule: r.d_schedule }) : null
      }));
    },
    async getAppointmentForParticipant(appointmentId, userId) {
      const { rows } = await q(`SELECT a.*, u.id AS p_id, u.name AS p_name, u.email AS p_email, u.phone AS p_phone,
          u.date_of_birth AS p_date_of_birth, d.department_id AS d_department_id, d.name AS d_name, d.specialty AS d_specialty,
          d.bio AS d_bio, d.fee AS d_fee, d.image AS d_image, d.schedule AS d_schedule
        FROM appointments a JOIN users u ON u.id=a.user_id LEFT JOIN doctors d ON d.id=a.doctor_id
        WHERE a.id=$1 AND (a.user_id=$2 OR EXISTS (SELECT 1 FROM users du WHERE du.id=$2 AND du.role='doctor' AND du.doctor_id=a.doctor_id))`,
      [appointmentId, userId]);
      const r = rows[0];
      if (!r) return null;
      return {
        ...mapAppointment(r),
        patient: { id: r.p_id, name: r.p_name, email: r.p_email, phone: r.p_phone, dateOfBirth: iso(r.p_date_of_birth) },
        doctor: r.doctor_id ? mapDoctor({ id: r.doctor_id, department_id: r.d_department_id, name: r.d_name, specialty: r.d_specialty,
          bio: r.d_bio, fee: r.d_fee, image: r.d_image, schedule: r.d_schedule }) : null
      };
    },
    async updateAppointmentStatus(appointmentId, doctorId, expectedStatus, status) {
      const { rows } = await q(`UPDATE appointments SET status=$3, completed_at=CASE WHEN $3='Completed' THEN now() ELSE completed_at END
        WHERE id=$1 AND doctor_id=$2 AND status=$4 RETURNING *`, [appointmentId, doctorId, status, expectedStatus]);
      return mapAppointment(rows[0]) || null;
    },
    async saveConsultation(appointmentId, doctorId, patientId, notes) {
      const { rows } = await q(`UPDATE appointments SET consultation_notes=$4
        WHERE id=$1 AND doctor_id=$2 AND user_id=$3 RETURNING *`, [appointmentId, doctorId, patientId, notes]);
      return mapAppointment(rows[0]) || null;
    },
    async savePrescription(appointmentId, doctorId, patientId, encryptedData) {
      const { rows } = await q(`INSERT INTO prescriptions(appointment_id,patient_id,doctor_user_id,encrypted_data)
        SELECT a.id,a.user_id,$2,$4 FROM appointments a JOIN users u ON u.id=$2 AND u.doctor_id=a.doctor_id
        WHERE a.id=$1 AND a.doctor_id=$3
        ON CONFLICT (appointment_id) DO UPDATE SET encrypted_data=EXCLUDED.encrypted_data, created_at=now()
        RETURNING id,appointment_id,patient_id,created_at`, [appointmentId, (await this.getDoctorAccountId(doctorId)), doctorId, encryptedData]);
      const r = rows[0];
      return r ? { id: r.id, appointmentId: r.appointment_id, patientId: r.patient_id, createdAt: iso(r.created_at) } : null;
    },
    async getDoctorAccountId(doctorId) {
      const { rows } = await q("SELECT id FROM users WHERE doctor_id=$1 AND role='doctor'", [doctorId]);
      return rows[0]?.id || null;
    },
    async listPrescriptionsForPatient(patientId) {
      const { rows } = await q("SELECT * FROM prescriptions WHERE patient_id=$1 ORDER BY created_at DESC", [patientId]);
      return rows.map(r => ({ id: r.id, appointmentId: r.appointment_id, patientId: r.patient_id, doctorId: r.doctor_user_id,
        encryptedData: r.encrypted_data, createdAt: iso(r.created_at) }));
    },
    async saveMedicalReport({ patientId, uploadedBy, filename, mimeType, encryptedData }) {
      const { rows } = await q(`INSERT INTO medical_reports(patient_id,uploaded_by,filename,mime_type,encrypted_data)
        VALUES ($1,$2,$3,$4,$5) RETURNING id,patient_id,filename,mime_type,created_at`,
      [patientId, uploadedBy, filename, mimeType, encryptedData]);
      const r = rows[0];
      return { id: r.id, patientId: r.patient_id, filename: r.filename, mimeType: r.mime_type, createdAt: iso(r.created_at) };
    },
    async listMedicalReportsForPatient(patientId) {
      const { rows } = await q("SELECT id,patient_id,filename,mime_type,created_at FROM medical_reports WHERE patient_id=$1 ORDER BY created_at DESC", [patientId]);
      return rows.map(r => ({ id: r.id, patientId: r.patient_id, filename: r.filename, mimeType: r.mime_type, createdAt: iso(r.created_at) }));
    },
    async getMedicalReportForParticipant(reportId, userId) {
      const { rows } = await q(`SELECT r.* FROM medical_reports r WHERE r.id=$1 AND
        (r.patient_id=$2 OR EXISTS (SELECT 1 FROM appointments a JOIN users u ON u.id=$2 AND u.role='doctor' AND u.doctor_id=a.doctor_id
          WHERE a.user_id=r.patient_id))`, [reportId, userId]);
      const r = rows[0];
      return r ? { id: r.id, patientId: r.patient_id, filename: r.filename, mimeType: r.mime_type,
        encryptedData: r.encrypted_data, createdAt: iso(r.created_at) } : null;
    },
    async doctorAnalytics(doctorId) {
      const { rows } = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='Completed')::int AS completed,
        count(*) FILTER (WHERE status='Pending')::int AS pending FROM appointments WHERE doctor_id=$1`, [doctorId]);
      return rows[0];
    },
    async patientAnalytics(patientId) {
      const { rows } = await q(`SELECT (SELECT count(*)::int FROM appointments WHERE user_id=$1) AS appointments,
        (SELECT count(*)::int FROM appointments WHERE user_id=$1 AND status='Completed') AS completed,
        (SELECT count(*)::int FROM appointments WHERE user_id=$1 AND status='Pending') AS pending,
        (SELECT count(*)::int FROM medical_reports WHERE patient_id=$1) AS reports,
        (SELECT count(*)::int FROM prescriptions WHERE patient_id=$1) AS prescriptions`, [patientId]);
      return rows[0];
    },
    async adminAnalytics() {
      const { rows } = await q(`WITH appointment_counts AS (
          SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='Completed')::int AS completed
          FROM appointments
        ), specialty_counts AS (
          SELECT d.specialty, count(*)::int AS count FROM appointments a JOIN doctors d ON d.id=a.doctor_id
          GROUP BY d.specialty ORDER BY count DESC, d.specialty LIMIT 1
        ), symptom_words AS (
          SELECT lower(word) AS symptom, count(*)::int AS count
          FROM appointments a CROSS JOIN LATERAL regexp_split_to_table(a.symptoms, '[^[:alpha:]]+') word
          WHERE length(word) >= 4 AND lower(word) NOT IN ('with','from','have','that','this','when','your','been','were','pain')
          GROUP BY lower(word) ORDER BY count DESC, symptom LIMIT 10
        )
        SELECT (SELECT count(*)::int FROM users WHERE role='patient') AS "totalPatients",
          c.total AS consultations, c.completed,
          CASE WHEN c.total=0 THEN 0 ELSE round(c.completed*100.0/c.total)::int END AS "completionRate",
          COALESCE((SELECT specialty FROM specialty_counts), 'Not available') AS "mostRequestedSpecialty",
          (SELECT json_agg(json_build_object('symptom',symptom,'count',count)) FROM symptom_words) AS "commonSymptoms",
          (SELECT json_build_object(
            'under18',count(*) FILTER (WHERE date_of_birth > current_date - interval '18 years')::int,
            '18to39',count(*) FILTER (WHERE date_of_birth <= current_date - interval '18 years' AND date_of_birth > current_date - interval '40 years')::int,
            '40to64',count(*) FILTER (WHERE date_of_birth <= current_date - interval '40 years' AND date_of_birth > current_date - interval '65 years')::int,
            '65plus',count(*) FILTER (WHERE date_of_birth <= current_date - interval '65 years')::int,
            'unavailable',count(*) FILTER (WHERE date_of_birth IS NULL)::int)
           FROM users WHERE role='patient') AS "ageDistribution"
        FROM appointment_counts c`);
      return { ...rows[0], commonSymptoms: rows[0].commonSymptoms || [] };
    },
    async updateDoctorAvailability(doctorId, schedule) {
      const { rows } = await q("UPDATE doctors SET schedule=$2 WHERE id=$1 RETURNING *", [doctorId, JSON.stringify(schedule)]);
      return mapDoctor(rows[0]) || null;
    },

    async listOrdersForUser(userId) {
      const { rows } = await q(`SELECT o.*, COALESCE(json_agg(json_build_object('productId', i.product_id, 'name', i.name,
          'quantity', i.quantity, 'price', i.price) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
        FROM orders o LEFT JOIN order_items i ON i.order_id=o.id WHERE o.user_id=$1 GROUP BY o.id ORDER BY o.id`, [userId]);
      return rows.map(r => ({ id: r.id, userId: r.user_id, items: r.items.map(i => ({ ...i, price: num(i.price) })),
        total: num(r.total), status: r.status, createdAt: iso(r.created_at) }));
    },
    async createOrder({ userId, items, total, status }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("INSERT INTO orders(user_id,total,status) VALUES ($1,$2,$3) RETURNING *", [userId, total, status]);
        for (const item of items) {
          await client.query("INSERT INTO order_items(order_id,product_id,name,quantity,price) VALUES ($1,$2,$3,$4,$5)",
            [rows[0].id, item.productId, item.name, item.quantity, item.price]);
        }
        await client.query("COMMIT");
        return { id: rows[0].id, userId, items, total, status, createdAt: iso(rows[0].created_at) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getLoginLock(email) {
      const { rows } = await q("SELECT locked_until FROM login_attempts WHERE email=$1 AND locked_until > now()", [email]);
      return rows[0] ? { locked: true, until: rows[0].locked_until } : { locked: false };
    },
    async recordLoginFailure(email, { maxFailures, lockMs }) {
      const { rows } = await q(`INSERT INTO login_attempts(email, failures, updated_at) VALUES ($1, 1, now())
        ON CONFLICT (email) DO UPDATE SET
          failures = CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.failures + 1 END,
          updated_at = now()
        RETURNING failures`, [email]);
      if (rows[0].failures >= maxFailures) {
        const lock = await q("UPDATE login_attempts SET locked_until = now() + ($2 || ' milliseconds')::interval WHERE email=$1 RETURNING locked_until", [email, String(lockMs)]);
        return { locked: true, until: lock.rows[0].locked_until };
      }
      return { locked: false };
    },
    async clearLoginFailures(email) { await q("DELETE FROM login_attempts WHERE email=$1", [email]); }
  };
}

module.exports = { createPgStore };
