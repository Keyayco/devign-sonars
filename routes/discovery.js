'use strict';

/**
 * routes/discovery.js — SONARS Source Discovery & POPIA Control API
 * ──────────────────────────────────────────────────────────────────
 * Mounted at BASE/api/discovery by server.js.
 * Protected by operator authentication & CSRF validation.
 */

const { Router } = require('express');
const db         = require('../lib/db');
const config     = require('../lib/config');
const security   = require('../lib/security');
const wm         = require('../lib/worker-manager');
const { runDiscoveryCommand } = require('../lib/discovery-runner');

function createDiscoveryRouter({
  dbPath,
  configPath    = config.DEFAULT_CONFIG_PATH,
  workerManager = wm,
  runDiscovery  = runDiscoveryCommand,
} = {}) {
  const router = Router();

  router.use(security.requireAuth);
  router.use(security.verifyCsrf);

  router.get('/sources', async (_req, res, next) => {
    try {
      const status = await runDiscovery({ action: 'status' });
      const cfg = config.loadConfig(configPath);
      const reddit = {
        source: 'reddit',
        name: 'Reddit RSS Feeds',
        enabled: Array.isArray(cfg.feeds) && cfg.feeds.length > 0,
        configured: Array.isArray(cfg.feeds) && cfg.feeds.length > 0,
        ready: Array.isArray(cfg.feeds) && cfg.feeds.length > 0,
        worker_running: typeof workerManager.isRunning === 'function' ? workerManager.isRunning() : false,
        feeds_count: Array.isArray(cfg.feeds) ? cfg.feeds.length : 0,
        keywords_count: Array.isArray(cfg.keywords) ? cfg.keywords.length : 0,
      };
      const cipc = (status && status.cipc) || {
        source: 'cipc',
        name: 'CIPC APIVerse Companies API',
        enabled: false,
        configured: false,
        ready: false,
        missing: ['CIPC_CLIENT_ID', 'CIPC_CLIENT_SECRET', 'CIPC_TOKEN_URL', 'CIPC_API_BASE_URL', 'CIPC_SEARCH_PATH'],
        reason: 'CIPC adapter status unavailable',
      };
      const osm = (status && status.osm) || {
        source: 'osm',
        name: 'OpenStreetMap Overpass Business Discovery',
        enabled: true,
        configured: true,
        ready: true,
        attribution: '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
      };

      res.json({
        sources: { reddit, cipc, osm },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/runs', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({ runs: db.getDiscoveryRuns(limit, dbPath) });
  });

  router.get('/suppression', (_req, res) => {
    res.json({ entries: db.getSuppressionList(dbPath) });
  });

  function persistDiscoverySignals(source, params, result) {
    const rawSignals = Array.isArray(result.signals) ? result.signals : [];
    const insertedSignals = [];
    let dupesSkipped = 0;
    let suppressedSkipped = 0;

    for (const sig of rawSignals) {
      if (db.isEntitySuppressed(sig.source_type || source, sig.source_entity_id, dbPath)) {
        suppressedSkipped += 1;
        continue;
      }
      const inserted = db.insertLead(sig, dbPath);
      if (inserted) {
        insertedSignals.push(inserted);
      } else {
        dupesSkipped += 1;
      }
    }

    const run = db.recordDiscoveryRun({
      source_type: source,
      query_params: params,
      status: 'completed',
      found_count: rawSignals.length,
      inserted_count: insertedSignals.length,
      dupes_skipped: dupesSkipped + suppressedSkipped,
      attribution: result.attribution || null,
    }, dbPath);

    return {
      insertedSignals,
      foundCount: rawSignals.length,
      dupesSkipped,
      suppressedSkipped,
      run,
    };
  }

  router.post('/cipc/search', async (req, res, next) => {
    try {
      const validated = security.validateDiscoveryCipcPayload(req.body);
      if (validated.error) {
        return res.status(400).json({ ok: false, error: validated.error });
      }
      const params = validated.value;
      const result = await runDiscovery({ source: 'cipc', params });

      if (!result || !result.ok) {
        const code = (result && result.status_code) || 503;
        const msg = (result && result.error) || 'CIPC discovery failed';
        db.recordDiscoveryRun({
          source_type: 'cipc',
          query_params: params,
          status: 'failed',
          error_message: msg,
        }, dbPath);
        return res.status(code).json({
          ok: false,
          source: 'cipc',
          error: msg,
          retry_after: result ? result.retry_after : undefined,
        });
      }

      const persisted = persistDiscoverySignals('cipc', params, result);
      return res.json({
        ok: true,
        source: 'cipc',
        found: persisted.foundCount,
        inserted: persisted.insertedSignals.length,
        dupes_skipped: persisted.dupesSkipped,
        suppressed_skipped: persisted.suppressedSkipped,
        signals: persisted.insertedSignals,
        all_found: result.signals,
        metrics: result.metrics || {},
        attribution: result.attribution || 'CIPC APIVerse Companies API',
        run: persisted.run,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/osm/run', async (req, res, next) => {
    try {
      const validated = security.validateDiscoveryOsmPayload(req.body);
      if (validated.error) {
        return res.status(400).json({ ok: false, error: validated.error });
      }
      const params = validated.value;
      const result = await runDiscovery({ source: 'osm', params });

      if (!result || !result.ok) {
        const code = (result && result.status_code) || 502;
        const msg = (result && result.error) || 'OSM discovery failed';
        db.recordDiscoveryRun({
          source_type: 'osm',
          query_params: params,
          status: 'failed',
          error_message: msg,
        }, dbPath);
        return res.status(code).json({
          ok: false,
          source: 'osm',
          error: msg,
          retry_after: result ? result.retry_after : undefined,
        });
      }

      const persisted = persistDiscoverySignals('osm', params, result);
      return res.json({
        ok: true,
        source: 'osm',
        found: persisted.foundCount,
        inserted: persisted.insertedSignals.length,
        dupes_skipped: persisted.dupesSkipped,
        suppressed_skipped: persisted.suppressedSkipped,
        signals: persisted.insertedSignals,
        all_found: result.signals,
        metrics: result.metrics || {},
        attribution: result.attribution || '© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)',
        run: persisted.run,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/retention/purge', (_req, res) => {
    const result = db.purgeExpiredRecords(Math.floor(Date.now() / 1000), dbPath);
    res.json({ ok: true, deleted: result.deleted });
  });

  return router;
}

const defaultRouter = createDiscoveryRouter();
defaultRouter.createDiscoveryRouter = createDiscoveryRouter;

module.exports = defaultRouter;
