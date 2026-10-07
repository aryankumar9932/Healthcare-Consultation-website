const { createJsonStore } = require("./store-json");
const { createPgStore } = require("./store-pg");

// DATABASE_URL selects PostgreSQL; otherwise fall back to the JSON file (development/demo only).
function createStore({ dbFile }) {
  if (process.env.DATABASE_URL) {
    const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" } : undefined;
    return createPgStore(process.env.DATABASE_URL, { ssl });
  }
  if (process.env.NODE_ENV === "production") {
    console.warn("WARNING: running in production with the JSON file store. Set DATABASE_URL to use PostgreSQL.");
  }
  return createJsonStore(dbFile);
}

module.exports = { createStore };
