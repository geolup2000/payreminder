const config = require('./config');
const db = require('./db');

function getNotificationSettings() {
  const saved = db.getSettings().notifications;
  return {
    telegram: saved?.telegram || { active: config.telegramConfigured, ...config.telegram },
    discord: saved?.discord || { active: config.discordConfigured, ...config.discord },
  };
}

function notificationSettingsFromBody(body) {
  const value = (name) => String(body[name] || '').trim();
  const notifications = {
    telegram: { active: body.telegramActive === 'on', botToken: value('telegramBotToken'), chatId: value('telegramChatId') },
    discord: { active: body.discordActive === 'on', webhookUrl: value('discordWebhookUrl'), iconUrl: value('discordIconUrl') },
  };
  const { telegram, discord } = notifications;
  if (telegram.active && (!telegram.botToken || !telegram.chatId)) {
    throw new Error('Completează tokenul botului și Chat ID pentru Telegram.');
  }
  if (discord.active) {
    let url;
    try { url = new URL(discord.webhookUrl); } catch {}
    if (!url || url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[^/]+$/.test(url.pathname)) {
      throw new Error('Introdu un URL valid pentru webhookul Discord.');
    }
    if (discord.iconUrl) {
      let icon;
      try { icon = new URL(discord.iconUrl); } catch {}
      if (!icon || !['http:', 'https:'].includes(icon.protocol)) throw new Error('Introdu un URL HTTP sau HTTPS valid pentru icon.');
    }
  }
  return notifications;
}

module.exports = { getNotificationSettings, notificationSettingsFromBody };
