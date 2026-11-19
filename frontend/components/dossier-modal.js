/**
 * frontend/components/dossier-modal.js — SONARS Signal Evidence & POPIA Review Dossier
 */

import { esc, getScores, OPP_LABELS, OBS_LABELS, REVIEW_LABELS } from './signals-view.js';

function parseBreakdown(signal) {
  if (signal.score_breakdown_parsed) return signal.score_breakdown_parsed;
  if (typeof signal.score_breakdown === 'string') {
    try { return JSON.parse(signal.score_breakdown); } catch {}
  }
  return null;
}

function renderFactorList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<span class="meta-text">No factor records captured</span>';
  }
  return '<div class="factor-list">' + list.map(item => {
    const text = String(item);
    const cls = text.startsWith('+') ? 'pos' : text.startsWith('-') ? 'neg' : '';
    return `<span class="factor-item ${cls}">${esc(text)}</span>`;
  }).join('') + '</div>';
}

function formatEpoch(epoch) {
  if (!epoch) return '—';
  try {
    return new Date(Number(epoch) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return '—';
  }
}

export function createDossierModal(backdropEl, { onStatusChange, onReviewChange, onCopyUrl }) {
  const kickerEl = backdropEl.querySelector('#dossier-kicker');
  const titleEl  = backdropEl.querySelector('#dossier-title');
  const bodyEl   = backdropEl.querySelector('#dossier-body');
  const closeBtn = backdropEl.querySelector('#dossier-close-btn');

  let currentSignal = null;

  function close() {
    backdropEl.hidden = true;
    currentSignal = null;
  }

  closeBtn.addEventListener('click', close);
  backdropEl.addEventListener('click', e => {
    if (e.target === backdropEl) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !backdropEl.hidden) close();
  });

  bodyEl.addEventListener('change', e => {
    const sel = e.target.closest('#dossier-status-select');
    if (sel && currentSignal) {
      onStatusChange?.(currentSignal.id, sel.value);
      return;
    }
    const revSel = e.target.closest('#dossier-review-select');
    const eligibleChk = bodyEl.querySelector('#dossier-contact-eligible');
    if (revSel && eligibleChk && currentSignal) {
      if (revSel.value !== 'approved' || currentSignal.is_personal_info) {
        eligibleChk.checked = false;
        eligibleChk.disabled = true;
      } else {
        eligibleChk.disabled = false;
      }
    }
  });

  bodyEl.addEventListener('click', async e => {
    const copyBtn = e.target.closest('#dossier-copy-btn');
    if (copyBtn && currentSignal && currentSignal.url) {
      onCopyUrl?.(currentSignal.url);
      return;
    }

    const saveReviewBtn = e.target.closest('#dossier-save-review-btn');
    if (saveReviewBtn && currentSignal) {
      const reviewStatus = bodyEl.querySelector('#dossier-review-select').value;
      const notes = bodyEl.querySelector('#dossier-review-notes').value.trim();
      const contactEligible = Boolean(bodyEl.querySelector('#dossier-contact-eligible').checked);
      saveReviewBtn.disabled = true;
      try {
        const updated = await onReviewChange?.(currentSignal.id, {
          review_status: reviewStatus,
          review_notes: notes || null,
          suppressed: reviewStatus === 'suppressed',
          contact_eligible: contactEligible,
        });
        if (updated) open(updated);
      } finally {
        saveReviewBtn.disabled = false;
      }
      return;
    }

    const suppressBtn = e.target.closest('#dossier-suppress-btn');
    if (suppressBtn && currentSignal) {
      const notes = bodyEl.querySelector('#dossier-review-notes').value.trim();
      suppressBtn.disabled = true;
      try {
        const updated = await onReviewChange?.(currentSignal.id, {
          review_status: 'suppressed',
          suppressed: true,
          contact_eligible: false,
          review_notes: notes || 'Suppressed via operator dossier (POPIA / Do-Not-Contact)',
        });
        if (updated) open(updated);
      } finally {
        suppressBtn.disabled = false;
      }
    }
  });

  function open(signal) {
    if (!signal) return;
    currentSignal = signal;

    const { intentScore, fitScore, confScore } = getScores(signal);
    const opp      = signal.opportunity_type || 'unclassified';
    const oppLabel = OPP_LABELS[opp] || opp;
    const obs      = signal.observation_type || 'buying_intent_signal';
    const obsLabel = OBS_LABELS[obs] || obs;
    const rev      = signal.suppressed ? 'suppressed' : (signal.review_status || 'pending_review');
    const revLabel = REVIEW_LABELS[rev] || rev;
    const bd       = parseBreakdown(signal);
    const srcType  = (signal.source_type || 'reddit').toUpperCase();
    const srcChan  = signal.source_channel || signal.subreddit || '';
    const entity   = signal.entity_name ? ` · ${signal.entity_name}` : '';
    const valueFactors = (bd && (bd.value_factors || bd.fit_factors)) || [];
    const attribution = signal.attribution || (bd && bd.attribution) || 'Internal collection';
    const canApproveContact = rev === 'approved' && !signal.suppressed && !signal.is_personal_info;

    kickerEl.textContent = `${srcType} · ${srcChan}${entity} · ${obsLabel} · ${oppLabel}`;
    titleEl.textContent  = signal.title || 'Untitled Signal';

    bodyEl.innerHTML = `
      <div class="dossier-section">
        <div class="dossier-lbl">Qualification &amp; Prospecting Recommendation</div>
        <div class="dossier-metrics">
          <div>Buying Intent: <strong>${intentScore}/100</strong> (${esc(signal.intent)})</div>
          <div>Commercial Fit: <strong>${fitScore}/100</strong></div>
          <div>Confidence: <strong>${confScore}/100</strong></div>
          <div>Observation: <strong>${esc(obsLabel)}</strong></div>
        </div>
        ${bd && bd.recommended_action
          ? `<div class="dossier-action"><strong>Recommended Action:</strong> ${esc(bd.recommended_action)}</div>`
          : ''}
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">Provenance, Attribution &amp; Retention Metadata</div>
        <div class="dossier-metrics">
          <div>Attribution: <strong>${esc(attribution)}</strong></div>
          <div>Collected: <strong>${esc(formatEpoch(signal.collected_utc || signal.created_utc))}</strong></div>
          <div>Retention Until: <strong>${esc(formatEpoch(signal.retention_until))}</strong></div>
          ${signal.country_or_region ? `<div>Region: <strong>${esc(signal.country_or_region)}</strong></div>` : ''}
        </div>
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">POPIA Human Review &amp; Suppression Guardrail (${esc(revLabel)})</div>
        <div class="disc-form">
          <div class="toolbar-row">
            <label class="chk-label">
              Review Decision:
              <select id="dossier-review-select" class="select-sm">
                <option value="pending_review" ${rev === 'pending_review' ? 'selected' : ''}>Pending Review</option>
                <option value="approved"       ${rev === 'approved'       ? 'selected' : ''}>Approved for Qualification</option>
                <option value="hold"           ${rev === 'hold'           ? 'selected' : ''}>Hold / Insufficient Evidence</option>
                <option value="rejected"       ${rev === 'rejected'       ? 'selected' : ''}>Rejected</option>
                <option value="suppressed"     ${rev === 'suppressed'     ? 'selected' : ''}>Suppressed (Do Not Contact)</option>
              </select>
            </label>
            <label class="chk-label">
              <input
                type="checkbox"
                id="dossier-contact-eligible"
                ${signal.contact_eligible && canApproveContact ? 'checked' : ''}
                ${canApproveContact ? '' : 'disabled'}
              />
              Eligible for human-initiated business contact
            </label>
          </div>
          <input
            type="text"
            id="dossier-review-notes"
            placeholder="Optional POPIA / qualification review note..."
            value="${esc(signal.review_notes || '')}"
          />
          <div class="btn-row">
            <button type="button" class="btn btn-primary btn-sm" id="dossier-save-review-btn">Save Review</button>
            <button type="button" class="btn btn-danger btn-sm" id="dossier-suppress-btn">Suppress / Do Not Contact</button>
          </div>
        </div>
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">Buying Intent Factors</div>
        ${renderFactorList(bd && bd.intent_factors)}
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">Commercial Fit / Lead Value Factors</div>
        ${renderFactorList(valueFactors)}
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">Evidence Confidence Factors</div>
        ${renderFactorList(bd && bd.confidence_factors)}
      </div>

      <div class="dossier-section">
        <div class="dossier-lbl">Captured Source Evidence (Rule/Query: ${esc(signal.matched_keyword)})</div>
        <div class="dossier-evidence">${esc(signal.content || '(No body text captured)')}</div>
        <div class="dossier-footer">
          <div class="action-group">
            ${signal.url ? `<a href="${esc(signal.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">Open Source ↗</a>` : ''}
            ${signal.url ? `<button type="button" class="btn btn-ghost btn-sm" id="dossier-copy-btn">Copy Source URL</button>` : ''}
          </div>
          <label class="chk-label">
            Workflow Status:
            <select id="dossier-status-select" class="select-sm">
              <option value="new"       ${signal.status === 'new'       ? 'selected' : ''}>New</option>
              <option value="contacted" ${signal.status === 'contacted' ? 'selected' : ''}>Contacted</option>
              <option value="ignored"   ${signal.status === 'ignored'   ? 'selected' : ''}>Ignored</option>
              <option value="won"       ${signal.status === 'won'       ? 'selected' : ''}>Won</option>
            </select>
          </label>
        </div>
      </div>
    `;

    backdropEl.hidden = false;
  }

  return { open, close };
}
