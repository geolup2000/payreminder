const config = require('./config');
const db = require('./db');

function getNotificationSettings() {
  const saved = db.getSettings().notifications;
  return {
    telegram: saved?.telegram || { active: config.telegramConfigured, ...config.telegram },
    discord: { appName: config.appName, ...(saved?.discord || { active: config.discordConfigured, ...config.discord }) },
  };
}

function notificationSettingsFromBody(body) {
  const value = (name) => String(body[name] || '').trim();
  const notifications = {
    telegram: { active: body.telegramActive === 'on', botToken: value('telegramBotToken'), chatId: value('telegramChatId') },
    discord: { active: body.discordActive === 'on', webhookUrl: value('discordWebhookUrl'), appName: value('discordAppName') || config.appName },
  };
  const { telegram, discord } = notifications;
  if (discord.appName.length > 80) throw new Error('Numele aplicației poate avea maximum 80 de caractere.');
  if (telegram.active && (!telegram.botToken || !telegram.chatId)) {
    throw new Error('Completează tokenul botului și Chat ID pentru Telegram.');
  }
  if (discord.active) {
    let url;
    try { url = new URL(discord.webhookUrl); } catch {}
    if (!url || url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[^/]+$/.test(url.pathname)) {
      throw new Error('Introdu un URL valid pentru webhookul Discord.');
    }
  }
  return notifications;
}

module.exports = { getNotificationSettings, notificationSettingsFromBody };
