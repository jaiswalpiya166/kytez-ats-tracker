require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, initSchema } = require('./db');

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
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// public: list of currently open postings, shown in the Openings tab of the apply page
app.get('/api/postings/open', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, sector, location, employment_type, description
     FROM job_postings WHERE status = 'open' ORDER BY created_at DESC`
  );
  res.json({ postings: rows });
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

app.get('/api/candidates', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, sector, position, posting_id, cover_letter, stage, notes,
            resume_filename, created_at, updated_at
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

app.patch('/api/candidates/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { stage, notes } = req.body;
  if (stage && !STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Invalid stage.' });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (stage !== undefined) { fields.push(`stage = $${i++}`); values.push(stage); }
  if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
  fields.push(`updated_at = now()`);
  values.push(id);
  await pool.query(`UPDATE candidates SET ${fields.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
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
