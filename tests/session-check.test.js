'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

function ctx(r) {
  return r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext : '';
}

test('session-check: no contract -> onboarding instruction', () => {
  const dir = h.makeProject({ contract: false });
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.strictEqual(r.status, 0);
  assert.match(ctx(r), /контракта \.vserence\/ нет/);
  assert.match(ctx(r), /vserence:onboarding/);
});

test('session-check: fresh contract after snapshot -> silent', () => {
  const dir = h.makeProject();
  assert.strictEqual(h.state(dir, 'snapshot').status, 0);
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.strictEqual(r.stdout, '');
});

test('session-check: changed manifest and new top-level folder -> sync instruction', () => {
  const dir = h.makeProject();
  h.state(dir, 'snapshot');
  h.write(dir, 'package.json', '{"name":"demo","version":"1.0.1","dependencies":{"x":"1"}}\n');
  h.write(dir, 'worker/index.js', '//\n');
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.match(ctx(r), /vserence:sync/);
  assert.match(ctx(r), /package\.json/);
  assert.match(ctx(r), /\+worker/);
});

test('session-check: contract version mismatch -> sync instruction', () => {
  const dir = h.makeProject();
  h.state(dir, 'snapshot');
  const p = h.path.join(dir, '.vserence', 'checks.json');
  const c = JSON.parse(h.fs.readFileSync(p, 'utf8'));
  c.contract_version = 0;
  h.fs.writeFileSync(p, JSON.stringify(c));
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.match(ctx(r), /версия контракта 0/);
});

test('session-check: permanent context over budget -> sync instruction', () => {
  const dir = h.makeProject();
  h.state(dir, 'snapshot');
  h.write(dir, 'AGENTS.md', 'word '.repeat(9000));
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.match(ctx(r), /постоянный контекст ≈\d+ токенов > 8000/);
});

test('session-check: after compaction re-injects the active task from files', () => {
  const dir = h.makeProject();
  h.state(dir, 'snapshot');
  h.startTask(dir, 'demo-task', 'feature');
  const r = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'compact', cwd: dir }, dir);
  assert.match(ctx(r), /задача «demo-task»/);
  assert.match(ctx(r), /spec\.md, plan\.md/);
});
