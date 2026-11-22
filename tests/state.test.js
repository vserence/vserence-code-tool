'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

test('state: start creates branch vserence/<name> and state.json', () => {
  const dir = h.makeProject();
  const s = h.startTask(dir, 'csv-export', 'feature');
  assert.strictEqual(s.stage, 'spec');
  assert.strictEqual(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'vserence/csv-export');
});

test('state: mode is raised fix -> feature and never lowered', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', 'fix');
  assert.notStrictEqual(h.state(dir, 'escalate', 'feature').status, 0, 'reason is required');
  assert.strictEqual(h.state(dir, 'escalate', 'feature', 'затронута схема БД').status, 0);
  const r = h.state(dir, 'escalate', 'fix', 'x');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /не опускается/);
});

test('state: review returns work at most 2 times, the 3rd marks "не завершено"', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', 'feature');
  for (let i = 1; i <= 3; i++) {
    h.state(dir, 'stage', 'review');
    assert.strictEqual(h.state(dir, 'review-fail', 'не покрыт риск').status, 0);
  }
  const s = h.readState(dir);
  assert.strictEqual(s.review_cycles, 3);
  assert.strictEqual(s.status, 'incomplete');
});

test('state: report only after review; done requires report.md', () => {
  const dir = h.makeProject();
  h.startTask(dir, 'demo-task', 'fix');
  h.state(dir, 'stage', 'verify');
  assert.notStrictEqual(h.state(dir, 'stage', 'report').status, 0);
  h.state(dir, 'stage', 'review');
  assert.strictEqual(h.state(dir, 'stage', 'report').status, 0);
  assert.notStrictEqual(h.state(dir, 'done').status, 0);
  h.write(dir, '.vserence/tasks/demo-task/report.md', '#');
  assert.strictEqual(h.state(dir, 'done').status, 0);
});
