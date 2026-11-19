'use strict';

/**
 * lib/discovery-runner.js — Bridge between Express and worker/discover.py
 * ────────────────────────────────────────────────────────────────────────
 * Executes controlled on-demand Python discovery adapters (CIPC & OSM) via
 * stdin/stdout JSON, inheriting server env vars safely and redacting secrets.
 */

const { spawn } = require('child_process');
const path      = require('path');
const security  = require('./security');

const ROOT_DIR        = path.join(__dirname, '..');
const DISCOVER_SCRIPT = path.join(ROOT_DIR, 'worker', 'discover.py');
const DEFAULT_TIMEOUT = 35_000;

function runDiscoveryCommand(payload, { timeoutMs = DEFAULT_TIMEOUT, envOverrides = {} } = {}) {
  const pythonBin = process.env.SONARS_PYTHON || 'python3';

  return new Promise((resolve) => {
    const child = spawn(pythonBin, ['-u', DISCOVER_SCRIPT], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        ok: false,
        status_code: 504,
        error: 'Discovery runner timed out',
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status_code: 500,
        error: security.redactSecrets(`Failed to launch discovery worker: ${err.message}`),
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          ok: false,
          status_code: 502,
          error: security.redactSecrets(stderr.trim() || `Discovery worker exited (${code}) without output`),
        });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.error) {
          parsed.error = security.redactSecrets(parsed.error);
        }
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          status_code: 502,
          error: security.redactSecrets(`Malformed discovery output: ${trimmed.slice(0, 180)}`),
        });
      }
    });

    child.stdin.write(JSON.stringify(payload || {}));
    child.stdin.end();
  });
}

module.exports = {
  runDiscoveryCommand,
};
