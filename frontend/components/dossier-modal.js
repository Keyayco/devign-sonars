/**
 * frontend/components/dossier-modal.js — SONARS Signal Evidence Dossier Modal
 */

import { esc, getScores, OPP_LABELS } from './signals-view.js';

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

export function createDossierModal(backdropEl, { onStatusChange, onCopyUrl }) {
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
    }
  });

  bodyEl.addEventListener('click', e => {
    const copyBtn = e.target.closest('#dossier-copy-btn');
    if (copyBtn && currentSignal && currentSignal.url) {
      onCopyUrl?.(currentSignal.url);
    }
  });

  function open(signal) {
    if (!signal) return;
    currentSignal = signal;

    const { intentScore, fitScore, confScore } = getScores(signal);
    const opp      = signal.opportunity_type || 'unclassified';
    const oppLabel = OPP_LABELS[opp] || opp;
    const bd       = parseBreakdown(signal);
    const srcType  = (signal.source_type || 'reddit').toUpperCase();
    const srcChan  = signal.source_channel || signal.subreddit || '';
    const entity   = signal.entity_name ? ` · ${signal.entity_name}` : '';
    const valueFactors = (bd && (bd.value_factors || bd.fit_factors)) || [];

    kickerEl.textContent = `${srcType} · ${srcChan}${entity} · ${oppLabel}`;
    titleEl.textContent  = signal.title || 'Untitled Signal';

    bodyEl.innerHTML = `
      <div class="dossier-section">
        <div class="dossier-lbl">Qualification & Prospecting Recommendation</div>
        <div class="dossier-metrics">
          <div>Buying Intent: <strong>${intentScore}/100</strong> (${esc(signal.intent)})</div>
          <div>Lead Value: <strong>${fitScore}/100</strong></div>
          <div>Confidence: <strong>${confScore}/100</strong></div>
        </div>
        ${bd && bd.recommended_action
          ? `<div class="dossier-action"><strong>Recommended Action:</strong> ${esc(bd.recommended_action)}</div>`
          : ''}
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
        <div class="dossier-lbl">Captured Source Evidence (Keyword: ${esc(signal.matched_keyword)})</div>
        <div class="dossier-evidence">${esc(signal.content || '(No body text captured)')}</div>
        <div class="dossier-footer">
          <div class="action-group">
            ${signal.url ? `<a href="${esc(signal.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">Open Source ↗</a>` : ''}
            ${signal.url ? `<button type="button" class="btn btn-ghost btn-sm" id="dossier-copy-btn">Copy Source URL</button>` : ''}
          </div>
          <label class="chk-label">
            Status:
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
