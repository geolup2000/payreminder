const { getNotificationSettings } = require('./notification-settings');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendTelegram(text, telegram = getNotificationSettings().telegram) {
  if (!telegram.active || !telegram.botToken || !telegram.chatId) {
    return { skipped: true };
  }
  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok === false || !data.ok) {
    const error = new Error('Telegram request failed');
    error.status = data.error_code || res.status;
    throw error;
  }
  console.log('[telegram] notificare trimisa');
  return data;
}

async function notifyPaymentReported(member, monthLabel, amountText, confirmUrl, serviceName, language = 'ro') {
  const english = language === 'en';
  const serviceLine = serviceName ? `\n🏷️ <b>${escapeHtml(serviceName)}</b>` : '';
  const text =
`💰 <b>${english ? 'Payment reported' : 'Plată raportată'}</b>

<b>${escapeHtml(member.name)}</b> ${english ? 'reported a payment for' : 'a notificat plata pentru'}${serviceLine}
📅 ${monthLabel}
💵 ${amountText}

<a href="${escapeHtml(confirmUrl)}">${english ? 'Confirm after verification' : 'Confirmă după verificare'} →</a>`;
  return sendTelegram(text);
}

module.exports = { sendTelegram, notifyPaymentReported };
