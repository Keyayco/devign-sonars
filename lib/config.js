'use strict';

/**
 * lib/config.js — SONARS Configuration Management
 * ─────────────────────────────────────────────────
 * Environment variables always override file-persisted secrets.
 * Never returns raw Telegram bot tokens.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'data', 'monitor_config.json');

const DEFAULT_CONFIG = {
  bot_token: '',
  chat_id:   '',
  interval:  120,
  feeds: [
    'https://www.reddit.com/r/Entrepreneur/.rss',
    'https://www.reddit.com/r/smallbusiness/.rss',
    'https://www.reddit.com/r/forhire/.rss',
    'https://www.reddit.com/r/hireafreelancer/.rss',
    'https://www.reddit.com/r/webdesign/.rss',
    'https://www.reddit.com/r/web_design/.rss',
  ],
  keywords: [
    'need a website',
    'looking for a website',
    'build me a website',
    'hire a web developer',
    'need web developer',
    'need a web designer',
    'looking for web designer',
    'website redesign',
    'need ecommerce',
    'need an online store',
    'website quote',
    'website budget',
    'how much does a website cost',
    'wordpress developer',
    'shopify developer',
    'shopify help',
    'need a landing page',
    'replace my developer',
    'developer disappeared',
    'freelancer needed',
    'need a developer',
  ],
};

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}
  return {
    ...DEFAULT_CONFIG,
    ...file,
    bot_token: process.env.TELEGRAM_BOT_TOKEN || file.bot_token || '',
    chat_id:   process.env.TELEGRAM_CHAT_ID   || file.chat_id   || '',
  };
}

function persistConfig(cfg, configPath = DEFAULT_CONFIG_PATH) {
  try {
    const dir = path.dirname(path.resolve(configPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const clean = { ...cfg };
    delete clean.seen_post_ids;
    fs.writeFileSync(configPath, JSON.stringify(clean, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error('[CONFIG] write failed:', e.message);
    return false;
  }
}

function getSafeConfig(configPath = DEFAULT_CONFIG_PATH) {
  const c = loadConfig(configPath);
  return {
    token_configured:   !!(c.bot_token && c.bot_token.length > 5),
    token_from_env:     !!(process.env.TELEGRAM_BOT_TOKEN),
    chat_id_configured: !!(c.chat_id   && c.chat_id.length   > 2),
    chat_id_from_env:   !!(process.env.TELEGRAM_CHAT_ID),
    chat_id_display:    c.chat_id ? c.chat_id.slice(0, 4) + '…' : '',
    interval:           c.interval,
    feeds:              c.feeds,
    keywords:           c.keywords,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  persistConfig,
  getSafeConfig,
};
