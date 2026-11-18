'use strict';

/**
 * routes/monitor.js — SONARS Worker Control, SSE Stream & Config Routes
 * ─────────────────────────────────────────────────────────────────────
 * Mounted at BASE/api by server.js. All endpoints require operator auth.
 */

const { Router } = require('express');
const path       = require('path');
const wm         = require('../lib/worker-manager');
const db         = require('../lib/db');
const config     = require('../lib/config');
const security   = require('../lib/security');

function createMonitorRouter({
  configPath    = config.DEFAULT_CONFIG_PATH,
  seedPath,
  dbPath,
  workerManager = wm,
} = {}) {
  const router = Router();
  const resolvedSeedPath = seedPath || path.join(path.dirname(path.resolve(configPath)), '.worker_seed.json');

  router.use(security.requireAuth);

  router.get('/stream', (_req, res) => {
    workerManager.addSSEClient(res);
  });

  router.get('/status', (_req, res) => {
    res.json({
      running: workerManager.isRunning(),
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
    workerManager.startWorker(cfg, {
      configPath,
      seedPath: resolvedSeedPath,
      dbPath,
    });
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

  router.post('/config', (req, res) => {
    const validated = security.validateConfigPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ ok: false, error: validated.error });
    }

    const v   = validated.value;
    const cur = config.loadConfig(configPath);

    const next = {
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

    const saved = config.persistConfig(next, configPath);
    if (!saved) {
      return res.status(500).json({ ok: false, error: 'Could not write config file — check filesystem permissions' });
    }
    res.json({ ok: true, config: config.getSafeConfig(configPath) });
  });

  return router;
}

const defaultRouter = createMonitorRouter();
defaultRouter.createMonitorRouter = createMonitorRouter;

module.exports = defaultRouter;
