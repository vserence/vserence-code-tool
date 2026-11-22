'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

const post = (dir, rel) => h.runScript('post-edit.js', {
  hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Edit',
  tool_input: { file_path: h.path.join(dir, rel) }, tool_response: { success: true },
}, dir);

test('post-edit: format and lint green -> no output', () => {
  const dir = h.makeProject();
  assert.strictEqual(post(dir, 'src/app.js').stdout, '');
});

test('post-edit: lint red -> only the error goes back to Claude', () => {
  const dir = h.makeProject();
  h.write(dir, '.fail-lint', '');
  const r = post(dir, 'src/app.js');
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /lint/);
  assert.doesNotMatch(r.json.reason, /format \(/);
});

test('post-edit: files inside .vserence/ are not checked', () => {
  const dir = h.makeProject();
  h.write(dir, '.fail-lint', '');
  assert.strictEqual(post(dir, '.vserence/project.md').stdout, '');
});
