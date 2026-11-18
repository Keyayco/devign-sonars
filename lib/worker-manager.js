'use strict';

/**
 * lib/worker-manager.js — SONARS Python Worker Supervisor & SSE Broadcaster
 * ──────────────────────────────────────────────────────────────────────────
 * • Spawns python3 -u worker/worker.py
 * • Passes pure config via SONARS_CONFIG_FILE and known IDs via SONARS_SEED_FILE
 * • Redacts secrets from all log streams before persistence or SSE broadcast
 * • Auto-restarts on unexpected crash (5s -> 60s backoff; resets after 60s stability)
 */

const { spawn }        = require('child_process');
const readline         = require('readline');
const path             = require('path');
const fs               = require('fs');
const db               = require('./db');
const { redactSecrets } = require('./security');

const ROOT_DIR    = path.join(__dirname, '..');
const WORKER_PATH = path.join(ROOT_DIR, 'worker', 'worker.py');
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'monitor_config.json');
const SEED_PATH   = path.join(DATA_DIR, '.worker_seed.json');
const LOG_DIR     = path.join(ROOT_DIR, 'logs');
const LOG_FILE    = path.join(LOG_DIR, 'monitor.log');

let proc                 = null;
let _isRunning           = false;
let intentionallyStopped = false;
let restartDelay         = 5_000;
let restartTimer         = null;
let stableTimer          = null;
let logFileStream        = null;

const MAX_LOGS   = 600;
const logBuffer  = [];
const sseClients = new Set();

const stats = {
  cycles: 0,
  matches: 0,
  alerts_sent: 0,
  dupes_skipped: 0,
  last_scan_ms: 0,
};

function ensureDirs() {
  if (!fs.existsSync(LOG_DIR))  fs.mkdirSync(LOG_DIR,  { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function openLogStream() {
  ensureDirs();
  if (logFileStream && !logFileStream.destroyed) return;
  logFileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function writeLog(rawLine) {
  const safeLine = redactSecrets(rawLine);
  logBuffer.push(safeLine);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  openLogStream();
  try { logFileStream.write(safeLine + '\n'); } catch {}
  broadcast('log', { line: safeLine });
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); }
    catch { sseClients.delete(res); }
  }
}

function addSSEClient(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);

  res.write(`event: status\ndata: ${JSON.stringify({ running: _isRunning })}\n\n`);
  res.write(`event: stats\ndata: ${JSON.stringify({ ...stats })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch { clearInterval(ping); sseClients.delete(res); }
  }, 25_000);

  res.on('close', () => {
    sseClients.delete(res);
    clearInterval(ping);
  });
}

function handleLine(raw, dbPath) {
  const line = String(raw || '').trim();
  if (!line) return;

  let parsed = null;
  if (line.startsWith('{')) {
    try { parsed = JSON.parse(line); } catch {}
  }

  if (!parsed) {
    writeLog(line);
    return;
  }

  const ts = () => new Date().toTimeString().slice(0, 8);

  switch (parsed.type) {
    case 'log':
      writeLog(`[${ts()}] [${parsed.level || 'INFO'}] ${parsed.msg || ''}`);
      break;

    case 'lead': {
      const lead = db.insertLead(parsed, dbPath);
      if (lead) {
        stats.matches++;
        broadcast('lead', lead);
        writeLog(
          `[${ts()}] [DB] Saved ${lead.source_type.toUpperCase()} ` +
          `score=${lead.intent_score} val=${lead.lead_value} (${lead.intent}) — ${lead.title.slice(0, 50)}`
        );
      }
      break;
    }

    case 'stat':
      if (parsed.cycles      != null) stats.cycles        = parsed.cycles;
      if (parsed.alerts_sent != null) stats.alerts_sent   = parsed.alerts_sent;
      if (parsed.dupes       != null) stats.dupes_skipped = parsed.dupes;
      if (parsed.scan_ms     != null) stats.last_scan_ms  = parsed.scan_ms;
      broadcast('stats', { ...stats });
      if (parsed.cycle_detail) {
        try { db.recordScanStat(parsed.cycle_detail, dbPath); } catch {}
      }
      break;

    default:
      writeLog(`[${ts()}] [?] ${line}`);
  }
}

function seenCount(dbPath) {
  try { return db.getSeenIds(undefined, dbPath).length; } catch { return 0; }
}

function startWorker(config, opts = {}) {
  if (_isRunning) return;

  const configFile = opts.configPath || CONFIG_PATH;
  const seedFile   = opts.seedPath   || SEED_PATH;
  const dbPath     = opts.dbPath;

  ensureDirs();
  intentionallyStopped = false;
  _isRunning           = true;
  restartDelay         = 5_000;

  Object.assign(stats, {
    cycles: 0,
    matches: 0,
    alerts_sent: 0,
    dupes_skipped: 0,
    last_scan_ms: 0,
  });

  const cleanConfig = { ...config };
  delete cleanConfig.seen_post_ids;
  fs.writeFileSync(configFile, JSON.stringify(cleanConfig, null, 2), { mode: 0o600 });

  const seenIds = db.getSeenIds(undefined, dbPath);
  fs.writeFileSync(seedFile, JSON.stringify(seenIds), { mode: 0o600 });

  openLogStream();
  spawnWorker({ configFile, seedFile, dbPath });
}

function spawnWorker({ configFile, seedFile, dbPath }) {
  const ts = new Date().toTimeString().slice(0, 8);
  writeLog(`[${ts}] [SYSTEM] Spawning SONARS worker (${seenCount(dbPath)} known IDs seeded)`);

  proc = spawn('python3', ['-u', WORKER_PATH], {
    cwd:   ROOT_DIR,
    env:   {
      ...process.env,
      SONARS_CONFIG_FILE: configFile,
      SONARS_SEED_FILE:   seedFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => { restartDelay = 5_000; }, 60_000);

  readline.createInterface({ input: proc.stdout }).on('line', l => handleLine(l, dbPath));
  readline.createInterface({ input: proc.stderr }).on('line', l =>
    writeLog(`[${new Date().toTimeString().slice(0, 8)}] [STDERR] ${l}`)
  );

  proc.on('exit', (code, signal) => {
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    const ts2 = new Date().toTimeString().slice(0, 8);
    writeLog(`[${ts2}] [SYSTEM] Worker exited code=${code ?? '?'} signal=${signal ?? 'none'}`);
    proc = null;

    if (!intentionallyStopped) {
      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, 60_000);
      writeLog(`[${ts2}] [SYSTEM] Crash detected — restarting in ${delay / 1000}s…`);
      try { fs.writeFileSync(seedFile, JSON.stringify(db.getSeenIds(undefined, dbPath))); } catch {}
      restartTimer = setTimeout(() => {
        if (!intentionallyStopped) spawnWorker({ configFile, seedFile, dbPath });
      }, delay);
    } else {
      _isRunning = false;
      broadcast('status', { running: false });
    }
  });

  broadcast('status', { running: true });
}

function stopWorker() {
  intentionallyStopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (stableTimer)  { clearTimeout(stableTimer);  stableTimer  = null; }

  if (proc) {
    proc.kill('SIGTERM');
    const target = proc;
    setTimeout(() => { try { target && target.kill('SIGKILL'); } catch {} }, 5_000);
  } else {
    _isRunning = false;
    broadcast('status', { running: false });
  }

  if (logFileStream && !logFileStream.destroyed) {
    logFileStream.end();
    logFileStream = null;
  }
}

module.exports = {
  startWorker,
  stopWorker,
  addSSEClient,
  handleLine,
  isRunning: () => _isRunning,
  getStats:  () => ({ ...stats }),
  getLogs:   () => [...logBuffer],
};
