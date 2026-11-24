/**
 * frontend/components/signals-view.js — SONARS Signals Table, Filtering & Pagination
 */

export const OPP_LABELS = {
  active_buying_intent:   'Active Intent',
  commercial_opportunity: 'Commercial Opp',
  digital_need:           'Digital Need',
  entity_exists:          'Entity Only',
  insufficient_evidence:  'Low Evidence',
  low_fit_noise:          'Noise',
  unclassified:           'Unclassified',
};

export const OBS_LABELS = {
  buying_intent_signal:      'Buying Intent',
  entity_discovered:         'Entity Discovered',
  entity_verified:           'Entity Verified',
  digital_presence_gap:      'Presence Gap',
  contact_information_found: 'Contact Info',
};

export const REVIEW_LABELS = {
  pending_review: 'Pending Review',
  approved:       'Approved',
  hold:           'On Hold',
  rejected:       'Rejected',
  suppressed:     'Suppressed (DNC)',
};

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getScores(sig) {
  const intentScore = sig.intent_score != null ? sig.intent_score : (sig.score || 0);
  const fitScore    = sig.fit_score    != null ? sig.fit_score    : (sig.lead_value != null ? sig.lead_value : 50);
  const confScore   = sig.confidence_score != null ? sig.confidence_score : 50;
  return { intentScore, fitScore, confScore };
}

function ageLabel(sig) {
  let mins;
  const ts = sig.collected_utc || sig.created_utc;
  if (ts) {
    mins = Math.floor((Date.now() / 1000 - ts) / 60);
  } else if (sig.created_at) {
    mins = Math.floor((Date.now() - new Date(sig.created_at + 'Z').getTime()) / 60000);
  } else {
    return '—';
  }
  if (mins < 0) mins = 0;
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function createSignalsView(rootEl, { onInspect, onStatusChange, onCopyUrl, onQueryChange }) {
  const state = {
    signals:          [],
    total:            0,
    limit:            25,
    offset:           0,
    q:                '',
    record_kind:      'buying_intent',
    intent:           'all',
    source:           'all',
    observation_type: 'all',
    review_status:    'all',
    status:           'all',
    opportunity:      'all',
    sort:             'created_at',
  };

  rootEl.innerHTML = `
    <div class="card-head">
      <span>Signal Feed</span>
      <span class="meta-text" id="signals-meta">0 signals</span>
    </div>
    <div class="signal-toolbar">
      <div class="toolbar-row">
        <div class="seg-group" role="group" aria-label="Classification filter">
          <button type="button" class="seg-btn active" data-kind="buying_intent">Buying Intent Signals</button>
          <button type="button" class="seg-btn" data-kind="entity_discovery">Entity Discovery</button>
          <button type="button" class="seg-btn" data-kind="all">All Records</button>
        </div>
        <div class="seg-group" role="group" aria-label="Intent filter">
          <button type="button" class="seg-btn active" data-intent="all">All</button>
          <button type="button" class="seg-btn" data-intent="high">High</button>
          <button type="button" class="seg-btn" data-intent="medium">Medium</button>
          <button type="button" class="seg-btn" data-intent="low">Low</button>
        </div>
      </div>
      <div class="toolbar-row">
        <input
          type="search"
          id="sig-search"
          class="search-input"
          placeholder="Search title, company, region, category, keyword..."
          aria-label="Search signals"
        />
        <div class="filter-controls">
          <select id="sig-source-filter" class="select-sm" aria-label="Filter by source">
            <option value="all">Source: All</option>
            <option value="reddit">Reddit</option>
            <option value="cipc">CIPC</option>
            <option value="osm">OpenStreetMap</option>
          </select>
          <select id="sig-obs-filter" class="select-sm" aria-label="Filter by observation type">
            <option value="all">Observation: All</option>
            <option value="buying_intent_signal">Buying Intent</option>
            <option value="entity_discovered">Entity Discovered</option>
            <option value="entity_verified">Entity Verified</option>
            <option value="digital_presence_gap">Presence Gap</option>
            <option value="contact_information_found">Contact Info</option>
          </select>
          <select id="sig-review-filter" class="select-sm" aria-label="Filter by POPIA review status">
            <option value="all">Review: All</option>
            <option value="pending_review">Pending Review</option>
            <option value="approved">Approved</option>
            <option value="hold">On Hold</option>
            <option value="rejected">Rejected</option>
            <option value="suppressed">Suppressed</option>
          </select>
          <select id="sig-status-filter" class="select-sm" aria-label="Filter by status">
            <option value="all">Status: All</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="ignored">Ignored</option>
            <option value="won">Won</option>
          </select>
          <select id="sig-opp-filter" class="select-sm" aria-label="Filter by opportunity type">
            <option value="all">Opportunity: All</option>
            <option value="active_buying_intent">Active Intent</option>
            <option value="commercial_opportunity">Commercial Opp</option>
            <option value="digital_need">Digital Need</option>
            <option value="entity_exists">Entity Only</option>
            <option value="insufficient_evidence">Low Evidence</option>
            <option value="low_fit_noise">Noise</option>
          </select>
          <select id="sig-sort" class="select-sm" aria-label="Sort signals">
            <option value="created_at">Sort: Newest</option>
            <option value="score">Sort: Intent Score</option>
            <option value="fit">Sort: Fit Score</option>
            <option value="value">Sort: Lead Value</option>
            <option value="confidence">Sort: Confidence</option>
            <option value="composite">Sort: Composite</option>
          </select>
        </div>
      </div>
    </div>
    <div class="tbl-wrap">
      <table class="signals-table">
        <thead>
          <tr>
            <th>Scores</th>
            <th>Observation &amp; Opp</th>
            <th>Source &amp; Provenance</th>
            <th>Signal / Entity</th>
            <th>Review (POPIA)</th>
            <th>Age</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="signals-tbody"></tbody>
      </table>
    </div>
    <div class="pagination-bar" id="signals-pagination">
      <button type="button" class="btn btn-ghost btn-sm" id="sig-prev-page" disabled>← Previous</button>
      <span class="meta-text" id="sig-page-info">Page 1 of 1</span>
      <button type="button" class="btn btn-ghost btn-sm" id="sig-next-page" disabled>Next →</button>
    </div>
  `;

  const tbody        = rootEl.querySelector('#signals-tbody');
  const metaEl       = rootEl.querySelector('#signals-meta');
  const searchEl     = rootEl.querySelector('#sig-search');
  const sourceEl     = rootEl.querySelector('#sig-source-filter');
  const obsEl        = rootEl.querySelector('#sig-obs-filter');
  const reviewEl     = rootEl.querySelector('#sig-review-filter');
  const statusEl     = rootEl.querySelector('#sig-status-filter');
  const oppEl        = rootEl.querySelector('#sig-opp-filter');
  const sortEl       = rootEl.querySelector('#sig-sort');
  const prevBtn      = rootEl.querySelector('#sig-prev-page');
  const nextBtn      = rootEl.querySelector('#sig-next-page');
  const pageInfoEl   = rootEl.querySelector('#sig-page-info');

  function setRecordKind(nextKind) {
    state.record_kind = nextKind || 'buying_intent';
    rootEl.querySelectorAll('[data-kind]').forEach(b =>
      b.classList.toggle('active', b.dataset.kind === state.record_kind)
    );
  }

  function currentQueryParams() {
    return {
      q:                state.q,
      record_kind:      state.record_kind,
      intent:           state.intent,
      source:           state.source,
      observation_type: state.observation_type,
      review_status:    state.review_status,
      status:           state.status,
      opportunity:      state.opportunity,
      sort:             state.sort,
      limit:            state.limit,
      offset:           state.offset,
    };
  }

  function triggerQuery(resetOffset = true) {
    if (resetOffset) state.offset = 0;
    onQueryChange?.(currentQueryParams());
  }

  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    state.q = searchEl.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => triggerQuery(true), 220);
  });

  rootEl.querySelectorAll('[data-kind]').forEach(btn => {
    btn.addEventListener('click', () => {
      setRecordKind(btn.dataset.kind);
      triggerQuery(true);
    });
  });

  rootEl.querySelectorAll('[data-intent]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.intent = btn.dataset.intent;
      rootEl.querySelectorAll('[data-intent]').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      triggerQuery(true);
    });
  });

  sourceEl.addEventListener('change', () => {
    state.source = sourceEl.value;
    if ((state.source === 'cipc' || state.source === 'osm') && state.record_kind === 'buying_intent') {
      setRecordKind('entity_discovery');
    } else if (state.source === 'reddit' && state.record_kind === 'entity_discovery') {
      setRecordKind('buying_intent');
    }
    triggerQuery(true);
  });
  obsEl.addEventListener('change', () => {
    state.observation_type = obsEl.value;
    if (state.observation_type !== 'all') {
      setRecordKind(state.observation_type === 'buying_intent_signal' ? 'buying_intent' : 'entity_discovery');
    }
    triggerQuery(true);
  });
  reviewEl.addEventListener('change', () => { state.review_status = reviewEl.value; triggerQuery(true); });
  statusEl.addEventListener('change', () => { state.status = statusEl.value; triggerQuery(true); });
  oppEl.addEventListener('change', () => { state.opportunity = oppEl.value; triggerQuery(true); });
  sortEl.addEventListener('change', () => { state.sort = sortEl.value; triggerQuery(true); });

  prevBtn.addEventListener('click', () => {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    triggerQuery(false);
  });

  nextBtn.addEventListener('click', () => {
    if (state.offset + state.limit >= state.total) return;
    state.offset += state.limit;
    triggerQuery(false);
  });

  tbody.addEventListener('click', e => {
    const inspectBtn = e.target.closest('[data-action="inspect"]');
    if (inspectBtn) {
      const id = Number(inspectBtn.dataset.id);
      if (id) onInspect?.(id);
      return;
    }

    const copyBtn = e.target.closest('[data-action="copy"]');
    if (copyBtn) {
      const id = Number(copyBtn.dataset.id);
      const sig = state.signals.find(s => s.id === id);
      if (sig && sig.url) onCopyUrl?.(sig.url);
    }
  });

  tbody.addEventListener('change', e => {
    const sel = e.target.closest('[data-action="status"]');
    if (!sel) return;
    const id = Number(sel.dataset.id);
    const newStatus = sel.value;
    const sig = state.signals.find(s => s.id === id);
    if (sig) sig.status = newStatus;
    onStatusChange?.(id, newStatus);
  });

  function renderRow(s) {
    const { intentScore, fitScore, confScore } = getScores(s);
    const opp = s.opportunity_type || 'unclassified';
    const oppLabel = OPP_LABELS[opp] || opp;
    const obs = s.observation_type || 'buying_intent_signal';
    const obsLabel = OBS_LABELS[obs] || obs;
    const isDiscovery = s.record_kind === 'entity_discovery' || obs !== 'buying_intent_signal';
    const rev = s.suppressed ? 'suppressed' : (s.review_status || 'pending_review');
    const revLabel = REVIEW_LABELS[rev] || rev;
    const srcType = s.source_type || 'reddit';
    const srcChan = s.source_channel || s.subreddit || '';

    return `
      <tr class="${s.suppressed ? 'row-suppressed' : ''}">
        <td>
          <div class="score-stack">
            <div class="score-row" title="Buying Intent (0–100)">
              <span class="score-lbl">INT</span>
              <div class="score-bar"><div class="score-fill ${esc(s.intent)}" style="width:${intentScore}%"></div></div>
              <span>${intentScore}${isDiscovery ? '<span class="score-note">none</span>' : ''}</span>
            </div>
            <div class="score-row" title="${isDiscovery ? 'Directory / Presence Fit (not buying intent)' : 'Commercial Fit / Lead Value'}">
              <span class="score-lbl">FIT</span>
              <div class="score-bar"><div class="score-fill fit" style="width:${fitScore}%"></div></div>
              <span>${fitScore}</span>
            </div>
            <div class="score-row" title="Evidence Confidence (0–100)">
              <span class="score-lbl">CNF</span>
              <div class="score-bar"><div class="score-fill conf" style="width:${confScore}%"></div></div>
              <span>${confScore}</span>
            </div>
          </div>
        </td>
        <td>
          <div class="source-meta">
            <span class="obs-tag">${esc(obsLabel)}</span>
            <span class="opp-tag opp-${esc(opp)}">${esc(oppLabel)}</span>
            ${isDiscovery ? '<span class="disc-only-tag">Discovery · Not Intent</span>' : ''}
          </div>
        </td>
        <td>
          <div class="source-meta">
            <span class="source-type">${esc(srcType)}</span>
            <span class="source-chan">${esc(srcChan)}</span>
          </div>
        </td>
        <td>
          <button type="button" class="title-btn" data-action="inspect" data-id="${s.id}">
            ${esc(s.title)}
          </button>
          <div class="kw-text">${esc(s.matched_keyword)}${s.attribution ? ` · ${esc(s.attribution.slice(0, 42))}` : ''}</div>
        </td>
        <td>
          <span class="rev-badge rev-${esc(rev)}">${esc(revLabel)}</span>
        </td>
        <td><span class="age-text">${esc(ageLabel(s))}</span></td>
        <td>
          <select class="select-sm" data-action="status" data-id="${s.id}" aria-label="Lead status">
            <option value="new"       ${s.status === 'new'       ? 'selected' : ''}>New</option>
            <option value="contacted" ${s.status === 'contacted' ? 'selected' : ''}>Contacted</option>
            <option value="ignored"   ${s.status === 'ignored'   ? 'selected' : ''}>Ignored</option>
            <option value="won"       ${s.status === 'won'       ? 'selected' : ''}>Won</option>
          </select>
        </td>
        <td>
          <div class="action-group">
            <button type="button" class="act-btn" data-action="inspect" data-id="${s.id}">Inspect</button>
            <button type="button" class="act-btn" data-action="copy" data-id="${s.id}">Copy</button>
            ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="act-btn">Open ↗</a>` : ''}
          </div>
        </td>
      </tr>
    `;
  }

  function render() {
    const startIdx = state.total === 0 ? 0 : state.offset + 1;
    const endIdx   = state.offset + state.signals.length;
    metaEl.textContent = `${state.total} matching · showing ${startIdx}–${endIdx}`;

    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    const currentPage = Math.floor(state.offset / state.limit) + 1;
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
    prevBtn.disabled = state.offset <= 0;
    nextBtn.disabled = state.offset + state.limit >= state.total;

    if (state.signals.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No matching signals found.</td></tr>';
      return;
    }

    tbody.innerHTML = state.signals.map(renderRow).join('');
  }

  return {
    setPage({ signals, total, limit, offset }) {
      state.signals = Array.isArray(signals) ? signals : [];
      if (total != null) state.total = Number(total);
      if (limit != null) state.limit = Number(limit);
      if (offset != null) state.offset = Number(offset);
      render();
    },
    getQueryParams: currentQueryParams,
    prependSignal(sig) {
      if (!sig || state.offset > 0 || state.signals.some(s => s.id === sig.id)) return false;
      const sigKind = (sig.observation_type || 'buying_intent_signal') === 'buying_intent_signal'
        ? 'buying_intent'
        : 'entity_discovery';
      if (state.record_kind !== 'all' && sigKind !== state.record_kind) return false;
      state.signals.unshift(sig);
      if (state.signals.length > state.limit) state.signals.pop();
      state.total += 1;
      render();
      return true;
    },
    replaceSignal(updated) {
      if (!updated) return;
      const idx = state.signals.findIndex(s => s.id === updated.id);
      if (idx !== -1) {
        state.signals[idx] = updated;
        render();
      }
    },
    getSignals() {
      return state.signals;
    },
    findById(id) {
      return state.signals.find(s => s.id === id) || null;
    },
    updateLocalStatus(id, status) {
      const sig = state.signals.find(s => s.id === id);
      if (sig) {
        sig.status = status;
        render();
      }
    },
  };
}
