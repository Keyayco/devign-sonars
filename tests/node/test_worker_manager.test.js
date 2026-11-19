'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { createWorkerManager } = require('../../lib/worker-manager');
const db                      = require('../../lib/db');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonars-wm-'));
  return {
    dir,
    dbPath:     path.join(dir, 'lead_monitor.db'),
    configPath: path.join(dir, 'monitor_config.json'),
    seedPath:   path.join(dir, '.worker_seed.json'),
    logDir:     path.join(dir, 'logs'),
  };
}

test('worker-manager: handles ENOENT startup failure cleanly without stale running status', async () => {
  const sb = makeSandbox();
  const wm = createWorkerManager();

  try {
    const started = wm.startWorker(
      { interval: 60, feeds: [], keywords: [] },
      {
        configPath: sb.configPath,
        seedPath:   sb.seedPath,
        dbPath:     sb.dbPath,
        logDir:     sb.logDir,
        pythonBin:  '/nonexistent-python-binary-for-sonars-test',
      },
    );
    assert.equal(started, true);

    for (let i = 0; i < 40 && wm.isRunning(); i++) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(wm.isRunning(), false);
    assert.equal(wm.getState(), 'stopped');
    assert.ok(wm.getLogs().some(l => l.includes('Worker process error')));
  } finally {
    await wm.stopWorkerAsync();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('worker-manager: handles unexpected crash, backoff restart state, and clean async stop', async () => {
  const sb = makeSandbox();
  const wm = createWorkerManager();
  const crashScript = path.join(sb.dir, 'crash_once.py');
  fs.writeFileSync(crashScript, 'import sys; print("{\"type\":\"log\",\"level\":\"INFO\",\"msg\":\"booted\"}", flush=True); sys.exit(1)\n');

  try {
    wm.startWorker(
      { interval: 60, feeds: [], keywords: [] },
      {
        configPath:         sb.configPath,
        seedPath:           sb.seedPath,
        dbPath:             sb.dbPath,
        logDir:             sb.logDir,
        workerPath:         crashScript,
        baseRestartDelayMs: 5000,
        maxRestartDelayMs:  10000,
      },
    );

    // Wait for child to crash and enter 'restarting' state
    for (let i = 0; i < 40 && wm.getState() !== 'restarting'; i++) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(wm.getState(), 'restarting');
    assert.equal(wm.isRunning(), true);

    // Stopping while in restart backoff timer cleanly transitions to 'stopped'
    await wm.stopWorkerAsync(2000);
    assert.equal(wm.getState(), 'stopped');
    assert.equal(wm.isRunning(), false);
  } finally {
    await wm.stopWorkerAsync();
    db.closeDb(sb.dbPath);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
