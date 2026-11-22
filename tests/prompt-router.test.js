'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

function ctx(r) {
  return r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext : '';
}
const ev = (dir, prompt) => h.runScript('prompt-router.js', { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt }, dir);

test('prompt-router: message starting with "?" bypasses the pipeline', () => {
  const dir = h.makeProject();
  const r = ev(dir, '?  как устроен модуль оплаты');
  assert.strictEqual(r.status, 0);
  assert.match(ctx(r), /это вопрос, а не задача/);
  assert.doesNotMatch(ctx(r), /vserence:router/);
});

test('prompt-router: plain task goes to the router', () => {
  const dir = h.makeProject();
  const r = ev(dir, 'Добавь экспорт отчёта в CSV');
  assert.match(ctx(r), /Вызови скилл vserence:router/);
});

test('prompt-router: slash command is left alone', () => {
  const dir = h.makeProject();
  assert.strictEqual(ev(dir, '/vserence:init').stdout, '');
});

test('prompt-router: answer to a pending question resumes the task and clears the flag', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', 'feature');
  h.state(dir, 'ask');
  assert.strictEqual(h.readState(dir).awaiting_user, true);
  const r = ev(dir, 'Вариант 2');
  assert.match(ctx(r), /ответ на вопрос по задаче «demo-task»/);
  assert.strictEqual(h.readState(dir).awaiting_user, false);
});
