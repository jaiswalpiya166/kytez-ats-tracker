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
    CREATE TABLE IF NOT EXISTS job_postings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      sector TEXT,
      location TEXT,
      employment_type TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employer_requests (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      sector TEXT,
      roles_needed TEXT NOT NULL,
      staff_count INTEGER,
      employment_type TEXT,
      start_date TEXT,
      pay_rate TEXT,
      shift_details TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_employer_requests_status ON employer_requests(status);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      sector TEXT,
      position TEXT,
      posting_id INTEGER REFERENCES job_postings(id) ON DELETE SET NULL,
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

  // In case this is an existing database created before posting_id existed.
  await pool.query(`
    ALTER TABLE candidates ADD COLUMN IF NOT EXISTS posting_id INTEGER REFERENCES job_postings(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(stage);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_candidates_posting ON candidates(posting_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_postings_status ON job_postings(status);
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

  // One-time admin credential reset. Only runs when RESET_ADMIN_PASSWORD=true is set
  // as an env var (together with ADMIN_EMAIL and ADMIN_PASSWORD). Use this to recover
  // access if the admin login is lost. After confirming you can log in, set
  // RESET_ADMIN_PASSWORD back to false so a later deploy can't silently overwrite a
  // password you've since changed from inside the dashboard.
  if (process.env.RESET_ADMIN_PASSWORD === 'true' && process.env.ADMIN_PASSWORD) {
    const resetEmail = (process.env.ADMIN_EMAIL || 'admin@kytez.com.au').toLowerCase().trim();
    const resetName = process.env.ADMIN_NAME || 'Admin';
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    const { rows: existing } = await pool.query('SELECT id FROM admin_users WHERE email = $1', [resetEmail]);
    if (existing[0]) {
      await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, existing[0].id]);
      console.log('================================================');
      console.log('RESET_ADMIN_PASSWORD: password reset for', resetEmail);
      console.log('================================================');
    } else {
      await pool.query(
        'INSERT INTO admin_users (email, password_hash, name) VALUES ($1, $2, $3)',
        [resetEmail, hash, resetName]
      );
      console.log('================================================');
      console.log('RESET_ADMIN_PASSWORD: created new admin account', resetEmail);
      console.log('================================================');
    }
  }
}

module.exports = { pool, initSchema };
