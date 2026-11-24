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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonars-disc-'));
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

test('discovery routes: auth/CSRF, source status, CIPC missing creds, OSM run persistence, POPIA review, and pagination', async () => {
  const sb = makeSandbox();
  const prevKey = process.env.SONARS_ACCESS_KEY;
  const prevEnv = process.env.NODE_ENV;
  process.env.SONARS_ACCESS_KEY = 'disc-test-key';
  process.env.NODE_ENV = 'test';
  security.clearLoginAttemptsForTest();

  const mockRunner = async (payload) => {
    if (payload.action === 'status') {
      return {
        ok: true,
        cipc: {
          source: 'cipc',
          name: 'CIPC APIVerse Companies API',
          enabled: false,
          configured: false,
          ready: false,
          missing: ['CIPC_CLIENT_ID', 'CIPC_CLIENT_SECRET', 'CIPC_TOKEN_URL', 'CIPC_API_BASE_URL', 'CIPC_SEARCH_PATH'],
          reason: 'CIPC adapter is disabled',
        },
        osm: {
          source: 'osm',
          name: 'OpenStreetMap Overpass Business Discovery',
          enabled: true,
          configured: true,
          ready: true,
          attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
          areas: [{ key: 'cape_town_cbd', label: 'Cape Town CBD', region: 'Cape Town, WC', bbox: [-33.95, 18.38, -33.9, 18.46] }],
          categories: [{ key: 'retail_shops', label: 'Retail Shops' }],
        },
      };
    }

    if (payload.source === 'cipc') {
      return {
        ok: false,
        status_code: 503,
        error: 'CIPC adapter is disabled (set CIPC_ENABLED=true after completing APIVerse subscription).',
      };
    }

    if (payload.source === 'osm') {
      return {
        ok: true,
        source: 'osm',
        attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
        metrics: { area: 'cape_town_cbd', elements_received: 3, signals_emitted: 3 },
        signals: [
          {
            source_type: 'osm',
            source_entity_id: 'node/101',
            source_channel: 'osm:Cape Town',
            entity_name: 'Signal Bakery',
            title: 'Signal Bakery — shop:bakery (no website listed)',
            content: 'Business: Signal Bakery\nWebsite Tag: None listed',
            url: 'https://www.openstreetmap.org/node/101',
            matched_keyword: 'retail_shops:shop:bakery',
            created_utc: 1760000100,
            collected_utc: 1760000100,
            observation_type: 'digital_presence_gap',
            attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
            category: 'shop:bakery',
            country_or_region: 'Cape Town',
            intent_score: 0,
            intent: 'low',
            lead_value: 62,
            fit_score: 62,
            confidence_score: 82,
            opportunity_type: 'digital_need',
          },
          {
            source_type: 'osm',
            source_entity_id: 'node/102',
            source_channel: 'osm:Cape Town',
            entity_name: 'Bay Books',
            title: 'Bay Books — shop:books (no website listed)',
            content: 'Business: Bay Books',
            url: 'https://www.openstreetmap.org/node/102',
            matched_keyword: 'retail_shops:shop:books',
            created_utc: 1760000200,
            collected_utc: 1760000200,
            observation_type: 'digital_presence_gap',
            attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
            category: 'shop:books',
            country_or_region: 'Cape Town',
            intent_score: 0,
            intent: 'low',
            lead_value: 62,
            fit_score: 62,
            confidence_score: 80,
            opportunity_type: 'digital_need',
          },
          {
            source_type: 'osm',
            source_entity_id: 'node/103',
            source_channel: 'osm:Cape Town',
            entity_name: 'Ocean Optometry',
            title: 'Ocean Optometry — shop:optician',
            content: 'Business: Ocean Optometry',
            url: 'https://www.openstreetmap.org/node/103',
            matched_keyword: 'retail_shops:shop:optician',
            created_utc: 1760000300,
            collected_utc: 1760000300,
            observation_type: 'contact_information_found',
            attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
            category: 'shop:optician',
            country_or_region: 'Cape Town',
            intent_score: 0,
            intent: 'low',
            lead_value: 45,
            fit_score: 45,
            confidence_score: 85,
            opportunity_type: 'entity_exists',
          },
        ],
      };
    }

    return { ok: false, status_code: 400, error: 'Unknown source' };
  };

  const mockWorker = {
    isRunning: () => false,
    getState:  () => 'stopped',
    getStats:  () => ({}),
    getLogs:   () => [],
    addSSEClient: (res) => res.status(200).end(''),
  };

  const app = createApp({
    dbPath: sb.dbPath,
    configPath: sb.configPath,
    seedPath: sb.seedPath,
    workerManager: mockWorker,
    runDiscovery: mockRunner,
  });

  const { server, baseUrl } = await listen(app);

  try {
    // 1. Unauthenticated discovery routes fail with 401
    for (const [m, p] of [
      ['GET', '/api/discovery/sources'],
      ['GET', '/api/discovery/runs'],
      ['POST', '/api/discovery/cipc/search'],
      ['POST', '/api/discovery/osm/run'],
      ['PATCH', '/api/signals/1/review'],
    ]) {
      const res = await fetch(`${baseUrl}${p}`, { method: m });
      assert.equal(res.status, 401, `${m} ${p} must require auth`);
    }

    // Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'disc-test-key' }),
    });
    const { csrfToken } = await loginRes.json();
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    const authHeaders = {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken,
    };

    // 2. Source status endpoint works and reports Reddit/CIPC/OSM readiness
    const srcRes = await fetch(`${baseUrl}/api/discovery/sources`, { headers: { Cookie: cookie } });
    assert.equal(srcRes.status, 200);
    const srcJson = await srcRes.json();
    assert.equal(srcJson.sources.cipc.ready, false);
    assert.equal(srcJson.sources.osm.ready, true);
    assert.match(srcJson.sources.osm.attribution, /ODbL/);

    // 3. CIPC search without credentials returns clean 503 and logs failed run
    const cipcFail = await fetch(`${baseUrl}/api/discovery/cipc/search`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ query: 'Devign' }),
    });
    assert.equal(cipcFail.status, 503);
    const cipcJson = await cipcFail.json();
    assert.equal(cipcJson.ok, false);
    assert.match(cipcJson.error, /disabled/i);

    // 4. OSM discovery persists records & returns attribution
    const osmRes = await fetch(`${baseUrl}/api/discovery/osm/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ area: 'cape_town_cbd', category: 'retail_shops', limit: 25 }),
    });
    assert.equal(osmRes.status, 200);
    const osmJson = await osmRes.json();
    assert.equal(osmJson.ok, true);
    assert.equal(osmJson.found, 3);
    assert.equal(osmJson.inserted, 3);
    assert.match(osmJson.attribution, /OpenStreetMap contributors/);

    // 5. Re-running same OSM query deduplicates cleanly
    const osmRes2 = await fetch(`${baseUrl}/api/discovery/osm/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ area: 'cape_town_cbd', category: 'retail_shops', limit: 25 }),
    });
    const osmJson2 = await osmRes2.json();
    assert.equal(osmJson2.inserted, 0);
    assert.equal(osmJson2.dupes_skipped, 3);

    // 6. Paginated /api/signals works with limit + offset + total
    const page1 = await fetch(`${baseUrl}/api/signals?source=osm&limit=2&offset=0`, { headers: { Cookie: cookie } });
    const p1Json = await page1.json();
    assert.equal(p1Json.signals.length, 2);
    assert.equal(p1Json.total, 3);

    const page2 = await fetch(`${baseUrl}/api/signals?source=osm&limit=2&offset=2`, { headers: { Cookie: cookie } });
    const p2Json = await page2.json();
    assert.equal(p2Json.signals.length, 1);
    assert.equal(p2Json.total, 3);

    // 7. PATCH /api/signals/:id/review enforces POPIA review & suppression
    const targetId = p1Json.signals[0].id;
    const revRes = await fetch(`${baseUrl}/api/signals/${targetId}/review`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        review_status: 'suppressed',
        suppressed: true,
        review_notes: 'Business opted out',
      }),
    });
    assert.equal(revRes.status, 200);
    const revJson = await revRes.json();
    assert.equal(revJson.signal.suppressed, 1);
    assert.equal(revJson.signal.contact_eligible, 0);

    // 8. Verify buying_intent vs entity_discovery separation in /api/signals and /api/status
    db.insertLead({
      source_type: 'reddit',
      source_entity_id: 'https://www.reddit.com/r/forhire/comments/999/test',
      source_channel: 'r/forhire',
      title: 'Hire a developer ASAP',
      observation_type: 'buying_intent_signal',
      intent_score: 84,
      intent: 'high',
      lead_value: 80,
      fit_score: 80,
      confidence_score: 85,
      opportunity_type: 'active_buying_intent',
    }, sb.dbPath);

    const buyRes = await fetch(`${baseUrl}/api/signals?record_kind=buying_intent`, { headers: { Cookie: cookie } });
    const buyJson = await buyRes.json();
    assert.equal(buyJson.total, 1);
    assert.equal(buyJson.signals[0].source_type, 'reddit');

    const discRes = await fetch(`${baseUrl}/api/signals?record_kind=entity_discovery`, { headers: { Cookie: cookie } });
    const discJson = await discRes.json();
    assert.equal(discJson.total, 3);
    assert.ok(discJson.signals.every(s => s.source_type === 'osm' && s.intent_score === 0));

    const statusRes = await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } });
    const statusJson = await statusRes.json();
    assert.equal(statusJson.db.buying_intent_total, 1);
    assert.equal(statusJson.db.entity_discovery_total, 3);
    assert.equal(statusJson.db.avg_score, 84);

    // 9. Discovery runs history records both failed CIPC and completed OSM runs
    const runsRes = await fetch(`${baseUrl}/api/discovery/runs`, { headers: { Cookie: cookie } });
    const runsJson = await runsRes.json();
    assert.equal(runsJson.runs.length, 3);
  } finally {
    security.clearLoginAttemptsForTest();
    server.close();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.SONARS_ACCESS_KEY; else process.env.SONARS_ACCESS_KEY = prevKey;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});

test('discovery routes redact accidental credentials in error responses and persisted run logs', async () => {
  const sb = makeSandbox();
  const prevKey = process.env.SONARS_ACCESS_KEY;
  process.env.SONARS_ACCESS_KEY = 'redact-test-key';
  security.clearLoginAttemptsForTest();

  const leakingRunner = async () => ({
    ok: false,
    status_code: 502,
    error: 'Upstream failed CIPC_CLIENT_SECRET=super-secret-xyz Bearer tok_abc123',
  });

  const app = createApp({
    dbPath: sb.dbPath,
    configPath: sb.configPath,
    seedPath: sb.seedPath,
    workerManager: { isRunning: () => false, getStats: () => ({}), getLogs: () => [], addSSEClient: r => r.end() },
    runDiscovery: leakingRunner,
  });

  const { server, baseUrl } = await listen(app);
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'redact-test-key' }),
    });
    const { csrfToken } = await loginRes.json();
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

    const res = await fetch(`${baseUrl}/api/discovery/cipc/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ query: 'TestCo' }),
    });
    assert.equal(res.status, 502);
    const bodyText = await res.text();
    assert.ok(!bodyText.includes('super-secret-xyz'));
    assert.ok(!bodyText.includes('tok_abc123'));

    const runs = db.getDiscoveryRuns(5, sb.dbPath);
    assert.equal(runs.length, 1);
    assert.ok(!runs[0].error_message.includes('super-secret-xyz'));
    assert.ok(!runs[0].error_message.includes('tok_abc123'));
  } finally {
    security.clearLoginAttemptsForTest();
    server.close();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.SONARS_ACCESS_KEY; else process.env.SONARS_ACCESS_KEY = prevKey;
  }
});
