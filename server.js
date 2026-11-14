require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, initSchema } = require('./db');
const { sendEmployeeApplicationEmail, isEmailConfigured } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12 // 12 hours
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype);
    cb(ok ? null : new Error('Please upload a PDF or Word document.'), ok);
  }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---------- static public pages ----------
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/apply.html')));
app.get('/employers', (req, res) => res.sendFile(path.join(__dirname, 'public/apply.html')));
app.get('/full-application', (req, res) => res.sendFile(path.join(__dirname, 'public/full-application.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// public: list of currently open postings, shown in the Openings tab of the apply page
app.get('/api/postings/open', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, sector, location, employment_type, description
     FROM job_postings WHERE status = 'open' ORDER BY created_at DESC`
  );
  res.json({ postings: rows });
});

// ---------- public jobs API (read by the kytez.com.au marketing website) ----------
// Read-only, no login. Only returns postings with status 'open' and only public fields.
// CORS: set PUBLIC_API_ORIGINS to a comma-separated list of allowed site origins
// (e.g. "https://kytez.com.au,https://www.kytez.com.au"). If unset, any origin may read.
const PUBLIC_API_ORIGINS = (process.env.PUBLIC_API_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

function publicCors(req, res, next) {
  const origin = req.headers.origin;
  if (!PUBLIC_API_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && PUBLIC_API_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function toPublicJob(row, base) {
  return {
    id: row.id,
    title: row.title,
    sector: row.sector,
    location: row.location,
    employment_type: row.employment_type,
    description: row.description,
    posted_at: row.created_at,
    updated_at: row.updated_at,
    apply_url: `${base}/?job=${row.id}`
  };
}

const PUBLIC_JOB_FIELDS = 'id, title, sector, location, employment_type, description, created_at, updated_at';

app.use('/api/public', publicCors);

app.get('/api/public/jobs', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_JOB_FIELDS} FROM job_postings WHERE status = 'open' ORDER BY created_at DESC`
    );
    const base = publicBaseUrl(req);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ jobs: rows.map(r => toPublicJob(r, base)) });
  } catch (err) { next(err); }
});

app.get('/api/public/jobs/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Job not found.' });
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_JOB_FIELDS} FROM job_postings WHERE id = $1 AND status = 'open'`, [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Job not found or no longer open.' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ job: toPublicJob(rows[0], publicBaseUrl(req)) });
  } catch (err) { next(err); }
});

// ---------- public API ----------
function handleUpload(req, res, next) {
  upload.single('resume')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Could not upload that file.' });
    next();
  });
}

app.post('/api/apply', handleUpload, async (req, res) => {
  try {
    const { name, email, phone, sector, position, posting_id, cover_letter } = req.body;

    let finalPosition = position;
    let finalSector = sector;
    let postingId = null;

    // If the applicant picked a real job posting, snapshot its title/sector rather than
    // trusting free-text from the client, and remember which posting it was.
    if (posting_id) {
      const { rows } = await pool.query(
        `SELECT id, title, sector FROM job_postings WHERE id = $1 AND status = 'open'`,
        [posting_id]
      );
      const posting = rows[0];
      if (!posting) {
        return res.status(400).json({ error: 'That job posting is no longer open. Please refresh and try again.' });
      }
      finalPosition = posting.title;
      finalSector = posting.sector || sector;
      postingId = posting.id;
    }

    if (!name || !email || !finalPosition) {
      return res.status(400).json({ error: 'Name, email, and position are required.' });
    }
    const file = req.file;
    await pool.query(
      `INSERT INTO candidates
        (name, email, phone, sector, position, posting_id, cover_letter, resume_filename, resume_mimetype, resume_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [name, email, phone || null, finalSector || null, finalPosition, postingId, cover_letter || null,
       file ? file.originalname : null, file ? file.mimetype : null, file ? file.buffer : null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('apply error', err);
    res.status(500).json({ error: 'Something went wrong submitting your application. Please try again.' });
  }
});

// ---------- full Kytez employee application (step 2, private link) ----------
// Staff generate a one-time link for a shortlisted candidate from the admin dashboard.
// The candidate opens /full-application?token=..., fills in the full form and uploads
// identity documents. The link stops working once the form has been submitted.

const PDF_TYPES = ['application/pdf'];
const RESUME_TYPES = ['application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const CERT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

const FULL_FORM_FILES = {
  resume: { types: RESUME_TYPES, max: 1, label: 'Resume' },
  supporting_documents: { types: CERT_TYPES, max: 5, label: 'Certificate / licence' },
  id_passport_or_birth_certificate: { types: PDF_TYPES, max: 1, label: 'Passport or birth certificate', id: true },
  id_visa_copy: { types: PDF_TYPES, max: 1, label: 'Visa copy', id: true },
  id_driver_licence_or_photo_id: { types: PDF_TYPES, max: 1, label: 'Driver licence or photo ID', id: true },
  id_medicare_or_other: { types: PDF_TYPES, max: 1, label: 'Medicare or other ID', id: true }
};

// Every text field the full form can send. Anything else in the body is ignored.
const FULL_FORM_FIELDS = [
  'first_name', 'last_name', 'preferred_name', 'date_of_birth', 'address', 'suburb', 'state', 'postcode',
  'phone', 'email', 'preferred_contact',
  'position', 'job_reference', 'employment_type', 'preferred_location', 'available_start_date', 'expected_pay',
  'work_rights', 'work_status', 'visa_subclass', 'visa_expiry', 'visa_conditions',
  'education', 'qualification', 'institution', 'year_completed', 'industry_experience', 'skills_experience',
  'most_recent_employer', 'most_recent_position', 'most_recent_dates', 'reason_for_leaving', 'duties_responsibilities',
  'previous_employer', 'previous_position', 'previous_dates', 'previous_reason_for_leaving', 'previous_duties',
  'other_licence_details', 'licence_expiry', 'preferred_hours', 'short_notice',
  'injury_affecting_role', 'injury_details',
  'workforce_australia', 'employment_provider', 'employment_support', 'employment_support_details',
  'provider_contact_consent',
  'referee1_name', 'referee1_company_position', 'referee1_relationship', 'referee1_phone', 'referee1_email',
  'referee2_name', 'referee2_company_position', 'referee2_relationship', 'referee2_phone', 'referee2_email',
  'reference_consent', 'declaration', 'privacy_recruitment_consent', 'privacy_sharing_consent',
  'future_contact_consent', 'applicant_full_name', 'submission_date'
];
const FULL_FORM_LISTS = ['shift_types', 'licences', 'availability'];

const fullFormUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10, fields: 200 },
  fileFilter: (req, file, cb) => {
    const spec = FULL_FORM_FILES[file.fieldname];
    if (!spec) return cb(new Error('Unexpected file field.'));
    if (!spec.types.includes(file.mimetype)) {
      return cb(new Error(spec.types === PDF_TYPES
        ? `${spec.label} must be a PDF file.`
        : `${spec.label}: that file type isn't accepted.`));
    }
    cb(null, true);
  }
}).fields(Object.entries(FULL_FORM_FILES).map(([name, spec]) => ({ name, maxCount: spec.max })));

function handleFullFormUpload(req, res, next) {
  fullFormUpload(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.' : (err.message || 'Could not upload those files.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

async function findCandidateByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, sector, position FROM candidates
     WHERE full_form_token = $1 AND full_form_submitted_at IS NULL`, [token]
  );
  return rows[0] || null;
}

// public: details used to prefill the full form
app.get('/api/full-application/:token', async (req, res, next) => {
  try {
    const c = await findCandidateByToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'This link is invalid, has expired, or has already been used.' });
    const [first, ...rest] = (c.name || '').trim().split(/\s+/);
    res.json({ first_name: first || '', last_name: rest.join(' '), email: c.email, phone: c.phone, position: c.position });
  } catch (err) { next(err); }
});

// public: submit the full form
app.post('/api/full-application/:token', handleFullFormUpload, async (req, res) => {
  const client = await pool.connect();
  try {
    const c = await findCandidateByToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'This link is invalid, has expired, or has already been used.' });

    const body = req.body || {};
    const data = {};
    FULL_FORM_FIELDS.forEach(f => {
      const v = body[f];
      if (typeof v === 'string' && v.trim()) data[f] = v.trim().slice(0, 5000);
    });
    FULL_FORM_LISTS.forEach(f => {
      let v = body[f] ?? body[f + '[]'];
      if (v === undefined) return;
      if (!Array.isArray(v)) v = [v];
      data[f] = v.filter(x => typeof x === 'string').map(x => x.slice(0, 200));
    });

    const missing = ['first_name', 'last_name', 'address', 'suburb', 'state', 'postcode', 'phone', 'email',
      'position', 'employment_type', 'work_rights', 'injury_affecting_role', 'declaration',
      'privacy_recruitment_consent', 'privacy_sharing_consent', 'applicant_full_name', 'submission_date']
      .filter(f => !data[f]);
    if (missing.length) return res.status(400).json({ error: 'Please complete all required fields.', missing });
    if (data.injury_affecting_role === 'Yes' && !data.injury_details) {
      return res.status(400).json({ error: 'Please give details of the injury or any adjustments needed.' });
    }

    const files = req.files || {};
    const needed = ['id_passport_or_birth_certificate', 'id_driver_licence_or_photo_id'];
    if (data.work_status === 'Temporary visa holder') needed.push('id_visa_copy');
    const missingFiles = needed.filter(f => !files[f] || !files[f].length);
    if (missingFiles.length) {
      return res.status(400).json({ error: 'Please upload: ' + missingFiles.map(f => FULL_FORM_FILES[f].label).join(', ') + '.' });
    }

    // Don't trust the browser's file type: PDFs must actually start with the PDF signature.
    for (const [field, list] of Object.entries(files)) {
      for (const f of list) {
        if (f.mimetype === 'application/pdf' && f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
          return res.status(400).json({ error: `${FULL_FORM_FILES[field].label}: "${f.originalname}" is not a valid PDF.` });
        }
      }
    }

    await client.query('BEGIN');
    for (const [field, list] of Object.entries(files)) {
      for (const f of list) {
        await client.query(
          `INSERT INTO candidate_documents (candidate_id, kind, filename, mimetype, size_bytes, data)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.id, field, f.originalname.slice(0, 255), f.mimetype, f.size, f.buffer]
        );
      }
    }
    await client.query(
      `UPDATE candidates
       SET full_form_data = $1, full_form_submitted_at = now(), full_form_token = NULL, updated_at = now()
       WHERE id = $2`,
      [data, c.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('full application error', err);
    res.status(500).json({ error: 'Something went wrong submitting your application. Please try again.' });
  } finally {
    client.release();
  }
});

// employers: submit a staffing request from the "Hire Staff" tab
app.post('/api/employer-requests', async (req, res) => {
  try {
    const {
      company_name, contact_name, email, phone, sector, roles_needed,
      staff_count, employment_type, start_date, pay_rate, shift_details, message
    } = req.body;

    if (!company_name || !contact_name || !email || !roles_needed) {
      return res.status(400).json({ error: 'Company name, contact name, email, and roles needed are required.' });
    }
    const staffCountNum = parseInt(staff_count, 10);

    await pool.query(
      `INSERT INTO employer_requests
        (company_name, contact_name, email, phone, sector, roles_needed, staff_count,
         employment_type, start_date, pay_rate, shift_details, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [company_name, contact_name, email, phone || null, sector || null, roles_needed,
       Number.isFinite(staffCountNum) ? staffCountNum : null, employment_type || null,
       start_date || null, pay_rate || null, shift_details || null, message || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('employer request error', err);
    res.status(500).json({ error: 'Something went wrong submitting your request. Please try again.' });
  }
});

// ---------- auth API ----------
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ authenticated: false });
  const { rows } = await pool.query('SELECT id, email, name FROM admin_users WHERE id = $1', [req.session.userId]);
  if (!rows[0]) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: rows[0] });
});

// change own password (must be logged in, must supply current password)
app.post('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.session.userId]);
  const user = rows[0];
  const match = await bcrypt.compare(currentPassword || '', user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  res.json({ ok: true });
});

// team management — any signed-in admin can view the team and add another owner/staff account
app.get('/api/admins', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, created_at FROM admin_users ORDER BY created_at ASC');
  res.json({ admins: rows });
});

app.post('/api/admins', requireAuth, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO admin_users (email, password_hash, name) VALUES ($1,$2,$3)',
      [email.toLowerCase().trim(), hash, name]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'An account with that email already exists.' });
    console.error('create admin error', err);
    res.status(500).json({ error: 'Could not create that account.' });
  }
});

// ---------- protected admin API ----------
const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
const POSTING_STATUSES = ['draft', 'open', 'closed'];
const EMPLOYER_STATUSES = ['new', 'contacted', 'closed'];

app.get('/api/candidates', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, sector, position, posting_id, cover_letter, stage, notes,
            resume_filename, created_at, updated_at,
            full_form_sent_at, full_form_emailed_at, full_form_submitted_at, (full_form_token IS NOT NULL) AS full_form_link_active
     FROM candidates ORDER BY created_at DESC`
  );
  res.json({ candidates: rows });
});

// job postings — the roles candidates can pick from in the Openings tab of the apply page
app.get('/api/postings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.sector, p.location, p.employment_type, p.description,
            p.status, p.created_at, p.updated_at,
            COUNT(c.id)::int AS applicant_count
     FROM job_postings p
     LEFT JOIN candidates c ON c.posting_id = p.id
     GROUP BY p.id
     ORDER BY p.created_at DESC`
  );
  res.json({ postings: rows });
});

app.post('/api/postings', requireAuth, async (req, res) => {
  const { title, sector, location, employment_type, description, status } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const finalStatus = POSTING_STATUSES.includes(status) ? status : 'open';
  const { rows } = await pool.query(
    `INSERT INTO job_postings (title, sector, location, employment_type, description, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [title, sector || null, location || null, employment_type || null, description || null, finalStatus]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.patch('/api/postings/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title, sector, location, employment_type, description, status } = req.body;
  if (status !== undefined && !POSTING_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const fields = [];
  const values = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); values.push(val); };
  if (title !== undefined) set('title', title);
  if (sector !== undefined) set('sector', sector);
  if (location !== undefined) set('location', location);
  if (employment_type !== undefined) set('employment_type', employment_type);
  if (description !== undefined) set('description', description);
  if (status !== undefined) set('status', status);
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at = now()');
  values.push(id);
  await pool.query(`UPDATE job_postings SET ${fields.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
});

// employer requests — staffing enquiries submitted through the "Hire Staff" tab
app.get('/api/employer-requests', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM employer_requests ORDER BY created_at DESC`
  );
  res.json({ requests: rows });
});

app.patch('/api/employer-requests/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (status !== undefined && !EMPLOYER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (status === undefined) return res.json({ ok: true });
  await pool.query('UPDATE employer_requests SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
  res.json({ ok: true });
});

app.patch('/api/candidates/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { stage, notes } = req.body;
    if (stage && !STAGES.includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage.' });
    }
    const before = await pool.query('SELECT stage FROM candidates WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Candidate not found.' });

    const fields = [];
    const values = [];
    let i = 1;
    if (stage !== undefined) { fields.push(`stage = $${i++}`); values.push(stage); }
    if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
    fields.push(`updated_at = now()`);
    values.push(id);
    await pool.query(`UPDATE candidates SET ${fields.join(', ')} WHERE id = $${i}`, values);

    // Just moved to Hired: create their private employee-application link and email it.
    let fullForm = null;
    if (stage === 'hired' && before.rows[0].stage !== 'hired') {
      fullForm = await issueFullFormLink(id, req);
    }
    res.json({ ok: true, fullForm });
  } catch (err) { next(err); }
});

// Creates a fresh one-time link for a hired candidate (disabling any older link) and
// emails it to the address they applied with. Returns { url, emailed, email, reason }.
async function issueFullFormLink(id, req) {
  const { rows } = await pool.query(
    'SELECT id, name, email, position, stage, full_form_submitted_at FROM candidates WHERE id = $1', [id]
  );
  const c = rows[0];
  if (!c) return { error: 'Candidate not found.' };
  if (c.stage !== 'hired') return { error: 'The employee application is only for hired candidates. Move this candidate to Hired first.' };
  if (c.full_form_submitted_at) return { error: 'This candidate has already submitted their employee application.', submitted: true };

  const token = crypto.randomBytes(32).toString('hex');
  const url = `${publicBaseUrl(req)}/full-application?token=${token}`;
  await pool.query(
    'UPDATE candidates SET full_form_token = $1, full_form_sent_at = now(), updated_at = now() WHERE id = $2',
    [token, c.id]
  );
  const mail = await sendEmployeeApplicationEmail({ to: c.email, name: c.name, position: c.position, url });
  if (mail.sent) await pool.query('UPDATE candidates SET full_form_emailed_at = now() WHERE id = $1', [c.id]);
  return { url, email: c.email, emailed: mail.sent, reason: mail.reason || null };
}

// full employee application: create (or replace) the private link. Only for hired candidates.
app.post('/api/candidates/:id/full-form-link', requireAuth, async (req, res, next) => {
  try {
    const result = await issueFullFormLink(req.params.id, req);
    if (result.error) return res.status(result.error === 'Candidate not found.' ? 404 : 400).json(result);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// full employee application: answers + list of uploaded documents (no file contents)
app.get('/api/candidates/:id/full-form', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT full_form_data, full_form_sent_at, full_form_submitted_at FROM candidates WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Candidate not found.' });
    const docs = await pool.query(
      `SELECT id, kind, filename, mimetype, size_bytes, created_at FROM candidate_documents
       WHERE candidate_id = $1 ORDER BY id`, [req.params.id]
    );
    res.json({
      data: rows[0].full_form_data,
      sent_at: rows[0].full_form_sent_at,
      submitted_at: rows[0].full_form_submitted_at,
      documents: docs.rows.map(d => ({ ...d, label: (FULL_FORM_FILES[d.kind] || {}).label || d.kind, is_id: !!(FULL_FORM_FILES[d.kind] || {}).id }))
    });
  } catch (err) { next(err); }
});

// download one uploaded document
app.get('/api/documents/:docId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT filename, mimetype, data FROM candidate_documents WHERE id = $1', [req.params.docId]);
    const d = rows[0];
    if (!d) return res.status(404).send('Document not found.');
    res.setHeader('Content-Type', d.mimetype || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${(d.filename || 'document').replace(/["\r\n]/g, '')}"`);
    res.send(d.data);
  } catch (err) { next(err); }
});

// delete a candidate's identity documents once they've been verified
app.delete('/api/candidates/:id/id-documents', requireAuth, async (req, res, next) => {
  try {
    const idKinds = Object.entries(FULL_FORM_FILES).filter(([, s]) => s.id).map(([k]) => k);
    const result = await pool.query(
      'DELETE FROM candidate_documents WHERE candidate_id = $1 AND kind = ANY($2)', [req.params.id, idKinds]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) { next(err); }
});

app.get('/api/candidates/:id/resume', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT resume_filename, resume_mimetype, resume_data FROM candidates WHERE id = $1',
    [req.params.id]
  );
  const c = rows[0];
  if (!c || !c.resume_data) return res.status(404).send('No resume on file.');
  res.setHeader('Content-Type', c.resume_mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(c.resume_filename || 'resume').replace(/"/g, '')}"`);
  res.send(c.resume_data);
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT stage, COUNT(*)::int AS count FROM candidates GROUP BY stage`
  );
  const byStage = Object.fromEntries(rows.map(r => [r.stage, r.count]));
  const total = await pool.query('SELECT COUNT(*)::int AS count FROM candidates');
  const newThisWeek = await pool.query(
    `SELECT COUNT(*)::int AS count FROM candidates WHERE created_at > now() - interval '7 days'`
  );
  const hiredThisMonth = await pool.query(
    `SELECT COUNT(*)::int AS count FROM candidates WHERE stage = 'hired' AND updated_at > date_trunc('month', now())`
  );
  res.json({
    total: total.rows[0].count,
    newThisWeek: newThisWeek.rows[0].count,
    hiredThisMonth: hiredThisMonth.rows[0].count,
    byStage
  });
});

// generic fallback error handler (keeps errors as JSON, never leaks stack traces)
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Kytez ATS listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema', err);
    process.exit(1);
  });
