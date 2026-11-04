const { getNotificationSettings } = require('./notification-settings');

async function sendPushover(message, pushover = getNotificationSettings().pushover) {
  if (!pushover.active || !pushover.apiToken || !pushover.userKey) return { skipped: true };

  let res;
  try {
    res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pushover.apiToken, user: pushover.userKey, message: message.slice(0, 1024) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Pushover connection failed');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 1) {
    // Provider responses may contain credentials; only expose the HTTP status.
    const error = new Error(`Pushover request failed (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  console.log('[pushover] notificare trimisa');
  return { sent: true };
}

async function notifyPaymentReported(member, monthLabel, amountText, confirmUrl, serviceName, language = 'ro') {
  const english = language === 'en';
  const message = `💰 ${english ? 'Payment reported' : 'Plată raportată'}

${String(member.name).slice(0, 200)} ${english ? 'reported a payment for' : 'a notificat plata pentru'}${serviceName ? `\n🏷️ ${String(serviceName).slice(0, 200)}` : ''}
📅 ${monthLabel}
💵 ${amountText}

${english ? 'Confirm after verification' : 'Confirmă după verificare'} → ${confirmUrl}`;
  return sendPushover(message);
}

module.exports = { sendPushover, notifyPaymentReported };
