# Kytez ATS — Public Jobs API

For the kytez.com.au marketing website. Any job set to **Open** in the ATS
admin (`/admin` → Postings) appears here automatically. Draft and Closed jobs
are never returned. No login or API key is needed — it's read-only.

Base URL: `https://kytez-ats.kytez.com.au`

## Endpoints

### `GET /api/public/jobs`
All open jobs, newest first.

```json
{
  "jobs": [
    {
      "id": 12,
      "title": "Casual Cleaner",
      "sector": "Cleaning",
      "location": "Melbourne VIC",
      "employment_type": "Casual",
      "description": "Clean offices ...",
      "posted_at": "2026-11-11T13:28:51.286Z",
      "updated_at": "2026-11-11T13:28:51.286Z",
      "apply_url": "https://kytez-ats.kytez.com.au/?job=12"
    }
  ]
}
```

`jobs` is an empty array when nothing is open — show a "No current openings" message.
Any field except `id`, `title` and `apply_url` may be `null`.

### `GET /api/public/jobs/:id`
One open job: `{ "job": { ...same fields... } }`.
Returns **404** if the job doesn't exist or is no longer open.

## Applying

Point each job's **Apply** button at its `apply_url`. That opens the ATS apply
page with the role pre-selected, where the candidate fills in their details and
**uploads their resume** (PDF or Word, up to 10 MB). The application lands
straight in the ATS pipeline linked to that job.

## Example (plain JavaScript, paste into the jobs page)

```html
<div id="kytez-jobs">Loading jobs…</div>
<script>
fetch('https://kytez-ats.kytez.com.au/api/public/jobs')
  .then(r => r.json())
  .then(({ jobs }) => {
    const el = document.getElementById('kytez-jobs');
    if (!jobs.length) { el.textContent = 'No current openings — check back soon.'; return; }
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    el.innerHTML = jobs.map(j => `
      <div class="job">
        <h3>${esc(j.title)}</h3>
        <p>${[j.location, j.employment_type, j.sector].filter(Boolean).map(esc).join(' · ')}</p>
        <p>${esc(j.description)}</p>
        <a href="${esc(j.apply_url)}" target="_blank" rel="noopener">Apply</a>
      </div>`).join('');
  })
  .catch(() => { document.getElementById('kytez-jobs').textContent = 'Couldn’t load jobs right now.'; });
</script>
```

## Notes
- Responses are cacheable for 60 seconds, so a newly opened job shows up within about a minute.
- CORS is open to any site by default. To restrict it, set the env var
  `PUBLIC_API_ORIGINS=https://kytez.com.au,https://www.kytez.com.au` on Render.
- Optional env var `PUBLIC_BASE_URL=https://kytez-ats.kytez.com.au` makes sure
  `apply_url` always uses the custom domain.
