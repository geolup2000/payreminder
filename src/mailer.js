const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./db');
const { currentMonth, humanMonth, formatMoney } = require('./format');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtpConfigured) throw new Error('SMTP is not configured');
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    requireTLS: true,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  if (!config.smtpConfigured) {
    console.warn('[mailer] SMTP disabled, email not sent to', to, '-', subject);
    return { skipped: true };
  }
  let from;
  if (config.smtp.fromAddress) {
    from = config.smtp.fromName
      ? `${config.smtp.fromName} <${config.smtp.fromAddress}>`
      : config.smtp.fromAddress;
  } else {
    from = config.smtp.from || config.smtp.user;
  }
  const transporterInstance = getTransporter();
  const info = await transporterInstance.sendMail({ from, to, subject, html });
  console.log('[mailer] email sent:', to, '-', subject, info.messageId);
  return info;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function currentLanguage() {
  const settings = db.getSettings();
  return settings.language === 'en' || (settings.language !== 'ro' && settings.emailLanguage === 'en') ? 'en' : 'ro';
}

function localizedMonth(month, language) {
  if (language === 'ro') return humanMonth(month);
  const [year, monthNumber] = String(month).split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function wrapLayout(bodyHtml, preheader, serviceName = 'Plăți recurente', language = 'ro') {
  const footer = language === 'en'
    ? 'This email was generated automatically. If you have any questions, reply to the sender.'
    : 'Acest email este generat automat. Dacă ai întrebări, răspunde la adresa de expeditor.';
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayReminder</title>
</head>
<body style="margin:0;padding:0;background:#090d17;font-family:Arial,Helvetica,sans-serif;color:#eef3fb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090d17;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#111a29;border-radius:14px;overflow:hidden;border:1px solid #26354b">
        <tr><td style="background:#111a29;padding:22px 28px;color:#eef3fb;border-bottom:1px solid #26354b">
          <div style="font-size:20px;font-weight:bold;letter-spacing:-.3px">PayReminder</div>
          <div style="font-size:13px;color:#91a0b5;margin-top:4px">${escapeHtml(serviceName)}</div>
        </td></tr>
        <tr><td style="padding:28px" ${preheader ? `data-preheader="${escapeHtml(preheader)}"` : ''}>${bodyHtml}</td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #26354b;font-size:12px;line-height:1.6;color:#91a0b5">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buttonHtml(text, url) {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#718cf5;color:#08101d;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;font-size:15px;margin:6px 6px 6px 0">${text}</a>`;
}

function getMemberLink(token) {
  return `${config.appUrl}/p/${token}`;
}

function serviceInfo(member, service) {
  return service || { name: member && member.serviceName ? member.serviceName : 'Serviciu' };
}

async function sendReminderEmail(member, opts = {}) {
  const language = currentLanguage();
  const month = opts.month || currentMonth();
  const amount = opts.amount !== undefined ? opts.amount : member.amount;
  const service = serviceInfo(member, opts.service);
  const serviceName = service.name || 'Serviciu';
  const link = getMemberLink(member.token);
  const safeName = escapeHtml(member.name);
  const safeServiceName = escapeHtml(serviceName);
  const monthText = localizedMonth(month, language);
  const copy = language === 'en'
    ? {
        greeting: 'Hello', reminder: 'This is a reminder that payment for', service: 'of the service',
        amount: 'The amount due is:', access: 'Open your page to pay and report your payment:',
        button: '💳 Pay and report payment', ignore: 'If you have already paid, please ignore this email.',
        subject: `PayReminder: ${serviceName} - payment for ${monthText}`, preheader: `Payment for ${serviceName}`,
      }
    : {
        greeting: 'Salut', reminder: 'Îți reamintim că urmează plata pentru luna', service: 'a serviciului',
        amount: 'Suma de plată este:', access: 'Accesează pagina ta pentru a plăti și confirma plata:',
        button: '💳 Plătește și confirmă', ignore: 'Dacă ai plătit deja, ignoră acest email.',
        subject: `PayReminder: ${serviceName} - plata pentru ${monthText}`, preheader: `Plata pentru ${serviceName}`,
      };
  const body = `
    <p style="color:#eef3fb;font-size:15px;line-height:1.6">${copy.greeting} <b>${safeName}</b>!</p>
    <p style="color:#c0cad8;font-size:15px;line-height:1.6">${copy.reminder} <b>${monthText}</b> ${copy.service} <b>${safeServiceName}</b>. ${copy.amount}</p>
    <div style="font-size:30px;font-weight:bold;color:#eef3fb;padding:10px 0">${formatMoney(amount, config.currency, language)}</div>
    <p style="color:#c0cad8;font-size:15px;line-height:1.6">${copy.access}</p>
    ${buttonHtml(copy.button, link)}
    <p style="color:#91a0b5;font-size:13px;margin-top:24px">${copy.ignore}</p>
  `;
  return sendMail({
    to: member.email,
    subject: copy.subject,
    html: wrapLayout(body, copy.preheader, serviceName, language),
  });
}

async function sendConfirmEmail(member, month, opts = {}) {
  const language = currentLanguage();
  const amount = opts.amount !== undefined ? opts.amount : member.amount;
  const service = serviceInfo(member, opts.service);
  const serviceName = service.name || 'Serviciu';
  const safeName = escapeHtml(member.name);
  const safeServiceName = escapeHtml(serviceName);
  const endMonth = opts.endMonth || month;
  const startText = localizedMonth(month, language);
  const periodText = endMonth > month ? `${startText} – ${localizedMonth(endMonth, language)}` : startText;
  const copy = language === 'en'
    ? {
        greeting: 'Hello', confirmed: 'Your payment of', for: 'for', service: 'for the service',
        thanks: 'Thanks for staying up to date! 🎉', next: 'We will send you another reminder next month.',
        subject: `PayReminder: payment confirmed for ${periodText} ✅`, preheader: `Payment confirmed for ${serviceName}`,
      }
    : {
        greeting: 'Salut', confirmed: 'Am confirmat plata ta de', for: 'pentru', service: 'la serviciul',
        thanks: 'Mulțumim că ești la zi! 🎉', next: 'Luna viitoare revenim cu o reamintire.',
        subject: `PayReminder: plata confirmată pentru ${periodText} ✅`, preheader: `Plata confirmată pentru ${serviceName}`,
      };
  const body = `
    <p style="color:#eef3fb;font-size:15px;line-height:1.6">${copy.greeting} <b>${safeName}</b>!</p>
    <p style="color:#c0cad8;font-size:15px;line-height:1.6">${copy.confirmed} <b>${formatMoney(amount, config.currency, language)}</b> ${copy.for} <b>${periodText}</b> ${copy.service} <b>${safeServiceName}</b>.</p>
    <p style="color:#c0cad8;font-size:15px;line-height:1.6">${copy.thanks}</p>
    <p style="color:#91a0b5;font-size:13px;margin-top:24px">${copy.next}</p>
  `;
  return sendMail({
    to: member.email,
    subject: copy.subject,
    html: wrapLayout(body, copy.preheader, serviceName, language),
  });
}

module.exports = { sendMail, sendReminderEmail, sendConfirmEmail, getMemberLink };
