'use strict';

/**
 * routes/monitor.js — SONARS Worker Control, SSE Stream & Config Routes
 * ─────────────────────────────────────────────────────────────────────
 * Mounted at BASE/api by server.js. All endpoints require operator auth
 * and CSRF verification on state-changing routes.
 */

const { Router } = require('express');
const path       = require('path');
const wm         = require('../lib/worker-manager');
const db         = require('../lib/db');
const config     = require('../lib/config');
const security   = require('../lib/security');

function createMonitorRouter({
  configPath         = config.DEFAULT_CONFIG_PATH,
  seedPath,
  dbPath,
  workerManager      = wm,
  feedLookup,
  allowTestFeeds     = false,
} = {}) {
  const router = Router();
  const resolvedSeedPath = seedPath || path.join(path.dirname(path.resolve(configPath)), '.worker_seed.json');

  router.use(security.requireAuth);
  router.use(security.verifyCsrf);

  router.get('/stream', (_req, res) => {
    workerManager.addSSEClient(res);
  });

  router.get('/status', (_req, res) => {
    res.json({
      running: workerManager.isRunning(),
      state:   typeof workerManager.getState === 'function' ? workerManager.getState() : (workerManager.isRunning() ? 'running' : 'stopped'),
      stats:   workerManager.getStats(),
      db:      db.getDbStats(dbPath),
    });
  });

  router.get('/logs', (_req, res) => {
    res.json({ lines: workerManager.getLogs() });
  });

  router.post('/start', (_req, res) => {
    if (workerManager.isRunning()) {
      return res.json({ ok: false, msg: 'Monitor is already running' });
    }
    const cfg = config.loadConfig(configPath);
    const started = workerManager.startWorker(cfg, {
      configPath,
      seedPath: resolvedSeedPath,
      dbPath,
    });
    if (!started) {
      return res.json({ ok: false, msg: 'Monitor is shutting down — try again shortly' });
    }
    res.json({ ok: true });
  });

  router.post('/stop', (_req, res) => {
    if (!workerManager.isRunning()) {
      return res.json({ ok: false, msg: 'Monitor is not running' });
    }
    workerManager.stopWorker();
    res.json({ ok: true });
  });

  router.get('/config', (_req, res) => {
    res.json(config.getSafeConfig(configPath));
  });

  router.post('/config', async (req, res, next) => {
    try {
      const validated = await security.validateConfigPayload(req.body, {
        lookup: feedLookup,
        allowPrivateForTest: allowTestFeeds === true && process.env.NODE_ENV !== 'production',
      });
      if (validated.error) {
        return res.status(400).json({ ok: false, error: validated.error });
      }

      const v   = validated.value;
      const cur = config.loadConfig(configPath);

      const nextCfg = {
        bot_token: v.bot_token !== undefined
          ? (v.bot_token || (process.env.TELEGRAM_BOT_TOKEN ? '' : cur.bot_token))
          : (process.env.TELEGRAM_BOT_TOKEN ? '' : cur.bot_token),
        chat_id: v.chat_id !== undefined
          ? (v.chat_id || (process.env.TELEGRAM_CHAT_ID ? '' : cur.chat_id))
          : (process.env.TELEGRAM_CHAT_ID ? '' : cur.chat_id),
        interval: v.interval !== undefined ? v.interval : cur.interval,
        feeds:    v.feeds    !== undefined ? v.feeds    : cur.feeds,
        keywords: v.keywords !== undefined ? v.keywords : cur.keywords,
      };

      const saved = config.persistConfig(nextCfg, configPath);
      if (!saved) {
        return res.status(500).json({ ok: false, error: 'Could not write config file — check filesystem permissions' });
      }
      res.json({ ok: true, config: config.getSafeConfig(configPath) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const defaultRouter = createMonitorRouter();
defaultRouter.createMonitorRouter = createMonitorRouter;

module.exports = defaultRouter;
