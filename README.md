# Kytez ATS

A small, private applicant tracking system for Kytez Recruitment:

- **Public "Apply" page** (`/`) — candidates submit name, contact info, sector,
  role, resume (PDF/Word), and an optional note.
- **Private admin dashboard** (`/admin`) — password-protected. Staff sign in
  to see every application on a pipeline board (Applied → Screening →
  Interview → Offer → Hired/Rejected), open a candidate to read their resume
  and cover note, move them between stages, and leave internal notes.
- Nothing on `/admin` is visible to the public — it requires a login, and
  the API behind it rejects any request without a valid session.

## How data is stored

Everything (applications, resumes, admin accounts) lives in a Postgres
database. Resumes are stored directly in the database as binary data — no
third-party file storage needed.

## Local development

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL etc.
npm start
```

Visit `http://localhost:3000` for the apply form and
`http://localhost:3000/admin` for the dashboard.

The first time the app starts against an empty database, it automatically
creates one admin account using `ADMIN_EMAIL` / `ADMIN_PASSWORD` /
`ADMIN_NAME` from your environment (defaults to `admin@kytez.com.au` with a
random password if you don't set one — check the server log). Once you can
log in, use the **Team** button in the dashboard to add every other owner
who needs access, and change your own password.

## Deploying

This app is deployed on Render (one web service + one Postgres database).
See `.env.example` for the environment variables the web service needs.

**Important:** a Render *free* Postgres database is automatically deleted
30 days after creation. For a real business tool holding applicant data,
upgrade the database to a paid plan (Starter, a few dollars/month) before
that 30-day window closes, from the Render dashboard.

## Adding this to the kytez.com.au website

You don't need to touch the existing site's code or hosting. Once deployed
you'll have one live URL for this app (e.g. `https://kytez-ats.onrender.com`,
or a custom subdomain like `apply.kytez.com.au` if you point DNS at it).
From there, either of these works and can be added by whoever manages the
website in a couple of minutes:

**Option A — a link/button (simplest).** Add a normal link or button
anywhere on the existing site — a "Careers" nav item, a button on the
`/job-seekers` page — pointing at the apply URL, e.g.:

```html
<a href="https://kytez-ats.onrender.com">Apply now</a>
```

**Option B — embed the form directly on an existing page**, e.g. inside
`/job-seekers`, using an iframe. Most site builders (WordPress, Squarespace,
Wix) have an "embed HTML" or "custom code" block you can paste this into:

```html
<iframe src="https://kytez-ats.onrender.com"
        style="width:100%; max-width:640px; height:900px; border:0;">
</iframe>
```

The admin dashboard (`/admin`) is **never** linked from the public site —
only people who know that URL and have a login can reach it. Bookmark it
for the people who need it.
