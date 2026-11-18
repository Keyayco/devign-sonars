'use strict';

/**
 * routes/signals.js — SONARS Signals / Leads API
 * ───────────────────────────────────────────────
 * Mounted at BASE/api/signals and BASE/api/leads.
 * Protected by operator authentication middleware.
 */

const { Router } = require('express');
const db         = require('../lib/db');
const security   = require('../lib/security');

function parseId(raw) {
  if (!/^\d+$/.test(String(raw || '').trim())) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function createSignalsRouter({ dbPath } = {}) {
  const router = Router();

  router.use(security.requireAuth);

  router.get('/', (req, res) => {
    const { intent, source, opportunity, status, q, sort, limit } = req.query;
    const signals = db.getLeads(
      { intent, source, opportunity, status, q, sort, limit },
      dbPath,
    );
    res.json({
      signals,
      leads: signals,
      total: signals.length,
    });
  });

  router.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid signal id' });

    const signal = db.getLeadById(id, dbPath);
    if (!signal) return res.status(404).json({ error: 'Signal not found' });

    res.json({ signal, lead: signal });
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid signal id' });

    const validated = security.validateStatusPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const result = db.updateLeadStatus(id, validated.value, dbPath);
    if (!result || result.changes === 0) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    res.json({ ok: true, id, status: validated.value });
  });

  return router;
}

const defaultRouter = createSignalsRouter();
defaultRouter.createSignalsRouter = createSignalsRouter;

module.exports = defaultRouter;
