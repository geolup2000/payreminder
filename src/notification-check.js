const { notificationSettingsFromBody } = require('./notification-settings');
const { sendTelegram } = require('./telegram');
const { sendDiscord } = require('./discord');

async function testNotification(body) {
  const english = body.language === 'en';
  const agent = body.agent;
  const result = (status, message) => ({ status, body: { ok: status === 200, message } });
  if (!['telegram', 'discord'].includes(agent)) {
    return result(400, english ? 'Choose Telegram or Discord.' : 'Alege Telegram sau Discord.');
  }
  let settings;
  try {
    // Validate only the agent being tested; do not save the form.
    settings = notificationSettingsFromBody(agent === 'telegram' ? {
      telegramActive: 'on', telegramBotToken: body.telegramBotToken, telegramChatId: body.telegramChatId,
    } : {
      discordActive: 'on', discordWebhookUrl: body.discordWebhookUrl, discordAppName: body.discordAppName,
    })[agent];
  } catch (err) {
    const translations = {
      'Completează tokenul botului și Chat ID pentru Telegram.': 'Enter the bot token and Chat ID for Telegram.',
      'Introdu un URL valid pentru webhookul Discord.': 'Enter a valid Discord webhook URL.',
      'Numele aplicației poate avea maximum 80 de caractere.': 'The application name can contain up to 80 characters.',
    };
    return result(400, english ? (translations[err.message] || 'Check the notification settings.') : err.message);
  }
  const message = english
    ? '✅ PayReminder test: notification settings work correctly.'
    : '✅ Test PayReminder: setările notificărilor funcționează corect.';
  try {
    const sent = await (agent === 'telegram' ? sendTelegram(message, settings) : sendDiscord(message, settings));
    if (sent.skipped) throw new Error('Skipped');
    return result(200, english ? 'Test message sent successfully. Settings work correctly.' : 'Mesajul de test a fost trimis. Setările funcționează corect.');
  } catch (err) {
    const channel = agent === 'telegram' ? 'Telegram' : 'Discord';
    if (err.status) {
      return result(502, english
        ? `${channel} rejected the test (HTTP ${err.status}). Check the credentials and destination permissions.`
        : `${channel} a respins testul (HTTP ${err.status}). Verifică datele de acces și permisiunile destinației.`);
    }
    return result(502, english
      ? `Could not connect to ${channel}. Check the connection and try again.`
      : `Conexiunea la ${channel} a eșuat. Verifică conexiunea și încearcă din nou.`);
  }
}

module.exports = { testNotification };
