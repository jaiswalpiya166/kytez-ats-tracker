// Sends emails from the ATS over SMTP (works with Microsoft 365, Google Workspace,
// SendGrid, Mailgun, Brevo, etc.). Configure with these environment variables on Render:
//
//   SMTP_HOST      e.g. smtp.office365.com, smtp.gmail.com, smtp.sendgrid.net
//   SMTP_PORT      587 (default) or 465
//   SMTP_USER      the SMTP username
//   SMTP_PASS      the SMTP password / app password / API key
//   MAIL_FROM      e.g. "Kytez Recruitment <careers@kytez.com.au>"  (defaults to SMTP_USER)
//   MAIL_REPLY_TO  optional reply-to address
//
// If SMTP_HOST isn't set, emails are skipped and staff can copy the link from the dashboard instead.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

function isEmailConfigured() { return !!process.env.SMTP_HOST; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendEmployeeApplicationEmail({ to, name, position, url }) {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'not_configured' };
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const role = position ? ` as ${position}` : '';
  const text =
`Hi ${first},

Congratulations! You've been hired${role} through Kytez Recruitment.

Before you start, please complete your employee application using this private link:

${url}

You'll need PDF copies of:
1. Your passport or Australian birth certificate
2. Your visa (if you're on a visa)
3. Your driver licence or photo ID
4. Your Medicare card or any other ID (optional)

This link is just for you and can only be used once, so please don't share it.

Kind regards,
Kytez Recruitment`;

  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#263442;max-width:560px">
  <p>Hi ${esc(first)},</p>
  <p>Congratulations! You've been hired${esc(role)} through Kytez Recruitment.</p>
  <p>Before you start, please complete your employee application using this private link:</p>
  <p style="margin:24px 0"><a href="${esc(url)}" style="background:#007c91;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">Complete my employee application</a></p>
  <p>You'll need PDF copies of:</p>
  <ol>
    <li>Your passport or Australian birth certificate</li>
    <li>Your visa (if you're on a visa)</li>
    <li>Your driver licence or photo ID</li>
    <li>Your Medicare card or any other ID (optional)</li>
  </ol>
  <p style="color:#637381;font-size:13px">This link is just for you and can only be used once, so please don't share it. If the button doesn't work, copy this address into your browser:<br>${esc(url)}</p>
  <p>Kind regards,<br>Kytez Recruitment</p>
</div>`;

  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      replyTo: process.env.MAIL_REPLY_TO || undefined,
      to,
      subject: 'Complete your Kytez employee application',
      text,
      html
    });
    return { sent: true };
  } catch (err) {
    console.error('email send error', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = { sendEmployeeApplicationEmail, isEmailConfigured };
