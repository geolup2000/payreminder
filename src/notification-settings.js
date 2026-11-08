const config = require('./config');
const db = require('./db');

function getNotificationSettings() {
  const saved = db.getSettings().notifications;
  return {
    telegram: saved?.telegram || { active: config.telegramConfigured, ...config.telegram },
    discord: { appName: config.appName, ...(saved?.discord || { active: config.discordConfigured, ...config.discord }) },
    pushover: { active: false, apiToken: '', userKey: '', ...saved?.pushover },
    gotify: { active: false, serverUrl: '', appToken: '', ...saved?.gotify },
  };
}

function notificationSettingsFromBody(body) {
  const value = (name) => String(body[name] || '').trim();
  const notifications = {
    telegram: { active: body.telegramActive === 'on', botToken: value('telegramBotToken'), chatId: value('telegramChatId') },
    discord: { active: body.discordActive === 'on', webhookUrl: value('discordWebhookUrl'), appName: value('discordAppName') || config.appName },
    pushover: { active: body.pushoverActive === 'on', apiToken: value('pushoverApiToken'), userKey: value('pushoverUserKey') },
    gotify: { active: body.gotifyActive === 'on', serverUrl: value('gotifyServerUrl').replace(/\/+$/, ''), appToken: value('gotifyAppToken') },
  };
  const { telegram, discord, pushover, gotify } = notifications;
  if (gotify.active) {
    let url;
    try { url = new URL(gotify.serverUrl); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Introdu un URL HTTP(S) valid pentru serverul Gotify, fără date de acces, query sau fragment.');
    }
    if (!gotify.appToken || /\s/.test(gotify.appToken)) throw new Error('Completează tokenul aplicației Gotify, fără spații.');
  }
  if (pushover.active && (!/^[A-Za-z0-9]{30}$/.test(pushover.apiToken) || !/^[A-Za-z0-9]{30}$/.test(pushover.userKey))) {
    throw new Error('Completează API Token și User/Group Key pentru Pushover (30 de caractere alfanumerice fiecare).');
  }
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
