'use strict';

/**
 * routes/health.js — SONARS Health Check Routes
 * ─────────────────────────────────────────────
 * Unauthenticated endpoints for Render / Docker / load-balancer probes.
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
      return res.status(503).json({
        ok:     false,
        system: 'SONARS',
        db:     'error',
        error:  err.message,
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
