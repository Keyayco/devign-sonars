/**
 * frontend/api.js — SONARS API Client & SSE Manager
 * Pure ES module wrapping fetch + cookie-authenticated EventSource.
 */

const API = window.API_BASE || '/api';

let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && path !== '/auth/login' && typeof onUnauthorized === 'function') {
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

export function getSession() {
  return request('/auth/session');
}

export function login(accessKey) {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ accessKey }),
  });
}

export function logout() {
  return request('/auth/logout', { method: 'POST' });
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
