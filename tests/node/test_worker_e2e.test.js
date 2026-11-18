'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const http   = require('node:http');

const { createApp } = require('../../server');
const wm            = require('../../lib/worker-manager');
const db            = require('../../lib/db');

const RSS_FEED_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>r/forhire</title>
  <entry>
    <title>Developer disappeared — need a developer for Shopify store ASAP</title>
    <link href="https://www.reddit.com/r/forhire/comments/e2e1/need_shopify_dev/?utm_source=e2e" />
    <updated>2026-11-18T10:00:00Z</updated>
    <author><name>/u/e2e_client</name></author>
    <content type="html">&lt;p&gt;Paid project with budget approved. Need someone to build our ecommerce site urgently.&lt;/p&gt;</content>
  </entry>
</feed>`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

test('E2E: Express + real Python worker + local RSS HTTP feed -> SQLite + SSE stream + clean stop', async () => {
  const dir        = fs.mkdtempSync(path.join(os.tmpdir(), 'sonars-e2e-'));
  const dbPath     = path.join(dir, 'lead_monitor.db');
  const configPath = path.join(dir, 'monitor_config.json');
  const seedPath   = path.join(dir, '.worker_seed.json');

  const prevKey  = process.env.SONARS_ACCESS_KEY;
  const prevHttp = process.env.SONARS_ALLOW_HTTP_FEEDS;
  const prevEnv  = process.env.NODE_ENV;

  process.env.NODE_ENV = 'test';
  process.env.SONARS_ACCESS_KEY = 'e2e-operator-key';
  process.env.SONARS_ALLOW_HTTP_FEEDS = '1';

  // Local mock RSS server
  const rssServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(RSS_FEED_BODY);
  });
  const rssPort = await listen(rssServer);

  const app = createApp({
    dbPath,
    configPath,
    seedPath,
    workerManager: wm,
  });
  const appServer = http.createServer(app);
  const appPort   = await listen(appServer);
  const baseUrl   = `http://127.0.0.1:${appPort}`;

  let sseReq = null;
  try {
    // Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'e2e-operator-key' }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

    // Save config pointing to local RSS feed
    const cfgRes = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        interval: 30,
        feeds: [`http://127.0.0.1:${rssPort}/r/forhire/.rss`],
        keywords: ['need a developer', 'shopify'],
      }),
    });
    assert.equal(cfgRes.status, 200);

    // Open SSE stream to capture real-time lead event
    const receivedLeadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for SSE lead event')), 12000);
      sseReq = http.get(`${baseUrl}/api/stream`, { headers: { Cookie: cookie } }, (res) => {
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString('utf8');
          const frames = buf.split('\n\n');
          buf = frames.pop();
          for (const frame of frames) {
            if (frame.includes('event: lead')) {
              const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
              if (dataLine) {
                clearTimeout(timeout);
                resolve(JSON.parse(dataLine.slice(6)));
              }
            }
          }
        });
      });
      sseReq.on('error', reject);
    });

    // Start real Python worker subprocess
    const startRes = await fetch(`${baseUrl}/api/start`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    assert.equal(startJson.ok, true);

    const sseLead = await receivedLeadPromise;
    assert.equal(sseLead.intent, 'high');
    assert.ok(sseLead.intent_score >= 70);
    assert.equal(sseLead.source_entity_id, 'https://www.reddit.com/r/forhire/comments/e2e1/need_shopify_dev');

    // Verify persisted in SQLite via /api/signals
    const listRes = await fetch(`${baseUrl}/api/signals`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.signals.length, 1);
    assert.equal(listJson.signals[0].opportunity_type, 'active_buying_intent');

    // Verify monitor_config.json does NOT contain seen_post_ids
    const savedCfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedCfgOnDisk.seen_post_ids, undefined);

    // Stop worker cleanly
    const stopRes = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(stopRes.status, 200);

    // Wait briefly for SIGTERM exit
    for (let i = 0; i < 30 && wm.isRunning(); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(wm.isRunning(), false);
  } finally {
    if (sseReq) sseReq.destroy();
    wm.stopWorker();
    appServer.close();
    rssServer.close();
    db.closeDb(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.SONARS_ACCESS_KEY; else process.env.SONARS_ACCESS_KEY = prevKey;
    if (prevHttp === undefined) delete process.env.SONARS_ALLOW_HTTP_FEEDS; else process.env.SONARS_ALLOW_HTTP_FEEDS = prevHttp;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});
