'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

const stop = (dir) => h.runScript('stop-gate.js', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, dir);
const blocked = (r) => !!(r.json && r.json.decision === 'block');

function project(stage = 'code', mode = 'fix') {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', mode);
  if (stage !== h.readState(dir).stage) assert.strictEqual(h.state(dir, 'stage', stage).status, 0);
  return dir;
}

test('stop-gate: no active task -> allows stop silently', () => {
  const dir = h.makeProject();
  const r = stop(dir);
  assert.strictEqual(r.stdout, '');
});

test('stop-gate: green checks on stage "report" with report.md -> allows stop', () => {
  const dir = project('review');
  h.state(dir, 'stage', 'report');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  h.write(dir, '.vserence/tasks/demo-task/report.md', '## Итог\n');
  const r = stop(dir);
  assert.strictEqual(r.stdout, '', r.stdout);
});

test('stop-gate: green checks but pipeline not finished -> blocks with remaining steps', () => {
  const dir = project('code');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  const r = stop(dir);
  assert.ok(blocked(r));
  assert.match(r.json.reason, /проверки зелёные/);
  assert.match(r.json.reason, /Осталось: verify/);
  assert.strictEqual(h.readState(dir).check_cycles, 0);
});

test('stop-gate: red lint/typecheck/test_changed -> blocks and counts the cycle', () => {
  const dir = project('code');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  h.write(dir, '.fail-typecheck', '');
  const r = stop(dir);
  assert.ok(blocked(r));
  assert.match(r.json.reason, /проверки красные \(возврат 1 из 5\)/);
  assert.match(r.json.reason, /typecheck/);
  assert.strictEqual(h.readState(dir).check_cycles, 1);
});

test('stop-gate: after 5 returns the 6th red stops the task as "не завершено"', () => {
  const dir = project('code');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  h.write(dir, '.fail-lint', '');
  for (let i = 1; i <= 5; i++) assert.match(stop(dir).json.reason, new RegExp(`возврат ${i} из 5`));
  const r = stop(dir);
  assert.match(r.json.reason, /лимит циклов исправлений \(5\) исчерпан/);
  const s = h.readState(dir);
  assert.strictEqual(s.status, 'incomplete');
  // until the report is written the stop is still blocked, then allowed
  assert.match(stop(dir).json.reason, /не завершено/);
  h.write(dir, '.vserence/tasks/demo-task/report.md', '## Итог\n');
  assert.strictEqual(stop(dir).stdout, '');
});

test('stop-gate: .only / skip / xfail added in tests -> blocked even with green commands', () => {
  for (const line of ["test.only('adds', () => {});", 'it.skip("x", () => {})', '@pytest.mark.xfail', 'xit("x")']) {
    const dir = project('code');
    h.write(dir, 'tests/extra.test.js', line + '\n');
    const r = stop(dir);
    assert.ok(blocked(r), line);
    assert.match(r.json.reason, /защита тестов/, line);
  }
});

test('stop-gate: deleted test file and weakened assertions are blocked', () => {
  let dir = project('code');
  h.fs.unlinkSync(h.path.join(dir, 'tests', 'app.test.js'));
  let r = stop(dir);
  assert.match(r.json.reason, /удалён тестовый файл tests\/app\.test\.js/);

  dir = project('tests');
  h.write(dir, 'tests/app.test.js', "const add = require('../src/app');\ntest('adds two numbers', () => {\n});\n");
  r = stop(dir);
  assert.match(r.json.reason, /ослаблены проверки/);
});

test('stop-gate: "if test environment" branch in production code is blocked', () => {
  const dir = project('code');
  h.write(dir, 'src/app.js', "module.exports = (a, b) => (process.env.NODE_ENV === 'test' ? 3 : a + b);\n");
  const r = stop(dir);
  assert.ok(blocked(r));
  assert.match(r.json.reason, /ветка «если тестовое окружение»/);
});

test('stop-gate: waiting for the user answer -> allows stop', () => {
  const dir = project('code');
  h.write(dir, '.fail-lint', '');
  h.write(dir, 'src/app.js', '//\n');
  h.state(dir, 'ask');
  assert.strictEqual(stop(dir).stdout, '');
});

test('stop-gate: investigate with code changes -> blocked', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', 'investigate');
  h.write(dir, 'src/app.js', '//\n');
  const r = stop(dir);
  assert.match(r.json.reason, /investigate запрещает правки кода/);
});
