// notifications/index.js
// Fan-out notification dispatcher. Supports:
//   - webhook (generic POST, e.g. Slack/Discord incoming webhook or your own)
//   - email (SMTP via nodemailer)
// Both are optional and independently configured; if neither is configured,
// notify() just logs and records to the DB for the dashboard to display.


import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { notifications as notificationsRepo } from '../database/index.js';


let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (!config.notifications.smtp.host) return null;
  mailer = nodemailer.createTransport({
    host: config.notifications.smtp.host,
    port: config.notifications.smtp.port,
    secure: config.notifications.smtp.secure,
    auth: config.notifications.smtp.user
      ? { user: config.notifications.smtp.user, pass: config.notifications.smtp.pass }
      : undefined,
  });
  return mailer;
}


export async function notify({ level = 'info', subject, body = '' }) {
  const jobs = [];


  if (config.notifications.webhookUrl) {
    jobs.push(sendWebhook({ level, subject, body }));
  }
  if (config.notifications.smtp.host && config.notifications.email.to) {
    jobs.push(sendEmail({ level, subject, body }));
  }
  if (jobs.length === 0) {
    console.log(`[notify:${level}] ${subject} — ${body?.slice(0, 200)}`);
    try { notificationsRepo.record({ level, subject, body, channel: 'log', ok: true }); } catch {}
    return { sent: false, reason: 'no channels configured' };
  }


  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === 'rejected') console.error('[notify] channel failed:', r.reason?.message || r.reason);
  });
  return { sent: true };
}


async function sendWebhook({ level, subject, body }) {
  try {
    const res = await fetch(config.notifications.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*[${level.toUpperCase()}]* ${subject}\n${body}`.slice(0, 3900),
        level, subject, body,
      }),
    });
    const ok = res.ok;
    notificationsRepo.record({ level, subject, body, channel: 'webhook', ok, errorMessage: ok ? null : `HTTP ${res.status}` });
    if (!ok) throw new Error(`webhook responded ${res.status}`);
  } catch (err) {
    notificationsRepo.record({ level, subject, body, channel: 'webhook', ok: false, errorMessage: err.message });
    throw err;
  }
}


async function sendEmail({ level, subject, body }) {
  const transport = getMailer();
  if (!transport) return;
  try {
    await transport.sendMail({
      from: config.notifications.email.from,
      to: config.notifications.email.to,
      subject: `[agent:${level}] ${subject}`,
      text: body,
    });
    notificationsRepo.record({ level, subject, body, channel: 'email', ok: true });
  } catch (err) {
    notificationsRepo.record({ level, subject, body, channel: 'email', ok: false, errorMessage: err.message });
    throw err;
  }
}
