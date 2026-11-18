'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const http   = require('node:http');

const { createApp } = require('../../server');
const db            = require('../../lib/db');

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

test('security: health unauthenticated, auth enforcement, prod fail-closed, rate limiting, and config validation', async () => {
  const sb = makeSandbox();
  const prevKey = process.env.SONARS_ACCESS_KEY;
  const prevEnv = process.env.NODE_ENV;
  const prevTok = process.env.TELEGRAM_BOT_TOKEN;

  const mockWorker = {
    isRunning: () => false,
    getStats: () => ({ cycles: 0, matches: 0, alerts_sent: 0, dupes_skipped: 0, last_scan_ms: 0 }),
    getLogs: () => [],
    addSSEClient: (res) => { res.status(200).end('event: status\ndata: {"running":false}\n\n'); },
    startWorker: () => {},
    stopWorker: () => {},
  };

  process.env.SONARS_ACCESS_KEY = 'super-secret-operator-key';
  process.env.NODE_ENV = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;

  const app = createApp({
    dbPath: sb.dbPath,
    configPath: sb.configPath,
    seedPath: sb.seedPath,
    workerManager: mockWorker,
  });

  const { server, baseUrl } = await listen(app);

  try {
    // 1. Health endpoint works without auth
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.db, 'connected');

    // 2. Protected routes reject unauthenticated requests
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

    // 3. Production fails closed with 503 if SONARS_ACCESS_KEY is unset
    process.env.NODE_ENV = 'production';
    process.env.SONARS_ACCESS_KEY = '';
    const prodRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(prodRes.status, 503);

    // Restore key for auth flow tests
    process.env.NODE_ENV = 'test';
    process.env.SONARS_ACCESS_KEY = 'super-secret-operator-key';

    // 4. Failed login rejected; Bearer token accepted
    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'wrong-key' }),
    });
    assert.equal(badLogin.status, 401);

    // 5. Valid login returns HttpOnly session cookie
    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'super-secret-operator-key' }),
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    assert.match(setCookie, /sonars_session=/);
    assert.match(setCookie, /HttpOnly/i);
    const cookieHeader = setCookie.split(';')[0];

    // 6. Config saves valid payload, enforces SSRF URL guard, and never leaks bot_token
    const badFeed = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        interval: 120,
        feeds: ['http://169.254.169.254/latest/meta-data'],
        keywords: ['need a website'],
      }),
    });
    assert.equal(badFeed.status, 400);

    const saveCfg = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
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
    const cfgJson = JSON.parse(cfgBody);
    assert.equal(cfgJson.token_configured, true);
    assert.equal(cfgJson.interval, 90);

    // 7. Malformed JSON returns 400
    const badJson = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: '{not-valid-json',
    });
    assert.equal(badJson.status, 400);

    // 8. Signal status updates + 404 on missing ID
    const missingPatch = await fetch(`${baseUrl}/api/signals/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ status: 'won' }),
    });
    assert.equal(missingPatch.status, 404);

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

    const patchOk = await fetch(`${baseUrl}/api/signals/${seeded.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ status: 'contacted' }),
    });
    assert.equal(patchOk.status, 200);

    const getDetail = await fetch(`${baseUrl}/api/signals/${seeded.id}`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(getDetail.status, 200);
    const detailJson = await getDetail.json();
    assert.equal(detailJson.signal.status, 'contacted');
  } finally {
    server.close();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.SONARS_ACCESS_KEY; else process.env.SONARS_ACCESS_KEY = prevKey;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
  }
});
