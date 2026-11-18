/**
 * frontend/components/signals-view.js — SONARS Signals Table & Filtering View
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
  if (sig.created_utc) {
    mins = Math.floor((Date.now() / 1000 - sig.created_utc) / 60);
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

export function createSignalsView(rootEl, { onInspect, onStatusChange, onCopyUrl, onFilterChange }) {
  const state = {
    signals:     [],
    q:           '',
    intent:      'all',
    status:      'all',
    opportunity: 'all',
    sort:        'created_at',
  };

  rootEl.innerHTML = `
    <div class="card-head">
      <span>Signal Feed</span>
      <span class="meta-text" id="signals-meta">0 signals</span>
    </div>
    <div class="signal-toolbar">
      <div class="toolbar-row">
        <input
          type="search"
          id="sig-search"
          class="search-input"
          placeholder="Search title, body, channel, or keyword..."
          aria-label="Search signals"
        />
        <div class="seg-group" role="group" aria-label="Intent filter">
          <button type="button" class="seg-btn active" data-intent="all">All</button>
          <button type="button" class="seg-btn" data-intent="high">High</button>
          <button type="button" class="seg-btn" data-intent="medium">Medium</button>
          <button type="button" class="seg-btn" data-intent="low">Low</button>
        </div>
      </div>
      <div class="toolbar-row">
        <div class="filter-controls">
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
            <option value="insufficient_evidence">Low Evidence</option>
            <option value="low_fit_noise">Noise</option>
          </select>
          <select id="sig-sort" class="select-sm" aria-label="Sort signals">
            <option value="created_at">Sort: Newest</option>
            <option value="score">Sort: Intent Score</option>
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
            <th>Opportunity</th>
            <th>Source</th>
            <th>Signal Title</th>
            <th>Keyword</th>
            <th>Age</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="signals-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody      = rootEl.querySelector('#signals-tbody');
  const metaEl     = rootEl.querySelector('#signals-meta');
  const searchEl   = rootEl.querySelector('#sig-search');
  const statusEl   = rootEl.querySelector('#sig-status-filter');
  const oppEl      = rootEl.querySelector('#sig-opp-filter');
  const sortEl     = rootEl.querySelector('#sig-sort');

  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    state.q = searchEl.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 150);
  });

  rootEl.querySelectorAll('[data-intent]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.intent = btn.dataset.intent;
      rootEl.querySelectorAll('[data-intent]').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      render();
    });
  });

  statusEl.addEventListener('change', () => {
    state.status = statusEl.value;
    render();
  });

  oppEl.addEventListener('change', () => {
    state.opportunity = oppEl.value;
    render();
  });

  sortEl.addEventListener('change', () => {
    state.sort = sortEl.value;
    render();
    onFilterChange?.({ sort: state.sort });
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

  function applyFiltersAndSort() {
    let list = [...state.signals];
    if (state.intent !== 'all') {
      list = list.filter(s => s.intent === state.intent);
    }
    if (state.status !== 'all') {
      list = list.filter(s => s.status === state.status);
    }
    if (state.opportunity !== 'all') {
      list = list.filter(s => (s.opportunity_type || 'unclassified') === state.opportunity);
    }
    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.content || '').toLowerCase().includes(q) ||
        (s.matched_keyword || '').toLowerCase().includes(q) ||
        (s.source_channel || s.subreddit || '').toLowerCase().includes(q) ||
        (s.entity_name || '').toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      const sa = getScores(a);
      const sb = getScores(b);
      switch (state.sort) {
        case 'score':      return sb.intentScore - sa.intentScore;
        case 'value':      return sb.fitScore - sa.fitScore;
        case 'confidence': return sb.confScore - sa.confScore;
        case 'composite':
          return (sb.intentScore + sb.fitScore + sb.confScore) - (sa.intentScore + sa.fitScore + sa.confScore);
        default:
          return (b.created_utc || 0) - (a.created_utc || 0) || (b.id || 0) - (a.id || 0);
      }
    });

    return list;
  }

  function renderRow(s) {
    const { intentScore, fitScore, confScore } = getScores(s);
    const opp = s.opportunity_type || 'unclassified';
    const oppLabel = OPP_LABELS[opp] || opp;
    const srcType = s.source_type || 'reddit';
    const srcChan = s.source_channel || s.subreddit || '';

    return `
      <tr>
        <td>
          <div class="score-stack">
            <div class="score-row">
              <span class="score-lbl">INT</span>
              <div class="score-bar"><div class="score-fill ${esc(s.intent)}" style="width:${intentScore}%"></div></div>
              <span>${intentScore}</span>
            </div>
            <div class="score-row">
              <span class="score-lbl">VAL</span>
              <div class="score-bar"><div class="score-fill fit" style="width:${fitScore}%"></div></div>
              <span>${fitScore}</span>
            </div>
            <div class="score-row">
              <span class="score-lbl">CNF</span>
              <div class="score-bar"><div class="score-fill conf" style="width:${confScore}%"></div></div>
              <span>${confScore}</span>
            </div>
          </div>
        </td>
        <td><span class="opp-tag opp-${esc(opp)}">${esc(oppLabel)}</span></td>
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
        </td>
        <td><span class="kw-text">${esc(s.matched_keyword)}</span></td>
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
    const filtered = applyFiltersAndSort();
    metaEl.textContent = `${state.signals.length} total · ${filtered.length} shown`;

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No matching signals found.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(renderRow).join('');
  }

  return {
    setSignals(list) {
      state.signals = Array.isArray(list) ? list : [];
      render();
    },
    prependSignal(sig) {
      if (!sig || state.signals.some(s => s.id === sig.id)) return false;
      state.signals.unshift(sig);
      render();
      return true;
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
