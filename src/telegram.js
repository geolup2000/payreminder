const { getNotificationSettings } = require('./notification-settings');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendTelegram(text) {
  const telegram = getNotificationSettings().telegram;
  if (!telegram.active || !telegram.botToken || !telegram.chatId) {
    return { skipped: true };
  }
  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('[telegram] eroare la trimitere:', JSON.stringify(data));
    throw new Error('Telegram error: ' + (data.description || 'unknown'));
  }
  console.log('[telegram] notificare trimisa');
  return data;
}

async function notifyPaymentReported(member, monthLabel, amountText, confirmUrl, serviceName) {
  const serviceLine = serviceName ? `\n🏷️ <b>${escapeHtml(serviceName)}</b>` : '';
  const text =
`💰 <b>Plată raportată</b>

<b>${escapeHtml(member.name)}</b> a notificat plata pentru${serviceLine}
📅 ${monthLabel}
💵 ${amountText}

<a href="${escapeHtml(confirmUrl)}">Confirmă după verificare →</a>`;
  return sendTelegram(text);
}

module.exports = { sendTelegram, notifyPaymentReported };
