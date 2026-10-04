require('dotenv').config();

const bool = (v, def = false) => (v === undefined ? def : String(v).toLowerCase() === 'true');
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  appName: 'PayReminder',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  sessionSecret: process.env.SESSION_SECRET || 'default-secret-change-me',

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.mail.me.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
    fromName: process.env.SMTP_FROM_NAME || '',
    fromAddress: process.env.SMTP_FROM_ADDRESS || '',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  discord: {
    webhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
  },

  currency: process.env.CURRENCY || 'RON',
  defaultAmount: parseFloat(process.env.DEFAULT_AMOUNT || 0),
  sendConfirmToMember: bool(process.env.SEND_CONFIRM_TO_MEMBER, true),
};

config.smtpConfigured = !!(config.smtp.user && config.smtp.pass);
config.telegramConfigured = !!(config.telegram.botToken && config.telegram.chatId);
config.discordConfigured = !!config.discord.webhookUrl;

if (!config.smtpConfigured) {
  console.warn('[config] SMTP nu este configurat - emailurile sunt dezactivate.');
}

module.exports = config;
