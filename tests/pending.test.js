'use strict';
// Regression for the live run failure: a task message was handled without onboarding, router and
// `start`, so the gates (keyed on an active task) stayed silent. Now a pending flag closes them.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

const prompt = (dir, text) => h.runScript('prompt-router.js', { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: text }, dir);
const stop = (dir) => h.runScript('stop-gate.js', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, dir);
const edit = (dir, rel) => h.preTool(dir, 'Edit', { file_path: h.path.join(dir, rel), old_string: 'a', new_string: 'b' });
const write = (dir, rel) => h.preTool(dir, 'Write', { file_path: h.path.join(dir, rel), content: 'x' });
const bash = (dir, command) => h.preTool(dir, 'Bash', { command });
const reason = (r) => r.json.hookSpecificOutput.permissionDecisionReason;
const pendingFile = (dir) => h.path.join(dir, '.git', 'vserence-pending.json');
const pending = (dir) => (h.fs.existsSync(pendingFile(dir)) ? JSON.parse(h.fs.readFileSync(pendingFile(dir), 'utf8')) : null);

test('pending: task message writes the flag into the git dir, also without .vserence/', () => {
  const dir = h.makeProject({ contract: false });
  prompt(dir, 'Исправь шахматку: пропуск между этажами');
  const p = pending(dir);
  assert.ok(p, 'flag written');
  assert.strictEqual(p.contract_present, false);
  assert.match(p.prompt_hash, /^[0-9a-f]{16}$/);
  assert.ok(p.at);
});

test('pending: without a contract Edit of code is blocked, contract files are allowed', () => {
  const dir = h.makeProject({ contract: false });
  prompt(dir, 'Исправь шахматку');
  const r = edit(dir, 'src/app.js');
  assert.ok(h.isDenied(r));
  assert.match(reason(r), /\(1\) онбординг/);
  assert.match(reason(r), /Пропускать конвейер нельзя, даже для маленькой правки/);
  for (const f of ['.vserence/checks.json', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.gitignore']) {
    assert.ok(!h.isDenied(write(dir, f)), f);
  }
  assert.ok(h.isDenied(bash(dir, "sed -i 's/a/b/' src/app.js")));
  assert.ok(h.isDenied(bash(dir, 'git commit -am fix')));
  assert.ok(!h.isDenied(bash(dir, 'git status && git log --oneline -3 && git diff')));
  assert.ok(!h.isDenied(bash(dir, 'grep -rn floor src')));
});

test('pending: with a contract but without router `start` Edit is blocked; reads and checks allowed', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  const r = edit(dir, 'src/app.js');
  assert.ok(h.isDenied(r));
  assert.match(reason(r), /vserence:router/);
  assert.match(reason(r), /vserence-state\.js" start/);
  assert.doesNotMatch(reason(r), /онбординг/);
  assert.ok(h.isDenied(h.preTool(dir, 'Write', { file_path: h.path.join(dir, 'tests/new.test.js'), content: '' })));
  assert.ok(h.isDenied(bash(dir, 'npm install lodash')));
  assert.ok(h.isDenied(bash(dir, 'echo x > src/app.js')));
  const testCmd = JSON.parse(h.fs.readFileSync(h.path.join(dir, '.vserence/checks.json'), 'utf8')).commands.test.run;
  assert.ok(!h.isDenied(bash(dir, testCmd)), 'command from checks.json');
  assert.ok(!h.isDenied(bash(dir, 'npx jest 2>&1 | tail -5')));
  assert.ok(!h.isDenied(h.preTool(dir, 'Read', { file_path: h.path.join(dir, 'src/app.js') })));
  // after start the normal stage rules apply
  h.startTask(dir, 'chess-floor-gap', 'fix');
  assert.ok(!h.isDenied(edit(dir, 'tests/app.test.js')));
});

test('pending: Stop without report is blocked; 3 blocks without progress -> stop let through + SessionStart warning', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  for (let i = 1; i <= 3; i++) {
    const r = stop(dir);
    assert.strictEqual(r.json && r.json.decision, 'block', 'block ' + i);
    assert.match(r.json.reason, /не прошло конвейер/);
    assert.match(r.json.reason, new RegExp(`блокировка ${i} из 3`));
  }
  const fourth = stop(dir);
  assert.notStrictEqual(fourth.json && fourth.json.decision, 'block');
  assert.match(fourth.json.systemMessage, /остановка пропущена/);
  const ss = h.runScript('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: dir }, dir);
  assert.match(ss.json.hookSpecificOutput.additionalContext, /ПРЕДУПРЕЖДЕНИЕ: Stop-ворота пропустили остановку/);
  // warning is shown once
  assert.ok(!pending(dir).skipped_warning);
});

test('pending: progress resets the no-progress counter', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  stop(dir);
  stop(dir);
  h.startTask(dir, 'chess-floor-gap', 'feature'); // progress: task started
  const r = stop(dir);
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /блокировка 1 из 3/);
});

test('pending: message with "?" is not blocked (no flag, Edit and Stop allowed)', () => {
  const dir = h.makeProject();
  prompt(dir, '? почему тесты шахматки падают');
  assert.strictEqual(pending(dir), null);
  assert.ok(!h.isDenied(edit(dir, 'src/app.js')));
  assert.strictEqual(stop(dir).stdout, '');
});

test('pending: "?" after a task message lets Stop through', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  prompt(dir, '? а что такое шахматка');
  assert.strictEqual(stop(dir).stdout, '');
});

test('pending: question to the user before start (ask) lets Stop through', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  assert.strictEqual(h.state(dir, 'ask').status, 0);
  assert.strictEqual(stop(dir).stdout, '');
});

test('pending: flag is removed once report.md is written', () => {
  const dir = h.makeProject();
  prompt(dir, 'Исправь шахматку');
  h.startTask(dir, 'chess-floor-gap', 'fix');
  h.state(dir, 'stage', 'review');
  h.state(dir, 'stage', 'report');
  h.write(dir, 'src/app.js', 'module.exports = (a, b) => b + a;\n');
  assert.strictEqual(stop(dir).json.decision, 'block', 'no report yet');
  h.write(dir, '.vserence/tasks/chess-floor-gap/report.md', '## Итог\n');
  assert.strictEqual(stop(dir).stdout, '');
  assert.strictEqual(pending(dir), null);
  assert.ok(!h.isDenied(edit(dir, 'src/app.js')), 'gates open again after the task');
});

test('pending: new task on an old finished task branch is blocked until a new start', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'old-task', 'fix');
  h.state(dir, 'stage', 'review');
  h.state(dir, 'stage', 'report');
  h.write(dir, '.vserence/tasks/old-task/report.md', '#');
  h.state(dir, 'done');
  prompt(dir, 'Новая задача: поправь фильтр');
  assert.ok(h.isDenied(edit(dir, 'src/app.js')));
  assert.strictEqual(stop(dir).json.decision, 'block');
  const s = h.startTask(dir, 'filter-fix', 'fix'); // start from a finished task branch returns to base first
  assert.strictEqual(s.base_branch, 'main');
});

test('pending: no git repo -> flag in tmpdir, Stop asks for git init', () => {
  const dir = h.makeProject({ gitInit: false, contract: false });
  prompt(dir, 'Сделай сервис');
  const r = stop(dir);
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /git init/);
  assert.ok(h.isDenied(edit(dir, 'src/app.js')));
  h.fs.unlinkSync(require('../plugins/vserence/hooks/scripts/lib.js').pendingPath(dir));
});
