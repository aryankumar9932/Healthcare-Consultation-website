// PostgreSQL store. Same async interface as the JSON store.
const { Pool } = require("pg");
const { migrate } = require("./migrate");
const { seed } = require("./seed");

const iso = value => (value instanceof Date ? value.toISOString() : value);
const num = value => (value === null || value === undefined ? value : Number(value));

const mapUser = r => r && ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, password: r.password,
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
  date: iso(r.scheduled_for), notes: r.notes, status: r.status, createdAt: iso(r.created_at)
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
    async createUser({ name, email, phone, password }) {
      try {
        const { rows } = await q("INSERT INTO users(name,email,phone,password) VALUES ($1,$2,$3,$4) RETURNING *", [name, email, phone, password]);
        return mapUser(rows[0]);
      } catch (error) {
        if (error.code === "23505") return null; // unique violation: duplicate email
        throw error;
      }
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
    async createAppointment({ userId, doctorId, providerName, providerAddress, providerSource, date, notes, status }) {
      const { rows } = await q(`INSERT INTO appointments(user_id,doctor_id,provider_name,provider_address,provider_source,scheduled_for,notes,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [userId, doctorId || null, doctorId ? null : providerName, doctorId ? null : providerAddress, doctorId ? null : providerSource, new Date(date), notes, status]);
      return mapAppointment(rows[0]);
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
