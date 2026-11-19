'use strict';

/**
 * scripts/validate-js.js — Individual Syntax Verification for All JS Files
 * ───────────────────────────────────────────────────────────────────────────
 * Walks the repository excluding dependencies and runtime/generated folders,
 * syntax-checking every .js / .mjs / .cjs file independently.
 *   • Files under frontend/ are checked as ES Modules (--input-type=module).
 *   • Backend, library, script, and test files are checked as CommonJS.
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'data',
  'logs',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);

function collectJsFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = collectJsFiles(ROOT);
if (files.length === 0) {
  console.error('No JavaScript files found to validate.');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const isFrontendEsm = rel.startsWith('frontend/') || rel.endsWith('.mjs');

  const res = isFrontendEsm
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: fs.readFileSync(file),
        encoding: 'utf8',
      })
    : spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
      });

  if (res.status !== 0) {
    failures += 1;
    console.error(`[FAIL] ${rel}`);
    if (res.stderr) console.error(res.stderr.trim());
  }
}

if (failures > 0) {
  console.error(`JavaScript validation failed: ${failures}/${files.length} file(s) had syntax errors.`);
  process.exit(1);
}

console.log(`Validated ${files.length} JavaScript file(s) individually.`);
