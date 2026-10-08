// Outgoing email. Transport is chosen from the environment:
//   SMTP_URL (smtps://user:pass@host:465) or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS  -> real delivery
//   MAIL_TRANSPORT=console  -> print messages (with links) to the server log; default outside production
//   MAIL_TRANSPORT=memory   -> keep messages in `outbox` only (tests)
//   MAIL_TRANSPORT=disabled -> send nothing; default in production when SMTP is not configured
const nodemailer = require("nodemailer");

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function createMailer(env = process.env) {
  const production = env.NODE_ENV === "production";
  const smtpConfigured = Boolean(env.SMTP_URL || env.SMTP_HOST);
  let mode = env.MAIL_TRANSPORT || (smtpConfigured ? "smtp" : production ? "disabled" : "console");
  if (mode === "smtp" && !smtpConfigured) mode = "disabled";
  const from = env.MAIL_FROM || "CareConnect <no-reply@careconnect.local>";
  const outbox = []; // always filled in memory/console modes (inspected by tests)
  let transport = null;

  if (mode === "smtp") {
    transport = nodemailer.createTransport(env.SMTP_URL || {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === "true",
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || "" } : undefined
    });
  }

  return {
    mode,
    outbox,
    // True when messages can actually reach a person (or a developer's console).
    canDeliver: mode === "smtp" || mode === "console" || mode === "memory",
    async send({ to, subject, text, html }) {
      const message = { from, to, subject, text, html };
      if (mode === "disabled") return { sent: false };
      if (mode === "smtp") {
        await transport.sendMail(message);
        return { sent: true };
      }
      outbox.push({ ...message, sentAt: new Date().toISOString() });
      if (outbox.length > 50) outbox.shift();
      if (mode === "console") console.log(`\n[mail:console] To: ${to}\nSubject: ${subject}\n${text}\n`);
      return { sent: true };
    },
    async verify() { if (transport) await transport.verify(); }
  };
}

// ---- message templates (links are always built from APP_URL, never from request headers) ----
const wrapHtml = (title, body) => `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#183b43;max-width:560px;margin:auto;padding:24px">
<h2 style="color:#087f83">${escapeHtml(title)}</h2>${body}
<p style="color:#6d8587;font-size:12px;margin-top:32px">CareConnect never asks for your password by email. If you did not expect this message you can ignore it.</p></body></html>`;
const button = (url, label) => `<p><a href="${escapeHtml(url)}" style="background:#087f83;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#6d8587">Or paste this link into your browser:<br>${escapeHtml(url)}</p>`;

const templates = {
  verifyEmail: ({ name, url, hours }) => ({
    subject: "Confirm your CareConnect email address",
    text: `Hi ${name},\n\nConfirm your email address to book appointments and upload reports:\n${url}\n\nThis link works once and expires in ${hours} hours.\nIf you did not create a CareConnect account, ignore this email.`,
    html: wrapHtml("Confirm your email", `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email address to book appointments and upload reports.</p>${button(url, "Confirm email")}<p>This link works once and expires in ${hours} hours.</p>`)
  }),
  resetPassword: ({ name, url, minutes }) => ({
    subject: "Reset your CareConnect password",
    text: `Hi ${name},\n\nSomeone asked to reset the password for this account. To choose a new password open:\n${url}\n\nThis link works once and expires in ${minutes} minutes.\nIf this was not you, ignore this email: your password stays the same.`,
    html: wrapHtml("Reset your password", `<p>Hi ${escapeHtml(name)},</p><p>Someone asked to reset the password for this account.</p>${button(url, "Choose a new password")}<p>This link works once and expires in ${minutes} minutes. If this was not you, ignore this email: your password stays the same.</p>`)
  }),
  passwordChanged: ({ name }) => ({
    subject: "Your CareConnect password was changed",
    text: `Hi ${name},\n\nThe password for your CareConnect account was just changed and you were signed out on other devices.\nIf this was not you, reset your password immediately using "Forgot password" on the sign-in page and contact support.`,
    html: wrapHtml("Password changed", `<p>Hi ${escapeHtml(name)},</p><p>The password for your CareConnect account was just changed and you were signed out on other devices.</p><p>If this was not you, reset your password immediately using “Forgot password” on the sign-in page.</p>`)
  })
};

module.exports = { createMailer, templates };
