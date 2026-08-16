const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      sector TEXT,
      position TEXT,
      cover_letter TEXT,
      resume_filename TEXT,
      resume_mimetype TEXT,
      resume_data BYTEA,
      stage TEXT NOT NULL DEFAULT 'applied',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(stage);
  `);

  // Seed the first admin account if none exist yet.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (rows[0].count === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@kytez.com.au').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || Math.random().toString(36).slice(-12);
    const name = process.env.ADMIN_NAME || 'Admin';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO admin_users (email, password_hash, name) VALUES ($1, $2, $3)',
      [email, hash, name]
    );
    console.log('================================================');
    console.log('Created initial admin account:');
    console.log('  Email:   ', email);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('  Password:', password, '(auto-generated — set ADMIN_PASSWORD env var to control this, then log in and change it)');
    } else {
      console.log('  Password: (set via ADMIN_PASSWORD env var)');
    }
    console.log('================================================');
  }
}

module.exports = { pool, initSchema };
