'use strict';

/**
 * routes/health.js — SONARS Health Check Routes
 * ─────────────────────────────────────────────
 * Unauthenticated endpoints for Render / Docker / load-balancer probes.
 * Never leaks internal DB paths or stack details on failure.
 */

const { Router } = require('express');
const db         = require('../lib/db');

function createHealthRouter({ dbPath } = {}) {
  const router = Router();

  function handler(_req, res) {
    try {
      const conn = db.getDb(dbPath);
      conn.prepare('SELECT 1').get();
      return res.json({
        ok:     true,
        system: 'SONARS',
        db:     'connected',
        ts:     new Date().toISOString(),
      });
    } catch (err) {
      console.error('[HEALTH] Database probe failed:', err && err.message);
      return res.status(503).json({
        ok:     false,
        system: 'SONARS',
        db:     'unavailable',
      });
    }
  }

  router.get('/health', handler);
  router.get('/healthz', handler);

  return router;
}

const defaultRouter = createHealthRouter();
defaultRouter.createHealthRouter = createHealthRouter;

module.exports = defaultRouter;
