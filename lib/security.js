'use strict';

/**
 * lib/security.js — SONARS Authentication, Validation & Hardening
 * ─────────────────────────────────────────────────────────────────
 * Access Control Strategy:
 *   • Single-operator shared secret via SONARS_ACCESS_KEY environment variable.
 *   • Browser clients authenticate via POST /api/auth/login, receiving an
 *     HMAC-SHA256 signed HttpOnly SameSite=Lax session cookie (sonars_session),
 *     which works transparently with EventSource SSE streams.
 *   • API clients and automated tests may also pass Authorization: Bearer <key>.
 *   • Fail-closed in NODE_ENV=production if SONARS_ACCESS_KEY is missing.
 *   • Secret redaction on logs, SSRF protection on RSS feed URLs, body validation,
 *     and login brute-force rate limiting.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'sonars_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VALID_STATUSES = new Set(['new', 'contacted', 'ignored', 'won']);

// Per-IP failed login tracker
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;

function getAccessKey() {
  return (process.env.SONARS_ACCESS_KEY || '').trim();
}

function getSigningSecret() {
  return (process.env.SONARS_SESSION_SECRET || getAccessKey() || '').trim();
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(expiresAt, secret) {
  const payload = `sonars:${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${expiresAt}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || !secret || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = signSession(expiresAt, secret);
  return timingSafeEqualStr(token, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAuthenticated(req) {
  const key = getAccessKey();
  if (!key) {
    // Production fails closed when SONARS_ACCESS_KEY is unset.
    // Development allows access when SONARS_ACCESS_KEY is intentionally omitted.
    return !isProduction();
  }

  // 1. Bearer header check
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (timingSafeEqualStr(token, key)) return true;
  }

  // 2. Signed HttpOnly cookie check (used by browser + EventSource SSE)
  const cookies = parseCookies(req);
  const sessionToken = cookies[SESSION_COOKIE];
  if (verifySessionToken(sessionToken, getSigningSecret())) {
    return true;
  }

  return false;
}

function requireAuth(req, res, next) {
  const key = getAccessKey();
  if (isProduction() && !key) {
    return res.status(503).json({
      error: 'Server security misconfiguration: SONARS_ACCESS_KEY must be set in production.',
    });
  }
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    return { allowed: true };
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function createAuthHandlers() {
  return {
    session(req, res) {
      const key = getAccessKey();
      const prodMissingKey = isProduction() && !key;
      res.json({
        authenticated: !prodMissingKey && isAuthenticated(req),
        authRequired:  !!key || isProduction(),
        misconfigured: prodMissingKey,
      });
    },

    login(req, res) {
      const key = getAccessKey();
      if (isProduction() && !key) {
        return res.status(503).json({
          error: 'SONARS_ACCESS_KEY is not configured in production.',
        });
      }
      if (!key) {
        return res.json({ ok: true, authRequired: false });
      }

      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const rl = checkLoginRateLimit(ip);
      if (!rl.allowed) {
        return res.status(429).json({
          error: `Too many failed login attempts. Retry in ${rl.retryAfterSec}s.`,
        });
      }

      const submitted = String((req.body && req.body.accessKey) || '').trim();
      if (!submitted || !timingSafeEqualStr(submitted, key)) {
        recordFailedLogin(ip);
        return res.status(401).json({ error: 'Invalid access key' });
      }

      clearLoginFailures(ip);
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const cookieVal = signSession(expiresAt, getSigningSecret());
      res.cookie(SESSION_COOKIE, cookieVal, {
        httpOnly: true,
        sameSite: 'lax',
        secure:   isProduction() && (req.secure || req.headers['x-forwarded-proto'] === 'https'),
        maxAge:   SESSION_TTL_MS,
        path:     '/',
      });
      return res.json({ ok: true });
    },

    logout(_req, res) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    },
  };
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
    .replace(/(TELEGRAM_BOT_TOKEN|SONARS_ACCESS_KEY)\s*=\s*\S+/gi, '$1=[REDACTED]');
}

function isAllowedFeedUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const allowHttp = process.env.SONARS_ALLOW_HTTP_FEEDS === '1';
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    // SSRF guard: block loopback/link-local/metadata IPs unless local HTTP test mode is enabled
    if (!allowHttp && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('169.254.'))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateConfigPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const out = {};

  if (body.bot_token !== undefined) {
    if (typeof body.bot_token !== 'string' || body.bot_token.length > 256) {
      return { error: 'Invalid bot_token format' };
    }
    out.bot_token = body.bot_token.trim();
  }

  if (body.chat_id !== undefined) {
    if (typeof body.chat_id !== 'string' || body.chat_id.length > 64) {
      return { error: 'Invalid chat_id format' };
    }
    out.chat_id = body.chat_id.trim();
  }

  if (body.interval !== undefined) {
    const num = Number(body.interval);
    if (!Number.isFinite(num) || num < 30 || num > 86400) {
      return { error: 'Interval must be between 30 and 86400 seconds' };
    }
    out.interval = Math.floor(num);
  }

  if (body.feeds !== undefined) {
    if (!Array.isArray(body.feeds) || body.feeds.length > 100) {
      return { error: 'Feeds must be an array of at most 100 URLs' };
    }
    const cleaned = [];
    for (const item of body.feeds) {
      if (typeof item !== 'string') return { error: 'Each feed must be a string URL' };
      const u = item.trim();
      if (!u) continue;
      if (!isAllowedFeedUrl(u)) {
        return { error: `Invalid or disallowed feed URL: ${u.slice(0, 60)}` };
      }
      cleaned.push(u);
    }
    out.feeds = cleaned;
  }

  if (body.keywords !== undefined) {
    if (!Array.isArray(body.keywords) || body.keywords.length > 250) {
      return { error: 'Keywords must be an array of at most 250 phrases' };
    }
    const cleaned = [];
    for (const kw of body.keywords) {
      if (typeof kw !== 'string') return { error: 'Each keyword must be a string' };
      const k = kw.trim();
      if (!k) continue;
      if (k.length > 120) return { error: 'Keyword exceeds 120 characters' };
      cleaned.push(k);
    }
    out.keywords = cleaned;
  }

  return { value: out };
}

function validateStatusPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const status = String(body.status || '').trim();
  if (!VALID_STATUSES.has(status)) {
    return { error: 'Invalid status. Must be one of: new, contacted, ignored, won' };
  }
  return { value: status };
}

module.exports = {
  SESSION_COOKIE,
  isAuthenticated,
  requireAuth,
  createAuthHandlers,
  securityHeaders,
  redactSecrets,
  validateConfigPayload,
  validateStatusPayload,
};
