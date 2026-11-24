'use strict';

/**
 * routes/signals.js — SONARS Signals / Leads API
 * ───────────────────────────────────────────────
 * Mounted at BASE/api/signals and BASE/api/leads.
 * Protected by operator authentication & CSRF validation.
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
  router.use(security.verifyCsrf);

  router.get('/', (req, res) => {
    const {
      intent,
      source,
      opportunity,
      observation_type,
      record_kind,
      review_status,
      status,
      suppressed,
      q,
      sort,
      limit,
      offset,
    } = req.query;
    const filters = {
      intent,
      source,
      opportunity,
      observation_type,
      record_kind,
      review_status,
      status,
      suppressed,
      q,
    };
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const signals = db.getLeads(
      { ...filters, sort, limit: safeLimit, offset: safeOffset },
      dbPath,
    );
    const total = db.countLeads(filters, dbPath);
    res.json({
      signals,
      leads: signals,
      total,
      limit: safeLimit,
      offset: safeOffset,
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

  router.patch('/:id/review', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid signal id' });

    const validated = security.validateReviewPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const outcome = db.updateLeadReview(id, validated.value, dbPath);
    if (outcome.error) {
      return res.status(outcome.code || 400).json({ error: outcome.error });
    }

    res.json({ ok: true, signal: outcome.signal });
  });

  return router;
}

const defaultRouter = createSignalsRouter();
defaultRouter.createSignalsRouter = createSignalsRouter;

module.exports = defaultRouter;
