'use strict';
// Known failures of the original test suite are not "red"; new failures are; unknown output -> exit code.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

// test/test_changed print the content of .out and exit 1 when .out exists.
const OUT_STUB = `node -e "const f=require('fs');if(f.existsSync('.out')){process.stdout.write(f.readFileSync('.out','utf8'));process.exit(1)}"`;

function project({ baseline = true } = {}) {
  const dir = h.makeProject();
  h.write(dir, '.gitignore', '.fail-*\n.out\n');
  const p = h.path.join(dir, '.vserence', 'checks.json');
  const c = JSON.parse(h.fs.readFileSync(p, 'utf8'));
  c.commands.test = { run: OUT_STUB, quiet: OUT_STUB };
  c.commands.test_changed = { run: OUT_STUB, quiet: OUT_STUB };
  h.fs.writeFileSync(p, JSON.stringify(c, null, 2));
  h.git(dir, 'add', '-A');
  h.git(dir, 'commit', '-q', '-m', 'checks');
  if (baseline) {
    h.write(dir, '.out', 'FAIL tests/old-broken.test.js\nTests: 1 failed, 4 passed\n');
    const r = h.state(dir, 'baseline');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.json.known_failures, ['tests/old-broken.test.js']);
    assert.ok(r.json.commit && r.json.recorded_at && typeof r.json.test_duration_sec === 'number');
  }
  h.startTask(dir, 'demo-task', 'fix');
  h.state(dir, 'stage', 'code');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  return dir;
}
const stop = (dir) => h.runScript('stop-gate.js', { hook_event_name: 'Stop', cwd: dir }, dir);

test('baseline: a failure known before the task does not make Stop red', () => {
  const dir = project();
  h.write(dir, '.out', 'FAIL tests/old-broken.test.js\nTests: 1 failed, 4 passed\n');
  const r = stop(dir);
  assert.match(r.json.reason, /проверки зелёные/);
  assert.match(r.json.reason, /падали до задачи \(baseline, не красное\): tests\/old-broken\.test\.js/);
  const s = h.readState(dir);
  assert.strictEqual(s.check_cycles, 0);
  assert.deepStrictEqual(s.baseline_report.preexisting, ['tests/old-broken.test.js']);
});

test('baseline: a new failure blocks Stop as red', () => {
  const dir = project();
  h.write(dir, '.out', 'FAIL tests/old-broken.test.js\nFAIL tests/app.test.js\nTests: 2 failed, 3 passed\n');
  const r = stop(dir);
  assert.match(r.json.reason, /проверки красные/);
  assert.match(r.json.reason, /новые падения \(нет в baseline\): tests\/app\.test\.js/);
  assert.strictEqual(h.readState(dir).check_cycles, 1);
});

test('baseline: unrecognized output format -> red by exit code, comparison noted as not done', () => {
  const dir = project();
  h.write(dir, '.out', 'something went wrong\n');
  const r = stop(dir);
  assert.match(r.json.reason, /проверки красные/);
  assert.match(r.json.reason, /сравнение с baseline не выполнено/);
  assert.strictEqual(h.readState(dir).baseline_report.compared, false);
});

test('baseline: without a baseline the old exit-code behaviour stays', () => {
  const dir = project({ baseline: false });
  h.write(dir, '.out', 'FAIL tests/old-broken.test.js\nTests: 1 failed\n');
  assert.match(stop(dir).json.reason, /проверки красные/);
});

test('baseline: fixing a baseline test is reported as progress', () => {
  const dir = project();
  h.fs.unlinkSync(h.path.join(dir, '.out'));
  h.write(dir, 'tests/old-broken.test.js', "test('was broken', () => { expect(1).toBe(1); });\n");
  stop(dir);
  assert.deepStrictEqual(h.readState(dir).baseline_report.fixed, ['tests/old-broken.test.js']);
});

test('baseline: not refreshed during a task; `check test` compares the full suite', () => {
  const dir = project();
  const r = h.state(dir, 'baseline');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /не обновляется во время задачи/);
  h.write(dir, '.out', 'FAIL tests/old-broken.test.js\nTests: 1 failed\n');
  const c = h.state(dir, 'check', 'test');
  assert.strictEqual(c.status, 0, 'known failure only -> not red');
  assert.strictEqual(c.json.red, false);
});
