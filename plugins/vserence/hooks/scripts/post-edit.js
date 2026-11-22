#!/usr/bin/env node
'use strict';
// PostToolUse on edits: runs format and lint from .vserence/checks.json (quiet variants).
// Silent on success; on failure returns only the errors to Claude.
const L = require('./lib.js');

function editedFile(input) {
  const ti = input.tool_input || {};
  return ti.file_path || ti.notebook_path || ti.path || null;
}

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const file = editedFile(input);
  if (!file) return;
  const abs = L.path.isAbsolute(file) ? file : L.path.join(dir, file);
  if (!L.isInside(dir, abs) || !L.exists(abs)) return;
  const rel = L.relToProject(dir, abs);
  if (rel.startsWith('.vserence/') || rel.startsWith('.claude/')) return;
  if (L.isSecretPath(dir, abs)) return;
  const checks = L.loadChecks(dir);
  if (!checks) return;

  const problems = [];
  for (const name of ['format', 'lint']) {
    const raw = L.checkCommand(checks, name, true);
    if (!raw) continue;
    const cmd = L.fillCommand(raw, [rel]);
    if (!cmd) continue;
    const r = L.runCommand(cmd, dir, 110000);
    if (!r.ok) {
      problems.push(`${name} (${cmd}) ${r.timedOut ? 'превысил таймаут' : 'exit ' + r.status}:\n${L.tail(r.out, 1500)}`);
    }
  }
  if (problems.length === 0) return; // quiet output: nothing on success
  L.emit({
    decision: 'block',
    reason: `vserence post-edit: исправь найденное в ${rel}.\n` + problems.join('\n\n'),
  });
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence post-edit: ' + e.message + '\n');
}
process.exit(0);
