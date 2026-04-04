// src/db.js
import pkg from 'pg';
import dotenv from 'dotenv';
 
dotenv.config();
const { Pool } = pkg;

// Create a new pool using .env connection settings
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT || 5432,
});

// Quick connection test (optional)
pool.connect()
  .then(() => console.log("✅ Connected to Postgres"))
  .catch(err => console.error("❌ Postgres connection error", err));

/**
 * Export a helper function for queries
 */
export const query = (text, params) => pool.query(text, params);

// If you also want to use the pool directly:
export default pool;
