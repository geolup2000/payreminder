const { getNotificationSettings } = require('./notification-settings');

async function sendGotify(message, gotify = getNotificationSettings().gotify) {
  if (!gotify.active || !gotify.serverUrl || !gotify.appToken) return { skipped: true };
  let res;
  try {
    res = await fetch(`${gotify.serverUrl.replace(/\/+$/, '')}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': gotify.appToken },
      body: JSON.stringify({ title: 'PayReminder', message, priority: 5 }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Gotify connection failed');
  }
  if (!res.ok) {
    // Never expose provider bodies or connection errors containing credentials.
    const error = new Error(`Gotify request failed (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  console.log('[gotify] notificare trimisa');
  return { sent: true };
}

async function notifyPaymentReported(member, monthLabel, amountText, confirmUrl, serviceName, language = 'ro') {
  const english = language === 'en';
  const message = `💰 ${english ? 'Payment reported' : 'Plată raportată'}

${String(member.name).slice(0, 200)} ${english ? 'reported a payment for' : 'a notificat plata pentru'}${serviceName ? `\n🏷️ ${String(serviceName).slice(0, 200)}` : ''}
📅 ${monthLabel}
💵 ${amountText}

${english ? 'Confirm after verification' : 'Confirmă după verificare'} → ${confirmUrl}`;
  return sendGotify(message);
}

module.exports = { sendGotify, notifyPaymentReported };
