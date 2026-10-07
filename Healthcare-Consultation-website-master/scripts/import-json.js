// One-off import of an existing data/db.json into PostgreSQL, preserving ids and password hashes.
// Usage: DATABASE_URL=postgres://... node scripts/import-json.js [path/to/db.json] [--force]
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { migrate } = require("../db/migrate");
const { seed } = require("../db/seed");

async function main() {
  const file = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || path.join(__dirname, "..", "data", "db.json");
  const force = process.argv.includes("--force");
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL first.");
  if (!fs.existsSync(file)) throw new Error(`Cannot find ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = (await client.query("SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM appointments) AS appts")).rows[0];
    if ((Number(existing.users) || Number(existing.appts)) && !force) {
      throw new Error("The database already contains users or appointments. Re-run with --force to wipe them and import.");
    }
    await client.query("TRUNCATE order_items, orders, appointments, clinics, users, doctors, departments, products RESTART IDENTITY CASCADE");

    const departments = data.departments?.length ? data.departments : seed.departments;
    const doctors = data.doctors?.length ? data.doctors : seed.doctors;
    const products = data.products?.length ? data.products : seed.products;
    for (const d of departments) await client.query("INSERT INTO departments(id,title,description,image) VALUES ($1,$2,$3,$4)", [d.id, d.title, d.description || "", d.image || ""]);
    for (const d of doctors) await client.query("INSERT INTO doctors(id,department_id,name,specialty,bio,fee,image,schedule) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [d.id, d.departmentId, d.name, d.specialty, d.bio || "", d.fee, d.image || "", JSON.stringify(d.schedule || [])]);
    for (const p of products) await client.query("INSERT INTO products(id,name,description,price,image) VALUES ($1,$2,$3,$4,$5)", [p.id, p.name, p.description || "", p.price, p.image || ""]);
    for (const u of data.users || []) await client.query("INSERT INTO users(id,name,email,phone,password,role,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [u.id, u.name, u.email, u.phone || "", u.password, u.role || "patient", u.createdAt || new Date()]);
    for (const c of data.clinics || []) await client.query("INSERT INTO clinics(id,doctor_id,name,address,latitude,longitude,verified,verified_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [c.id, c.doctorId, c.name, c.address, c.latitude, c.longitude, Boolean(c.verified), c.verifiedAt || null, c.createdAt || new Date()]);
    for (const a of data.appointments || []) await client.query(`INSERT INTO appointments(id,user_id,doctor_id,provider_name,provider_address,provider_source,scheduled_for,notes,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [a.id, a.userId, a.doctorId || null, a.providerName || null, a.providerAddress || null, a.providerSource || null, new Date(a.date), a.notes || "", a.status, a.createdAt || new Date()]);
    for (const o of data.orders || []) {
      await client.query("INSERT INTO orders(id,user_id,total,status,created_at) VALUES ($1,$2,$3,$4,$5)", [o.id, o.userId, o.total, o.status, o.createdAt || new Date()]);
      for (const i of o.items || []) await client.query("INSERT INTO order_items(order_id,product_id,name,quantity,price) VALUES ($1,$2,$3,$4,$5)", [o.id, i.productId, i.name, i.quantity, i.price]);
    }
    for (const t of ["departments", "doctors", "products", "users", "clinics", "appointments", "orders"]) {
      await client.query(`SELECT setval('${t}_id_seq', GREATEST((SELECT COALESCE(max(id),0) FROM ${t}), 1))`);
    }
    await client.query("COMMIT");
    console.log(`Imported ${(data.users || []).length} users, ${(data.appointments || []).length} appointments, ${(data.orders || []).length} orders, ${(data.clinics || []).length} clinics.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
