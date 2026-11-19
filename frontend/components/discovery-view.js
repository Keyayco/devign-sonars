/**
 * frontend/components/discovery-view.js — SONARS Multi-Source Discovery Console
 * Provides source readiness status (Reddit, CIPC APIVerse, OpenStreetMap Overpass),
 * controlled on-demand CIPC company verification search, OpenStreetMap area/category
 * business discovery with ODbL attribution, and recent discovery run tracking.
 */

import { esc } from './signals-view.js';

export function createDiscoveryView(
  rootEl,
  { onCipcSearch, onOsmRun, onInspectSignal, onPurgeExpired, onRefreshSources }
) {
  const state = {
    sources: null,
    runs: [],
    lastResults: [],
    lastAttribution: '',
    lastError: '',
    busyCipc: false,
    busyOsm: false,
  };

  rootEl.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span>Intelligence Source Readiness</span>
        <button type="button" class="btn btn-ghost btn-sm" id="disc-refresh-btn">Refresh Status</button>
      </div>
      <div class="source-cards" id="disc-sources-grid">
        <div class="meta-text">Loading source status...</div>
      </div>
    </div>

    <div class="discovery-forms">
      <div class="card">
        <div class="card-head">
          <span>CIPC Company Verification Search</span>
          <span class="meta-text" id="cipc-head-badge">Checking config...</span>
        </div>
        <div id="cipc-config-banner" class="notice-banner" hidden></div>
        <form id="cipc-search-form" class="disc-form">
          <div class="field">
            <label class="field-label" for="cipc-query">Company / Enterprise Name</label>
            <input type="text" id="cipc-query" placeholder="e.g. Acme Holdings" maxlength="120" />
          </div>
          <div class="field">
            <label class="field-label" for="cipc-reg">Registration Number (Optional)</label>
            <input type="text" id="cipc-reg" placeholder="e.g. 2021/123456/07" maxlength="60" />
          </div>
          <div class="field">
            <label class="field-label" for="cipc-limit">Max Results</label>
            <input type="number" id="cipc-limit" value="15" min="1" max="50" />
          </div>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" id="btn-cipc-search">Search CIPC Registry</button>
          </div>
          <span class="field-hint">
            Official CIPC verification confirms entity existence only; it does not assign buying intent.
          </span>
        </form>
      </div>

      <div class="card">
        <div class="card-head">
          <span>OpenStreetMap Business Discovery</span>
          <span class="meta-text">Overpass API · ODbL</span>
        </div>
        <form id="osm-run-form" class="disc-form">
          <div class="field">
            <label class="field-label" for="osm-area">Geographic Area (South Africa)</label>
            <select id="osm-area"></select>
          </div>
          <div class="field">
            <label class="field-label" for="osm-category">Business Category</label>
            <select id="osm-category"></select>
          </div>
          <div class="field">
            <label class="field-label" for="osm-limit">Max Businesses</label>
            <input type="number" id="osm-limit" value="25" min="1" max="100" />
          </div>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" id="btn-osm-run">Run Maps Discovery</button>
          </div>
          <div class="osm-attribution" id="osm-attribution-note">
            Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>,
            licensed under <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener noreferrer">ODbL</a>.
            Missing website tags represent possible digital-presence gaps only, not confirmed buying demand.
          </div>
        </form>
      </div>
    </div>

    <div id="disc-error-banner" class="auth-error" role="alert" hidden></div>

    <div class="card" id="disc-results-card" hidden>
      <div class="card-head">
        <span>Latest Discovery Batch</span>
        <span class="meta-text" id="disc-results-meta">0 records</span>
      </div>
      <div class="tbl-wrap">
        <table class="signals-table">
          <thead>
            <tr>
              <th>Observation</th>
              <th>Entity / Title</th>
              <th>Region / Category</th>
              <th>Evidence Summary</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="disc-results-tbody"></tbody>
        </table>
      </div>
      <div class="field-hint disc-attr-line" id="disc-results-attr"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <span>Recent Discovery Runs &amp; POPIA Retention</span>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-purge-expired">Purge Expired Unapproved Records</button>
      </div>
      <div class="tbl-wrap">
        <table class="signals-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Source</th>
              <th>Parameters</th>
              <th>Status</th>
              <th>Found / Added</th>
            </tr>
          </thead>
          <tbody id="disc-runs-tbody">
            <tr><td colspan="5" class="empty-cell">No discovery runs recorded yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  const sourcesGrid    = rootEl.querySelector('#disc-sources-grid');
  const cipcBadge      = rootEl.querySelector('#cipc-head-badge');
  const cipcBanner     = rootEl.querySelector('#cipc-config-banner');
  const cipcForm       = rootEl.querySelector('#cipc-search-form');
  const cipcQueryEl    = rootEl.querySelector('#cipc-query');
  const cipcRegEl      = rootEl.querySelector('#cipc-reg');
  const cipcLimitEl    = rootEl.querySelector('#cipc-limit');
  const cipcBtn        = rootEl.querySelector('#btn-cipc-search');
  const osmForm        = rootEl.querySelector('#osm-run-form');
  const osmAreaEl      = rootEl.querySelector('#osm-area');
  const osmCatEl       = rootEl.querySelector('#osm-category');
  const osmLimitEl     = rootEl.querySelector('#osm-limit');
  const osmBtn         = rootEl.querySelector('#btn-osm-run');
  const errBanner      = rootEl.querySelector('#disc-error-banner');
  const resultsCard    = rootEl.querySelector('#disc-results-card');
  const resultsMeta    = rootEl.querySelector('#disc-results-meta');
  const resultsBody    = rootEl.querySelector('#disc-results-tbody');
  const resultsAttr    = rootEl.querySelector('#disc-results-attr');
  const runsBody       = rootEl.querySelector('#disc-runs-tbody');
  const refreshBtn     = rootEl.querySelector('#disc-refresh-btn');
  const purgeBtn       = rootEl.querySelector('#btn-purge-expired');

  function showError(msg) {
    state.lastError = msg || '';
    if (!msg) {
      errBanner.hidden = true;
      errBanner.textContent = '';
    } else {
      errBanner.textContent = msg;
      errBanner.hidden = false;
    }
  }

  function renderSources() {
    if (!state.sources) return;
    const { reddit, cipc, osm } = state.sources;

    const statusBadge = (ready, labelYes, labelNo) =>
      ready
        ? `<span class="src-status ready">${esc(labelYes)}</span>`
        : `<span class="src-status pending">${esc(labelNo)}</span>`;

    sourcesGrid.innerHTML = `
      <div class="source-card">
        <div class="source-card-top">
          <strong>${esc((reddit && reddit.name) || 'Reddit RSS')}</strong>
          ${statusBadge(reddit && reddit.ready, 'Active', 'No Feeds')}
        </div>
        <div class="meta-text">
          ${reddit ? `${reddit.feeds_count || 0} feed(s) · ${reddit.keywords_count || 0} keyword(s)` : 'Configured in Settings'}
        </div>
      </div>

      <div class="source-card">
        <div class="source-card-top">
          <strong>${esc((cipc && cipc.name) || 'CIPC APIVerse')}</strong>
          ${statusBadge(cipc && cipc.ready, 'Ready', cipc && cipc.enabled ? 'Missing Config' : 'Awaiting Credentials')}
        </div>
        <div class="meta-text">
          ${esc((cipc && cipc.reason) || 'Disabled until official CIPC APIVerse credentials are set.')}
        </div>
      </div>

      <div class="source-card">
        <div class="source-card-top">
          <strong>${esc((osm && osm.name) || 'OpenStreetMap')}</strong>
          ${statusBadge(osm && osm.ready, 'Ready (On-Demand)', 'Disabled')}
        </div>
        <div class="meta-text">
          ${esc((osm && osm.attribution) || '© OpenStreetMap contributors (ODbL)')}
        </div>
      </div>
    `;

    // CIPC readiness banner
    const cipcReady = Boolean(cipc && cipc.ready);
    cipcBadge.textContent = cipcReady ? 'Configured (OAuth 2.0)' : 'Not configured';
    cipcBtn.disabled = !cipcReady || state.busyCipc;
    if (!cipcReady) {
      const missing = (cipc && Array.isArray(cipc.missing) && cipc.missing.length)
        ? ` Missing env vars: ${cipc.missing.join(', ')}.`
        : '';
      cipcBanner.textContent = `${(cipc && cipc.reason) || 'CIPC credentials not configured.'}${missing}`;
      cipcBanner.hidden = false;
    } else {
      cipcBanner.hidden = true;
    }

    // Populate OSM dropdowns cleanly while preserving selection
    if (osm && Array.isArray(osm.areas)) {
      const prevArea = osmAreaEl.value;
      osmAreaEl.innerHTML = osm.areas
        .map(a => `<option value="${esc(a.key)}">${esc(a.label)}</option>`)
        .join('');
      if (prevArea && osm.areas.some(a => a.key === prevArea)) osmAreaEl.value = prevArea;
    }
    if (osm && Array.isArray(osm.categories)) {
      const prevCat = osmCatEl.value;
      osmCatEl.innerHTML = osm.categories
        .map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`)
        .join('');
      if (prevCat && osm.categories.some(c => c.key === prevCat)) osmCatEl.value = prevCat;
    }
  }

  function renderResults() {
    if (!state.lastResults || state.lastResults.length === 0) {
      resultsCard.hidden = true;
      return;
    }
    resultsCard.hidden = false;
    resultsMeta.textContent = `${state.lastResults.length} record(s) persisted`;
    resultsAttr.textContent = state.lastAttribution ? `Provenance & Attribution: ${state.lastAttribution}` : '';
    resultsBody.innerHTML = state.lastResults.map(sig => `
      <tr>
        <td><span class="obs-tag">${esc(sig.observation_type || 'entity_discovered')}</span></td>
        <td><strong>${esc(sig.title || sig.entity_name)}</strong></td>
        <td><span class="meta-text">${esc(sig.country_or_region || sig.source_channel || '')}<br/>${esc(sig.category || '')}</span></td>
        <td><span class="meta-text">${esc((sig.content || '').slice(0, 140))}…</span></td>
        <td>
          ${sig.id ? `<button type="button" class="act-btn" data-disc-inspect="${sig.id}">Inspect &amp; Review</button>` : ''}
        </td>
      </tr>
    `).join('');
  }

  function renderRuns() {
    if (!state.runs || state.runs.length === 0) {
      runsBody.innerHTML = '<tr><td colspan="5" class="empty-cell">No discovery runs recorded yet.</td></tr>';
      return;
    }
    runsBody.innerHTML = state.runs.map(r => {
      const paramsPreview = r.query_params_parsed
        ? Object.entries(r.query_params_parsed)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        : '—';
      const statusHtml = r.status === 'failed'
        ? `<span class="src-status pending" title="${esc(r.error_message || '')}">Failed</span>`
        : `<span class="src-status ready">${esc(r.status)}</span>`;
      return `
        <tr>
          <td><span class="age-text">${esc(r.created_at || '—')}</span></td>
          <td><span class="source-type">${esc(r.source_type)}</span></td>
          <td><span class="meta-text">${esc(paramsPreview)}${r.error_message ? ` — ${esc(r.error_message)}` : ''}</span></td>
          <td>${statusHtml}</td>
          <td><span class="age-text">${r.found_count || 0} found / ${r.inserted_count || 0} added</span></td>
        </tr>
      `;
    }).join('');
  }

  refreshBtn.addEventListener('click', () => onRefreshSources?.());

  purgeBtn.addEventListener('click', async () => {
    purgeBtn.disabled = true;
    try {
      await onPurgeExpired?.();
    } finally {
      purgeBtn.disabled = false;
    }
  });

  cipcForm.addEventListener('submit', async e => {
    e.preventDefault();
    showError('');
    const query = cipcQueryEl.value.trim();
    const registrationNumber = cipcRegEl.value.trim();
    const limit = parseInt(cipcLimitEl.value, 10) || 15;
    if (!query && !registrationNumber) {
      showError('Enter a company name or CIPC registration number.');
      return;
    }
    state.busyCipc = true;
    cipcBtn.disabled = true;
    try {
      await onCipcSearch?.({ query, registrationNumber, limit });
    } catch (err) {
      showError(err.message || 'CIPC search failed');
    } finally {
      state.busyCipc = false;
      renderSources();
    }
  });

  osmForm.addEventListener('submit', async e => {
    e.preventDefault();
    showError('');
    const area = osmAreaEl.value;
    const category = osmCatEl.value;
    const limit = parseInt(osmLimitEl.value, 10) || 25;
    state.busyOsm = true;
    osmBtn.disabled = true;
    osmBtn.textContent = 'Querying Overpass…';
    try {
      await onOsmRun?.({ area, category, limit });
    } catch (err) {
      showError(err.message || 'OpenStreetMap discovery failed');
    } finally {
      state.busyOsm = false;
      osmBtn.disabled = false;
      osmBtn.textContent = 'Run Maps Discovery';
    }
  });

  resultsBody.addEventListener('click', e => {
    const btn = e.target.closest('[data-disc-inspect]');
    if (!btn) return;
    const id = Number(btn.dataset.discInspect);
    if (id) onInspectSignal?.(id);
  });

  return {
    setSources(sources) {
      state.sources = sources;
      renderSources();
    },
    setRuns(runs) {
      state.runs = Array.isArray(runs) ? runs : [];
      renderRuns();
    },
    setBatchResult({ signals, attribution }) {
      state.lastResults = Array.isArray(signals) ? signals : [];
      state.lastAttribution = attribution || '';
      renderResults();
    },
    showError,
  };
}
