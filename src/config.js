require('dotenv').config();

const bool = (v, def = false) => (v === undefined ? def : String(v).toLowerCase() === 'true');
const proxySetting = (process.env.TRUST_PROXY || '').trim();
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  trustProxy: !proxySetting || proxySetting === 'false' ? false : proxySetting.split(',').map((entry) => entry.trim()),
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

// Validate at application startup, not at import: notification/unit-test modules
// can load configuration without opening a server or requiring admin credentials.
config.validateRuntimeConfig = function validateRuntimeConfig(value = config) {
  if (typeof value.adminUser !== 'string' || !value.adminUser.trim()) {
    throw new Error('ADMIN_USER must be configured.');
  }
  const password = value.adminPassword;
  const knownPasswords = new Set(['admin', 'change-me', 'changeme', 'password', '123456789012']);
  if (typeof password !== 'string' || password.trim().length < 12 || knownPasswords.has(password.toLowerCase())) {
    throw new Error('ADMIN_PASSWORD must be a unique password of at least 12 characters; example credentials are not allowed.');
  }
  const secret = value.sessionSecret;
  if (typeof secret !== 'string' || secret.trim().length < 32 || /^(default-secret-change-me|change-this-secret-key)$/i.test(secret)) {
    throw new Error('SESSION_SECRET must be a unique random value of at least 32 characters.');
  }
  let url;
  try { url = new URL(value.appUrl); } catch { /* handled below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  if (value.trustProxy !== false && value.trustProxy !== undefined) {
    const validProxy = (entry) => {
      if (typeof entry !== 'string' || entry.includes('%')) return false;
      const [address, prefix, extra] = entry.split('/');
      const version = require('node:net').isIP(address);
      return !!version && extra === undefined && (prefix === undefined ||
        (/^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (version === 4 ? 32 : 128)));
    };
    if (!Array.isArray(value.trustProxy) || !value.trustProxy.length || !value.trustProxy.every(validProxy)) {
      throw new Error('TRUST_PROXY must be false or a comma-separated list of proxy IP addresses/CIDRs with nonzero prefixes; blanket trust and hop counts are not allowed.');
    }
  }
  return value;
};

module.exports = config;
