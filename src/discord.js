const config = require('./config');
const { getNotificationSettings } = require('./notification-settings');

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, '\\$1');
}

async function sendDiscord(content) {
  const discord = getNotificationSettings().discord;
  if (!discord.active || !discord.webhookUrl) return { skipped: true };

  const url = new URL(discord.webhookUrl);
  url.searchParams.set('wait', 'true');
  const payload = {
    content,
    username: config.appName,
    allowed_mentions: { parse: [] },
  };
  if (discord.iconUrl) payload.avatar_url = discord.iconUrl;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    // Do not log the webhook URL: it contains a secret token.
    throw new Error(`Discord webhook error (HTTP ${res.status})`);
  }
  console.log('[discord] notificare trimisa');
  return { sent: true };
}

async function notifyPaymentReported(member, monthLabel, amountText, confirmUrl, serviceName, language = 'ro') {
  const english = language === 'en';
  const serviceLine = serviceName ? `\n🏷️ **${escapeMarkdown(serviceName).slice(0, 400)}**` : '';
  const content = `💰 **${english ? 'Payment reported' : 'Plată raportată'}**

**${escapeMarkdown(member.name).slice(0, 400)}** ${english ? 'reported a payment for' : 'a notificat plata pentru'}${serviceLine}
📅 ${escapeMarkdown(monthLabel)}
💵 ${escapeMarkdown(amountText)}

${english ? 'Confirm after verification' : 'Confirmă după verificare'} → <${confirmUrl}>`;
  return sendDiscord(content);
}

module.exports = { sendDiscord, notifyPaymentReported };
