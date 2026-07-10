'use strict';

/**
 * Thin SMTP mailer wrapper.
 *
 * Configuration (env vars):
 *   SMTP_HOST   — SMTP server hostname (e.g. smtp.resend.com, smtp.sendgrid.net)
 *   SMTP_PORT   — SMTP port (default: 587)
 *   SMTP_USER   — SMTP username (Resend: "resend", SendGrid: "apikey")
 *   SMTP_PASS   — SMTP password / API key
 *   SMTP_FROM   — Sender address (e.g. "Optimize <noreply@yourdomain.com>")
 *   SMTP_SECURE — 'true' for port 465 TLS; omit for STARTTLS on 587
 *
 * If SMTP vars are not set, sendMail() logs a warning and returns
 * { sent: false, reason: 'smtp_not_configured' } so callers can decide
 * whether to surface an error or silently degrade.
 *
 * Compatible with any standard SMTP relay:
 *   Resend  → host=smtp.resend.com     port=587 user=resend          pass=re_***
 *   SendGrid→ host=smtp.sendgrid.net   port=587 user=apikey          pass=SG.***
 *   Gmail   → host=smtp.gmail.com      port=587 user=you@gmail.com   pass=app-password
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  _transporter = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user, pass },
  });

  return _transporter;
}

/**
 * Send a transactional email.
 *
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn('[mailer] SMTP not configured — email not sent to', to);
    console.warn('[mailer] Set SMTP_HOST, SMTP_USER, SMTP_PASS in env vars to enable email.');
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  try {
    await transporter.sendMail({ from, to, subject, html, text });
    console.log(`[mailer] sent "${subject}" to ${to}`);
    return { sent: true };
  } catch (err) {
    console.error(`[mailer] failed to send "${subject}" to ${to}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail };
