'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const http   = require('node:http');

const { createApp } = require('../../server');
const db            = require('../../lib/db');
const security      = require('../../lib/security');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonars-http-'));
  return {
    dir,
    dbPath:     path.join(dir, 'lead_monitor.db'),
    configPath: path.join(dir, 'monitor_config.json'),
    seedPath:   path.join(dir, '.worker_seed.json'),
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}

test('security: health unauthenticated, auth/CSRF enforcement, malformed cookies, rate limiting, and DNS SSRF config validation', async () => {
  const sb = makeSandbox();
  const prevKey = process.env.SONARS_ACCESS_KEY;
  const prevEnv = process.env.NODE_ENV;
  const prevTok = process.env.TELEGRAM_BOT_TOKEN;

  const mockWorker = {
    isRunning: () => false,
    getState:  () => 'stopped',
    getStats:  () => ({ cycles: 0, matches: 0, alerts_sent: 0, dupes_skipped: 0, last_scan_ms: 0 }),
    getLogs:   () => [],
    addSSEClient: (res) => { res.status(200).end('event: status\ndata: {"running":false}\n\n'); },
    startWorker: () => true,
    stopWorker:  () => {},
  };

  security.clearLoginAttemptsForTest();
  process.env.SONARS_ACCESS_KEY = 'super-secret-operator-key';
  process.env.NODE_ENV = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;

  // Mock DNS resolver: www.reddit.com -> public IP; evil-dns.example -> private IP
  const mockLookup = async (host) => {
    if (host === 'evil-dns.example') return [{ address: '10.0.0.1' }];
    return [{ address: '151.101.1.140' }];
  };

  const app = createApp({
    dbPath: sb.dbPath,
    configPath: sb.configPath,
    seedPath: sb.seedPath,
    workerManager: mockWorker,
    feedLookup: mockLookup,
  });

  const { server, baseUrl } = await listen(app);

  try {
    // 1. Health endpoint works without auth
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.db, 'connected');

    // 2. Malformed cookie encoding never throws 500
    const malformedCookieRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: 'sonars_session=%ZZ%E0%A4%A; broken=%' },
    });
    assert.equal(malformedCookieRes.status, 401);

    // 3. Protected routes reject unauthenticated requests
    for (const [method, endpoint] of [
      ['GET', '/api/status'],
      ['GET', '/api/config'],
      ['GET', '/api/signals'],
      ['GET', '/api/leads'],
      ['POST', '/api/start'],
      ['POST', '/api/stop'],
      ['PATCH', '/api/signals/1'],
    ]) {
      const res = await fetch(`${baseUrl}${endpoint}`, { method });
      assert.equal(res.status, 401, `${method} ${endpoint} must require auth`);
    }

    // 4. Production fails closed with 503 if SONARS_ACCESS_KEY is unset
    process.env.NODE_ENV = 'production';
    process.env.SONARS_ACCESS_KEY = '';
    const prodRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(prodRes.status, 503);

    // Restore key for auth flow tests
    process.env.NODE_ENV = 'test';
    process.env.SONARS_ACCESS_KEY = 'super-secret-operator-key';

    // 5. Login rate limit after 10 failures -> 429
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKey: 'wrong-key' }),
      });
      assert.equal(r.status, 401);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'wrong-key' }),
    });
    assert.equal(limited.status, 429);
    security.clearLoginAttemptsForTest();

    // 6. Valid login sets HttpOnly cookie and returns CSRF token
    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'super-secret-operator-key' }),
    });
    assert.equal(goodLogin.status, 200);
    const loginJson = await goodLogin.json();
    assert.ok(loginJson.csrfToken);
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    assert.match(setCookie, /sonars_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookieHeader = setCookie.split(';')[0];

    // 7. Cookie-based mutations require valid X-CSRF-Token & same-origin
    const missingCsrf = await fetch(`${baseUrl}/api/start`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(missingCsrf.status, 403);

    const badOrigin = await fetch(`${baseUrl}/api/start`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': loginJson.csrfToken,
        Origin: 'https://evil.example',
      },
    });
    assert.equal(badOrigin.status, 403);

    // 8. SSRF guards block private IP, mapped IPv6, and DNS resolving to private IP
    for (const badUrl of [
      'http://169.254.169.254/latest/meta-data',
      'https://[::ffff:127.0.0.1]/feed.rss',
      'https://evil-dns.example/feed.rss',
    ]) {
      const badFeed = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': loginJson.csrfToken,
        },
        body: JSON.stringify({
          interval: 120,
          feeds: [badUrl],
          keywords: ['need a website'],
        }),
      });
      assert.equal(badFeed.status, 400, `Expected 400 for SSRF URL: ${badUrl}`);
    }

    // 9. Valid public HTTPS feed saves and never leaks bot_token
    const saveCfg = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': loginJson.csrfToken,
      },
      body: JSON.stringify({
        bot_token: '123456:AAH_DO_NOT_LEAK_THIS_TOKEN',
        chat_id: '987654321',
        interval: 90,
        feeds: ['https://www.reddit.com/r/forhire/.rss'],
        keywords: ['need a website'],
      }),
    });
    assert.equal(saveCfg.status, 200);

    const cfgRes = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: 'Bearer super-secret-operator-key' },
    });
    assert.equal(cfgRes.status, 200);
    const cfgBody = await cfgRes.text();
    assert.ok(!cfgBody.includes('AAH_DO_NOT_LEAK_THIS_TOKEN'), 'Raw bot token must never be returned');

    // 10. Signal PATCH enforces CSRF + validates IDs/statuses
    const seeded = db.insertLead({
      source_type: 'reddit',
      source_entity_id: 'https://www.reddit.com/r/forhire/comments/r1/post',
      source_channel: 'r/forhire',
      title: 'Hire web developer',
      url: 'https://www.reddit.com/r/forhire/comments/r1/post',
      matched_keyword: 'hire a developer',
      intent_score: 75,
      intent: 'high',
    }, sb.dbPath);

    const patchNoCsrf = await fetch(`${baseUrl}/api/signals/${seeded.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ status: 'contacted' }),
    });
    assert.equal(patchNoCsrf.status, 403);

    const patchOk = await fetch(`${baseUrl}/api/signals/${seeded.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': loginJson.csrfToken,
      },
      body: JSON.stringify({ status: 'contacted' }),
    });
    assert.equal(patchOk.status, 200);
  } finally {
    security.clearLoginAttemptsForTest();
    server.close();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.SONARS_ACCESS_KEY; else process.env.SONARS_ACCESS_KEY = prevKey;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
  }
});
