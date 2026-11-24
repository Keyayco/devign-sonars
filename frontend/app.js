/**
 * frontend/app.js — SONARS Operations Console Entrypoint (ES Module)
 */

import * as api from './api.js';
import { createSignalsView } from './components/signals-view.js';
import { createDossierModal } from './components/dossier-modal.js';
import { createDiscoveryView } from './components/discovery-view.js';
import { createConfigView } from './components/config-view.js';

const $ = id => document.getElementById(id);
const setText = (id, val) => {
  const el = $(id);
  if (el) el.textContent = String(val);
};

let stream        = null;
let pollTimer     = null;
let isRunning     = false;
let authRequired  = false;
const allLogLines = [];

const LOG_LEVELS = ['FEED', 'MATCH', 'TELEGRAM', 'ERROR', 'WARN', 'SYSTEM', 'DB', 'DEDUP', 'SCORE', 'STDERR'];

function showToast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Source URL copied'))
      .catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Source URL copied');
  } catch {
    showToast('Copy not permitted');
  }
  document.body.removeChild(ta);
}

// ── Components ────────────────────────────────────────────────────────────────
const signalsView = createSignalsView($('signals-root'), {
  onInspect(id) {
    const sig = signalsView.findById(id);
    if (sig) dossierModal.open(sig);
  },
  async onStatusChange(id, status) {
    try {
      await api.updateSignalStatus(id, status);
      signalsView.updateLocalStatus(id, status);
      showToast(`Signal marked ${status}`);
    } catch (err) {
      showToast(err.message || 'Status update failed');
      await loadSignals();
    }
  },
  onQueryChange: () => loadSignals(),
  onCopyUrl: copyText,
});

const dossierModal = createDossierModal($('dossier-backdrop'), {
  async onStatusChange(id, status) {
    try {
      await api.updateSignalStatus(id, status);
      signalsView.updateLocalStatus(id, status);
      showToast(`Signal marked ${status}`);
    } catch (err) {
      showToast(err.message || 'Status update failed');
    }
  },
  async onReviewChange(id, payload) {
    try {
      const res = await api.updateSignalReview(id, payload);
      if (res.signal) {
        signalsView.replaceSignal(res.signal);
        showToast(res.signal.suppressed ? 'Entity suppressed (Do Not Contact)' : `Review saved: ${res.signal.review_status}`);
        await Promise.all([loadDiscoveryData(), loadStatus()]);
        return res.signal;
      }
      return null;
    } catch (err) {
      showToast(err.message || 'Review update failed');
      return null;
    }
  },
  onCopyUrl: copyText,
});

const discoveryView = createDiscoveryView($('discovery-root'), {
  async onCipcSearch(params) {
    const res = await api.runCipcSearch(params);
    discoveryView.setBatchResult({
      signals: res.signals && res.signals.length ? res.signals : (res.all_found || []),
      attribution: res.attribution,
    });
    showToast(`CIPC: ${res.found || 0} found, ${res.inserted || 0} added`);
    await Promise.all([loadDiscoveryData(), loadSignals(), loadStatus()]);
  },
  async onOsmRun(params) {
    const res = await api.runOsmDiscovery(params);
    discoveryView.setBatchResult({
      signals: res.signals && res.signals.length ? res.signals : (res.all_found || []),
      attribution: res.attribution,
    });
    showToast(`OpenStreetMap: ${res.found || 0} found, ${res.inserted || 0} added`);
    await Promise.all([loadDiscoveryData(), loadSignals(), loadStatus()]);
  },
  async onInspectSignal(id) {
    let sig = signalsView.findById(id) || discoveryView.findEntityById(id);
    if (!sig) {
      try {
        const res = await api.getSignalById(id);
        sig = res.signal || res.lead;
      } catch {}
    }
    if (sig) dossierModal.open(sig);
  },
  async onPurgeExpired() {
    try {
      const res = await api.purgeExpiredRecords();
      showToast(`Purged ${res.deleted || 0} expired unapproved record(s)`);
      await Promise.all([loadDiscoveryData(), loadSignals(), loadStatus()]);
    } catch (err) {
      showToast(err.message || 'Retention purge failed');
    }
  },
  onRefreshSources: () => loadDiscoveryData(),
  onEntityFilterChange: () => loadDiscoveryEntities(),
});

const configView = createConfigView($('config-root'), {
  async onSave({ payload, error }) {
    if (error) {
      showToast(error);
      return;
    }
    try {
      const res = await api.saveConfig(payload);
      if (res.config) configView.setConfig(res.config);
      showToast('Configuration saved');
      await loadDiscoveryData();
    } catch (err) {
      showToast(err.message || 'Failed to save configuration');
      throw err;
    }
  },
});

// ── Worker Status & KPIs ──────────────────────────────────────────────────────
function applyRunningState(running) {
  isRunning = !!running;
  const badge = $('status-badge');
  if (isRunning) {
    badge.classList.add('running');
    setText('status-text', 'Running');
    $('btn-start').disabled = true;
    $('btn-stop').disabled  = false;
  } else {
    badge.classList.remove('running');
    setText('status-text', 'Stopped');
    $('btn-start').disabled = false;
    $('btn-stop').disabled  = true;
  }
}

function applyStats(s) {
  if (!s) return;
  if (s.cycles != null)      setText('s-cycles', s.cycles);
  if (s.alerts_sent != null) setText('s-alerts', s.alerts_sent);
  if (s.dupes_skipped != null && s.dupes_skipped > 0) {
    setText('s-dupes', s.dupes_skipped);
  }
  if (s.last_scan_ms != null && s.last_scan_ms > 0) {
    setText('s-scan', (s.last_scan_ms / 1000).toFixed(1) + 's');
  }
}

function applyDbStats(db) {
  if (!db) return;
  const buyingCount = db.buying_intent_total != null ? db.buying_intent_total : db.total;
  const entityCount = db.entity_discovery_total != null ? db.entity_discovery_total : 0;
  if (buyingCount != null) {
    setText('s-total', buyingCount);
    setText('lead-count', buyingCount);
  }
  setText('s-entities', entityCount);
  setText('discovery-count', entityCount);
  if (db.high != null) setText('s-high', db.high);
  if (db.avg_score != null) setText('s-avg', db.avg_score || '—');
  if (db.total_dupes != null) setText('s-dupes', db.total_dupes);
  if (db.newest_at) {
    setText('newest-signal-meta', `Latest record: ${db.newest_at}`);
  } else {
    setText('newest-signal-meta', 'No signals recorded');
  }
}

// ── Live Log Stream ───────────────────────────────────────────────────────────
function detectLogLevel(line) {
  for (const lvl of LOG_LEVELS) {
    if (line.includes(`[${lvl}]`)) return lvl;
  }
  return 'OTHER';
}

function renderLogs() {
  const box = $('log-box');
  const wanted = $('log-level-filter').value;
  const filtered = wanted === 'ALL'
    ? allLogLines
    : allLogLines.filter(l => detectLogLevel(l) === wanted);

  if (filtered.length === 0) {
    box.innerHTML = '<div class="log-placeholder">No log entries matching filter.</div>';
    return;
  }

  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const line of filtered) {
    const lvl = detectLogLevel(line);
    const div = document.createElement('div');
    div.className = 'log-line' + (lvl !== 'OTHER' ? ` ll-${lvl}` : '');
    div.textContent = line;
    frag.appendChild(div);
  }
  box.appendChild(frag);
  if ($('auto-scroll').checked) {
    box.scrollTop = box.scrollHeight;
  }
}

function appendLog(line) {
  if (!line) return;
  allLogLines.push(String(line));
  if (allLogLines.length > 600) allLogLines.shift();

  const wanted = $('log-level-filter').value;
  const lvl = detectLogLevel(String(line));
  if (wanted !== 'ALL' && lvl !== wanted) return;

  const box = $('log-box');
  const placeholder = box.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = 'log-line' + (lvl !== 'OTHER' ? ` ll-${lvl}` : '');
  div.textContent = String(line);
  box.appendChild(div);

  while (box.children.length > 600) {
    box.removeChild(box.firstChild);
  }
  if ($('auto-scroll').checked) {
    box.scrollTop = box.scrollHeight;
  }
}

// ── Data Loading & SSE ────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await api.getStatus();
    applyRunningState(d.running);
    applyStats(d.stats);
    applyDbStats(d.db);
  } catch {}
}

async function loadSignals() {
  try {
    const params = signalsView.getQueryParams();
    const d = await api.getSignals(params);
    const list = d.signals || d.leads || [];
    signalsView.setPage({
      signals: list,
      total: d.total != null ? d.total : list.length,
      limit: d.limit || params.limit,
      offset: d.offset != null ? d.offset : params.offset,
    });
  } catch {}
}

async function loadDiscoveryEntities() {
  try {
    const params = discoveryView.getEntityQueryParams();
    const res = await api.getSignals({
      record_kind: 'entity_discovery',
      source: params.source,
      limit: 25,
      offset: 0,
      sort: 'created_at',
    });
    discoveryView.setPersistedEntities({
      entities: res.signals || [],
      total: res.total != null ? res.total : 0,
    });
  } catch {}
}

async function loadDiscoveryData() {
  try {
    const [srcRes, runsRes] = await Promise.all([
      api.getDiscoverySources().catch(() => null),
      api.getDiscoveryRuns(20).catch(() => null),
      loadDiscoveryEntities(),
    ]);
    if (srcRes && srcRes.sources) discoveryView.setSources(srcRes.sources);
    if (runsRes && Array.isArray(runsRes.runs)) discoveryView.setRuns(runsRes.runs);
  } catch {}
}

async function loadInitialConsoleData() {
  if (stream) stream.close();
  stream = api.openStream({
    onOpen() {
      $('sse-dot').classList.add('live');
      setText('sse-lbl', 'Live');
    },
    onError() {
      $('sse-dot').classList.remove('live');
      setText('sse-lbl', 'Reconnecting');
    },
    onLog: appendLog,
    onLead(sig) {
      if (signalsView.prependSignal(sig)) {
        loadStatus();
      }
    },
    onStats: applyStats,
    onStatus: applyRunningState,
  });

  const [logsRes, cfgRes] = await Promise.all([
    api.getLogs().catch(() => null),
    api.getConfig().catch(() => null),
    loadSignals(),
    loadStatus(),
    loadDiscoveryData(),
  ]);

  if (logsRes && Array.isArray(logsRes.lines)) {
    allLogLines.length = 0;
    logsRes.lines.forEach(l => allLogLines.push(String(l)));
    renderLogs();
  }
  if (cfgRes) configView.setConfig(cfgRes);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadStatus, 15_000);
}

// ── Auth Gate & Shell Lifecycle ───────────────────────────────────────────────
function showAuthGate(misconfigured = false) {
  if (stream) { stream.close(); stream = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  $('console-shell').hidden = true;
  $('hdr-controls').hidden  = true;
  $('auth-gate').hidden     = false;

  const errEl  = $('auth-error');
  const submit = $('auth-submit');
  if (misconfigured) {
    errEl.textContent = 'Server security misconfiguration: SONARS_ACCESS_KEY must be configured in production.';
    errEl.hidden = false;
    submit.disabled = true;
  } else {
    errEl.hidden = true;
    submit.disabled = false;
  }
}

async function showConsole() {
  $('auth-gate').hidden     = true;
  $('console-shell').hidden = false;
  $('hdr-controls').hidden  = false;
  $('btn-logout').hidden    = !authRequired;
  await loadInitialConsoleData();
}

api.setUnauthorizedHandler(() => {
  if (authRequired) showAuthGate(false);
});

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const key = $('auth-key-input').value.trim();
  const errEl = $('auth-error');
  errEl.hidden = true;
  try {
    await api.login(key);
    $('auth-key-input').value = '';
    await showConsole();
  } catch (err) {
    errEl.textContent = err.message || 'Authentication failed';
    errEl.hidden = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  showAuthGate(false);
});

// ── Controls & Tabs ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  });
});

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    const res = await api.startWorker();
    if (!res.ok) {
      showToast(res.msg || 'Unable to start worker');
      $('btn-start').disabled = false;
    } else {
      showToast('Worker starting');
      setTimeout(loadStatus, 1200);
    }
  } catch (err) {
    showToast(err.message || 'Start request failed');
    $('btn-start').disabled = false;
  }
});

$('btn-stop').addEventListener('click', async () => {
  $('btn-stop').disabled = true;
  try {
    await api.stopWorker();
    showToast('Stop signal sent');
  } catch (err) {
    showToast(err.message || 'Stop request failed');
    $('btn-stop').disabled = false;
  }
});

$('btn-refresh').addEventListener('click', async () => {
  await Promise.all([loadStatus(), loadSignals(), loadDiscoveryData()]);
  showToast('Data refreshed');
});

$('log-level-filter').addEventListener('change', renderLogs);
$('btn-clear-logs').addEventListener('click', () => {
  allLogLines.length = 0;
  renderLogs();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const sess = await api.getSession();
    authRequired = !!sess.authRequired;
    if (sess.misconfigured) {
      showAuthGate(true);
      return;
    }
    if (sess.authenticated) {
      await showConsole();
    } else {
      showAuthGate(false);
    }
  } catch {
    showAuthGate(false);
  }
}

bootstrap();
