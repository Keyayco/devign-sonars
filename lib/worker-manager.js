'use strict';

/**
 * lib/worker-manager.js — SONARS Python Worker Supervisor & SSE Broadcaster
 * ──────────────────────────────────────────────────────────────────────────
 * • Spawns python3 -u worker/worker.py (configurable for testing)
 * • Handles child-process 'error' events, startup failures, and unexpected exits
 * • Explicit lifecycle states ('stopped' | 'running' | 'restarting' | 'stopping')
 * • Auto-restarts on unexpected crash (5s -> 60s backoff; resets after 60s stability)
 * • Redacts secrets from all log streams before persistence or SSE broadcast
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

function createWorkerManager() {
  let proc                 = null;
  let state                = 'stopped'; // 'stopped' | 'running' | 'restarting' | 'stopping'
  let intentionallyStopped = false;
  let restartDelay         = 5_000;
  let restartTimer         = null;
  let stableTimer          = null;
  let killTimer            = null;
  let logFileStream        = null;
  let activeLogDir         = LOG_DIR;
  let activeLogFile        = LOG_FILE;
  const stopWaiters        = [];

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

  function ensureDirs(extraDirs = []) {
    for (const dir of [activeLogDir, DATA_DIR, ...extraDirs]) {
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  function openLogStream() {
    ensureDirs();
    if (logFileStream && !logFileStream.destroyed) return;
    logFileStream = fs.createWriteStream(activeLogFile, { flags: 'a' });
  }

  function closeLogStream() {
    if (logFileStream && !logFileStream.destroyed) {
      try { logFileStream.end(); } catch {}
      logFileStream = null;
    }
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

  function resolveStopWaiters() {
    while (stopWaiters.length > 0) {
      const fn = stopWaiters.shift();
      try { fn(); } catch {}
    }
  }

  function clearTimers() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (stableTimer)  { clearTimeout(stableTimer);  stableTimer  = null; }
    if (killTimer)    { clearTimeout(killTimer);    killTimer    = null; }
  }

  function isRunning() {
    return state === 'running' || state === 'restarting';
  }

  function addSSEClient(res) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseClients.add(res);

    res.write(`event: status\ndata: ${JSON.stringify({ running: isRunning(), state })}\n\n`);
    res.write(`event: stats\ndata: ${JSON.stringify({ ...stats })}\n\n`);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(ping); sseClients.delete(res); }
    }, 25_000);
    if (typeof ping.unref === 'function') ping.unref();

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
    if (state !== 'stopped') return false;

    const configFile = opts.configPath || CONFIG_PATH;
    const seedFile   = opts.seedPath   || SEED_PATH;
    const dbPath     = opts.dbPath;
    const pythonBin  = opts.pythonBin  || 'python3';
    const workerPath = opts.workerPath || WORKER_PATH;
    const baseDelay  = Number.isFinite(opts.baseRestartDelayMs) ? opts.baseRestartDelayMs : 5_000;
    const maxDelay   = Number.isFinite(opts.maxRestartDelayMs)  ? opts.maxRestartDelayMs  : 60_000;

    if (opts.logDir) {
      activeLogDir  = opts.logDir;
      activeLogFile = path.join(opts.logDir, 'monitor.log');
    }

    ensureDirs([path.dirname(path.resolve(configFile)), path.dirname(path.resolve(seedFile))]);
    clearTimers();

    intentionallyStopped = false;
    state                = 'running';
    restartDelay         = baseDelay;

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
    spawnWorker({ configFile, seedFile, dbPath, pythonBin, workerPath, baseDelay, maxDelay });
    return true;
  }

  function spawnWorker({ configFile, seedFile, dbPath, pythonBin, workerPath, baseDelay, maxDelay }) {
    const ts = new Date().toTimeString().slice(0, 8);
    writeLog(`[${ts}] [SYSTEM] Spawning SONARS worker (${seenCount(dbPath)} known IDs seeded)`);

    let child;
    try {
      child = spawn(pythonBin, ['-u', workerPath], {
        cwd:   ROOT_DIR,
        env:   {
          ...process.env,
          SONARS_CONFIG_FILE: configFile,
          SONARS_SEED_FILE:   seedFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      writeLog(`[${ts}] [ERROR] Worker spawn threw: ${err.message}`);
      state = 'stopped';
      proc  = null;
      broadcast('status', { running: false, state });
      resolveStopWaiters();
      return;
    }

    proc  = child;
    state = 'running';

    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { restartDelay = baseDelay; }, 60_000);
    if (typeof stableTimer.unref === 'function') stableTimer.unref();

    const stdoutRl = readline.createInterface({ input: child.stdout });
    const stderrRl = readline.createInterface({ input: child.stderr });
    stdoutRl.on('line', l => handleLine(l, dbPath));
    stderrRl.on('line', l =>
      writeLog(`[${new Date().toTimeString().slice(0, 8)}] [STDERR] ${l}`)
    );

    let finalized = false;
    function cleanupChildStreams() {
      try { stdoutRl.close(); } catch {}
      try { stderrRl.close(); } catch {}
    }

    function scheduleRestartOrStop(fatalStartup) {
      if (intentionallyStopped || fatalStartup) {
        state = 'stopped';
        closeLogStream();
        broadcast('status', { running: false, state });
        resolveStopWaiters();
        return;
      }

      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, maxDelay);
      state = 'restarting';
      writeLog(`[${new Date().toTimeString().slice(0, 8)}] [SYSTEM] Crash detected — restarting in ${delay / 1000}s…`);
      try { fs.writeFileSync(seedFile, JSON.stringify(db.getSeenIds(undefined, dbPath)), { mode: 0o600 }); } catch {}
      broadcast('status', { running: true, state });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!intentionallyStopped) {
          spawnWorker({ configFile, seedFile, dbPath, pythonBin, workerPath, baseDelay, maxDelay });
        } else {
          state = 'stopped';
          broadcast('status', { running: false, state });
          resolveStopWaiters();
        }
      }, delay);
      if (typeof restartTimer.unref === 'function') restartTimer.unref();
    }

    child.on('error', (err) => {
      if (finalized) return;
      finalized = true;
      clearTimers();
      cleanupChildStreams();
      if (proc === child) proc = null;

      const tsErr = new Date().toTimeString().slice(0, 8);
      writeLog(`[${tsErr}] [ERROR] Worker process error (${err.code || 'ERR'}): ${err.message}`);

      // ENOENT / EACCES startup errors cannot self-heal via quick restarts
      const fatalStartup = err.code === 'ENOENT' || err.code === 'EACCES';
      scheduleRestartOrStop(fatalStartup);
    });

    child.on('exit', (code, signal) => {
      if (finalized) return;
      finalized = true;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (killTimer)   { clearTimeout(killTimer);   killTimer   = null; }
      cleanupChildStreams();
      if (proc === child) proc = null;

      const ts2 = new Date().toTimeString().slice(0, 8);
      writeLog(`[${ts2}] [SYSTEM] Worker exited code=${code ?? '?'} signal=${signal ?? 'none'}`);
      scheduleRestartOrStop(false);
    });

    broadcast('status', { running: true, state });
  }

  function stopWorker() {
    intentionallyStopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (stableTimer)  { clearTimeout(stableTimer);  stableTimer  = null; }

    if (proc) {
      state = 'stopping';
      const target = proc;
      try { target.kill('SIGTERM'); } catch {}
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTimer = null;
        try { target && target.kill('SIGKILL'); } catch {}
      }, 5_000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    } else {
      state = 'stopped';
      closeLogStream();
      broadcast('status', { running: false, state });
      resolveStopWaiters();
    }
  }

  function stopWorkerAsync(timeoutMs = 6_000) {
    return new Promise(resolve => {
      if (state === 'stopped' && !proc) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      stopWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      stopWorker();
    });
  }

  return {
    startWorker,
    stopWorker,
    stopWorkerAsync,
    addSSEClient,
    handleLine,
    isRunning,
    getState: () => state,
    getStats: () => ({ ...stats }),
    getLogs:  () => [...logBuffer],
  };
}

const defaultManager = createWorkerManager();
defaultManager.createWorkerManager = createWorkerManager;

module.exports = defaultManager;
