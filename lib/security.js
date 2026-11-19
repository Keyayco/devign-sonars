'use strict';

/**
 * lib/security.js — SONARS Authentication, CSRF, Validation & Hardening
 * ──────────────────────────────────────────────────────────────────────
 * • Single-operator shared secret via SONARS_ACCESS_KEY environment variable.
 * • Signed HttpOnly SameSite=Lax session cookie (sonars_session) + Bearer fallback.
 * • Malformed cookie resilience (safe decodeURIComponent & strict format checks).
 * • Stateless HMAC-bound X-CSRF-Token + Origin/Referer validation on mutations.
 * • Fail-closed (503) in NODE_ENV=production if SONARS_ACCESS_KEY is unset.
 * • Bounded per-IP login rate limiter, secret redaction, and DNS-backed SSRF validation.
 */

const crypto = require('crypto');
const { validateFeedUrl } = require('./ssrf');

const SESSION_COOKIE = 'sonars_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VALID_STATUSES = new Set(['new', 'contacted', 'ignored', 'won']);
const SAFE_METHODS   = new Set(['GET', 'HEAD', 'OPTIONS']);

const loginAttempts    = new Map();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;
const MAX_TRACKED_IPS    = 2000;

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

function keyFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

function signSession(expiresAt, secret) {
  const fp = keyFingerprint(secret);
  const payload = `sonars:v2:${fp}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${expiresAt}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || !secret || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  if (!/^\d{10,16}$/.test(parts[0]) || !/^[a-f0-9]{64}$/i.test(parts[1])) {
    return false;
  }
  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = signSession(expiresAt, secret);
  return timingSafeEqualStr(token, expected);
}

function deriveCsrfToken(sessionToken, secret) {
  if (!sessionToken || !secret) return '';
  return crypto.createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('hex');
}

function parseCookies(req) {
  const header = req && req.headers ? req.headers.cookie : '';
  if (!header || typeof header !== 'string') return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const rawV = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(rawV);
    } catch {
      // Ignore malformed percent-encoding instead of throwing URIError
      out[k] = rawV;
    }
  }
  return out;
}

function resolveAuthContext(req) {
  const key = getAccessKey();
  if (!key) {
    if (isProduction()) {
      return { authenticated: false, mode: 'misconfigured', sessionToken: null };
    }
    return { authenticated: true, mode: 'dev-open', sessionToken: null };
  }

  const authHeader = (req && req.headers && req.headers.authorization) || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token && timingSafeEqualStr(token, key)) {
      return { authenticated: true, mode: 'bearer', sessionToken: null };
    }
  }

  const cookies = parseCookies(req);
  const sessionToken = cookies[SESSION_COOKIE];
  if (verifySessionToken(sessionToken, getSigningSecret())) {
    return { authenticated: true, mode: 'cookie', sessionToken };
  }

  return { authenticated: false, mode: 'none', sessionToken: null };
}

function isAuthenticated(req) {
  return resolveAuthContext(req).authenticated;
}

function isSameOriginHeader(req) {
  const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!expectedHost) return true;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!origin || origin === 'null') return false;
    try {
      return new URL(origin).host.toLowerCase() === expectedHost;
    } catch {
      return false;
    }
  }

  const referer = req.headers.referer;
  if (referer !== undefined) {
    try {
      return new URL(referer).host.toLowerCase() === expectedHost;
    } catch {
      return false;
    }
  }

  return true;
}

function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  if (!isSameOriginHeader(req)) {
    return res.status(403).json({ error: 'CSRF check failed: cross-origin request rejected' });
  }

  const ctx = req.sonarsAuth || resolveAuthContext(req);
  if (ctx.mode === 'cookie') {
    const submitted = String(req.headers['x-csrf-token'] || '').trim();
    const expected  = deriveCsrfToken(ctx.sessionToken, getSigningSecret());
    if (!submitted || !expected || !timingSafeEqualStr(submitted, expected)) {
      return res.status(403).json({ error: 'CSRF token missing or invalid' });
    }
  }

  next();
}

function requireAuth(req, res, next) {
  const key = getAccessKey();
  if (isProduction() && !key) {
    return res.status(503).json({
      error: 'Server security misconfiguration: SONARS_ACCESS_KEY must be set in production.',
    });
  }
  const ctx = resolveAuthContext(req);
  if (!ctx.authenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.sonarsAuth = ctx;
  next();
}

function pruneLoginAttempts(now = Date.now()) {
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
  while (loginAttempts.size >= MAX_TRACKED_IPS) {
    const oldestKey = loginAttempts.keys().next().value;
    if (!oldestKey) break;
    loginAttempts.delete(oldestKey);
  }
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (entry) loginAttempts.delete(ip);
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
    pruneLoginAttempts(now);
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function clearLoginAttemptsForTest() {
  loginAttempts.clear();
}

function createAuthHandlers() {
  return {
    session(req, res) {
      const key = getAccessKey();
      const prodMissingKey = isProduction() && !key;
      const ctx = resolveAuthContext(req);
      const csrfToken = (ctx.authenticated && ctx.mode === 'cookie' && ctx.sessionToken)
        ? deriveCsrfToken(ctx.sessionToken, getSigningSecret())
        : null;
      res.json({
        authenticated: !prodMissingKey && ctx.authenticated,
        authRequired:  !!key || isProduction(),
        misconfigured: prodMissingKey,
        csrfToken,
      });
    },

    login(req, res) {
      if (!isSameOriginHeader(req)) {
        return res.status(403).json({ error: 'CSRF check failed: cross-origin login rejected' });
      }

      const key = getAccessKey();
      if (isProduction() && !key) {
        return res.status(503).json({
          error: 'SONARS_ACCESS_KEY is not configured in production.',
        });
      }
      if (!key) {
        return res.json({ ok: true, authRequired: false, csrfToken: null });
      }

      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
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
      const secret    = getSigningSecret();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const cookieVal = signSession(expiresAt, secret);
      const isHttps   = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');

      res.cookie(SESSION_COOKIE, cookieVal, {
        httpOnly: true,
        sameSite: 'lax',
        secure:   isProduction() && isHttps,
        maxAge:   SESSION_TTL_MS,
        path:     '/',
      });
      return res.json({
        ok: true,
        csrfToken: deriveCsrfToken(cookieVal, secret),
      });
    },

    logout(req, res) {
      if (!isSameOriginHeader(req)) {
        return res.status(403).json({ error: 'CSRF check failed: cross-origin request rejected' });
      }
      const ctx = resolveAuthContext(req);
      if (ctx.mode === 'cookie') {
        const submitted = String(req.headers['x-csrf-token'] || '').trim();
        const expected  = deriveCsrfToken(ctx.sessionToken, getSigningSecret());
        if (!submitted || !expected || !timingSafeEqualStr(submitted, expected)) {
          return res.status(403).json({ error: 'CSRF token missing or invalid' });
        }
      }
      const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
      res.clearCookie(SESSION_COOKIE, {
        path:     '/',
        httpOnly: true,
        sameSite: 'lax',
        secure:   isProduction() && isHttps,
      });
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
    .replace(/(TELEGRAM_BOT_TOKEN|SONARS_ACCESS_KEY|SONARS_SESSION_SECRET|CIPC_CLIENT_SECRET|CIPC_CLIENT_ID)\s*=\s*\S+/gi, '$1=[REDACTED]')
    .replace(/"(bot_token|accessKey|client_secret|access_token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

async function validateConfigPayload(body, options = {}) {
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
      const check = await validateFeedUrl(u, options);
      if (!check.valid) {
        return { error: `Invalid or disallowed feed URL (${check.error}): ${u.slice(0, 60)}` };
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

function validateReviewPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const out = {};
  const validReviews = new Set(['pending_review', 'approved', 'rejected', 'hold', 'suppressed']);
  if (body.review_status !== undefined) {
    const rs = String(body.review_status || '').trim();
    if (!validReviews.has(rs)) {
      return { error: 'Invalid review_status. Must be pending_review, approved, rejected, hold, or suppressed' };
    }
    out.review_status = rs;
  }
  if (body.suppressed !== undefined) {
    if (typeof body.suppressed !== 'boolean') {
      return { error: 'suppressed must be a boolean' };
    }
    out.suppressed = body.suppressed;
  }
  if (body.contact_eligible !== undefined) {
    if (typeof body.contact_eligible !== 'boolean') {
      return { error: 'contact_eligible must be a boolean' };
    }
    out.contact_eligible = body.contact_eligible;
  }
  if (body.review_notes !== undefined) {
    if (body.review_notes !== null && typeof body.review_notes !== 'string') {
      return { error: 'review_notes must be a string or null' };
    }
    out.review_notes = body.review_notes ? body.review_notes.trim().slice(0, 1000) : null;
  }
  if (Object.keys(out).length === 0) {
    return { error: 'Provide review_status, suppressed, contact_eligible, or review_notes' };
  }
  return { value: out };
}

function validateDiscoveryCipcPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : '';
  const registrationNumber = typeof body.registrationNumber === 'string'
    ? body.registrationNumber.trim().slice(0, 60)
    : '';
  if (!query && !registrationNumber) {
    return { error: 'Provide a company name query or registrationNumber' };
  }
  let limit = 20;
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      return { error: 'limit must be between 1 and 50' };
    }
    limit = Math.floor(n);
  }
  return { value: { query, registrationNumber, limit } };
}

function validateDiscoveryOsmPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const area = typeof body.area === 'string' ? body.area.trim() : 'cape_town_cbd';
  const category = typeof body.category === 'string' ? body.category.trim() : 'retail_shops';
  if (!category) return { error: 'category is required' };
  let bbox = null;
  if (body.bbox !== undefined && body.bbox !== null) {
    if (!Array.isArray(body.bbox) || body.bbox.length !== 4 || body.bbox.some(v => !Number.isFinite(Number(v)))) {
      return { error: 'bbox must be an array of 4 finite numbers [south, west, north, east]' };
    }
    bbox = body.bbox.map(Number);
  }
  let limit = 25;
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return { error: 'limit must be between 1 and 100' };
    }
    limit = Math.floor(n);
  }
  return { value: { area, category, bbox, limit } };
}

module.exports = {
  SESSION_COOKIE,
  isAuthenticated,
  requireAuth,
  verifyCsrf,
  parseCookies,
  deriveCsrfToken,
  createAuthHandlers,
  clearLoginAttemptsForTest,
  securityHeaders,
  redactSecrets,
  validateConfigPayload,
  validateStatusPayload,
  validateReviewPayload,
  validateDiscoveryCipcPayload,
  validateDiscoveryOsmPayload,
};
