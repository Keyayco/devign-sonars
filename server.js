'use strict';

/**
 * server.js — SONARS (Signal Observation, Navigation, Analysis & Response System)
 * ───────────────────────────────────────────────────────────────────────────────
 * Express application entry point serving static Vanilla ES Module frontend,
 * authenticated operator APIs, SQLite storage, and Python worker SSE streams.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const db       = require('./lib/db');
const security = require('./lib/security');
const wm       = require('./lib/worker-manager');
const { createHealthRouter }  = require('./routes/health');
const { createSignalsRouter } = require('./routes/signals');
const { createMonitorRouter } = require('./routes/monitor');

const FRONTEND_DIR = path.join(__dirname, 'frontend');
const INDEX_HTML   = path.join(FRONTEND_DIR, 'index.html');

function createApp({
  basePath      = process.env.BASE_PATH || '',
  dbPath        = process.env.DB_PATH || undefined,
  configPath,
  seedPath,
  workerManager = wm,
} = {}) {
  const app  = express();
  const BASE = String(basePath || '').replace(/\/+$/, '');

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(security.securityHeaders);

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Malformed JSON error handler
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload exceeds 100kb limit' });
    }
    next(err);
  });

  // Unauthenticated health probes
  const healthRouter = createHealthRouter({ dbPath });
  app.use('/', healthRouter);
  if (BASE) {
    app.use(BASE, healthRouter);
  }

  // Operator authentication endpoints
  const authHandlers = security.createAuthHandlers();
  const authRouter   = express.Router();
  authRouter.get('/session', authHandlers.session);
  authRouter.post('/login',  authHandlers.login);
  authRouter.post('/logout', authHandlers.logout);
  app.use(BASE + '/api/auth', authRouter);

  // Authenticated Signal & Monitor APIs
  app.use(BASE + '/api/signals', createSignalsRouter({ dbPath }));
  app.use(BASE + '/api/leads',   createSignalsRouter({ dbPath }));
  app.use(BASE + '/api',         createMonitorRouter({ configPath, seedPath, dbPath, workerManager }));

  // Serve static Vanilla frontend shell (no secrets or data embedded)
  function serveDashboard(_req, res) {
    try {
      const html   = fs.readFileSync(INDEX_HTML, 'utf8');
      const inject = `<script>window.API_BASE=${JSON.stringify(BASE + '/api')};</script>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html.replace('</head>', inject + '\n</head>'));
    } catch {
      res.status(500).send('SONARS UI not found. Check frontend/index.html exists.');
    }
  }

  app.get(BASE + '/', serveDashboard);
  if (BASE) {
    app.get(BASE, serveDashboard);
    app.get('/', (_req, res) => res.redirect(BASE + '/'));
  }

  app.use(BASE + '/', express.static(FRONTEND_DIR, { index: false }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, _req, res, _next) => {
    console.error('[SERVER] Request error:', security.redactSecrets(err && err.message));
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

  // Ensure DB schema is initialized at boot
  db.getDb();

  if (process.env.NODE_ENV === 'production' && !(process.env.SONARS_ACCESS_KEY || '').trim()) {
    console.warn('[SECURITY] SONARS_ACCESS_KEY is unset in production — protected endpoints will return 503 until configured.');
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] SONARS running on http://0.0.0.0:${PORT}${BASE}/`);
    console.log(`[SERVER] PID=${process.pid} NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (err) => {
    console.error('[SERVER] listen error:', err.message);
    process.exit(1);
  });

  const shutdown = (sig) => {
    console.log(`[SERVER] Received ${sig} — shutting down gracefully`);
    wm.stopWorker();
    server.close(() => {
      db.closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 6000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('[SERVER] uncaughtException:', security.redactSecrets(err.message), err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[SERVER] unhandledRejection:', security.redactSecrets(String(reason)));
  });
}

module.exports = app;
module.exports.createApp = createApp;
