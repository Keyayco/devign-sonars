/**
 * frontend/api.js — SONARS API Client & SSE Manager
 * Pure ES module wrapping fetch + cookie-authenticated EventSource.
 */

const API = window.API_BASE || '/api';

let onUnauthorized = null;
let csrfToken      = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken && method !== 'GET' && method !== 'HEAD' ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && path !== '/auth/login' && typeof onUnauthorized === 'function') {
    csrfToken = null;
    onUnauthorized();
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function getSession() {
  const data = await request('/auth/session');
  csrfToken = data && data.csrfToken ? data.csrfToken : null;
  return data;
}

export async function login(accessKey) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ accessKey }),
  });
  csrfToken = data && data.csrfToken ? data.csrfToken : null;
  return data;
}

export async function logout() {
  try {
    return await request('/auth/logout', { method: 'POST' });
  } finally {
    csrfToken = null;
  }
}

export function getStatus() {
  return request('/status');
}

export function getLogs() {
  return request('/logs');
}

export function startWorker() {
  return request('/start', { method: 'POST' });
}

export function stopWorker() {
  return request('/stop', { method: 'POST' });
}

export function getConfig() {
  return request('/config');
}

export function saveConfig(payload) {
  return request('/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getSignals(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '' && v !== 'all') qs.set(k, String(v));
  });
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request('/signals' + suffix);
}

export function getSignalById(id) {
  return request(`/signals/${id}`);
}

export function updateSignalStatus(id, status) {
  return request(`/signals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function updateSignalReview(id, payload) {
  return request(`/signals/${id}/review`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getDiscoverySources() {
  return request('/discovery/sources');
}

export function getDiscoveryRuns(limit = 20) {
  return request(`/discovery/runs?limit=${encodeURIComponent(limit)}`);
}

export function runCipcSearch(payload) {
  return request('/discovery/cipc/search', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runOsmDiscovery(payload) {
  return request('/discovery/osm/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function purgeExpiredRecords() {
  return request('/discovery/retention/purge', {
    method: 'POST',
  });
}

export function openStream(handlers = {}) {
  const es = new EventSource(API + '/stream', { withCredentials: true });
  es.onopen = () => handlers.onOpen?.();
  es.onerror = () => handlers.onError?.();
  es.addEventListener('log', e => {
    try { handlers.onLog?.(JSON.parse(e.data).line); } catch {}
  });
  es.addEventListener('lead', e => {
    try { handlers.onLead?.(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('stats', e => {
    try { handlers.onStats?.(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('status', e => {
    try { handlers.onStatus?.(JSON.parse(e.data).running); } catch {}
  });
  return es;
}
