'use strict';
// Test helpers: temporary git project with a .vserence contract whose checks are `node -e` stubs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'vserence', 'hooks', 'scripts');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// A check that fails when the flag file .fail-<name> exists in the project.
function stub(name) {
  return `node -e "process.exit(require('fs').existsSync('.fail-${name}')?1:0)"`;
}

function makeProject({ contract = true, gitInit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vserence-test-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'app.test.js'),
    "const add = require('../src/app');\ntest('adds two numbers', () => {\n  expect(add(1, 2)).toBe(3);\n});\n");
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.fail-*\n');
  if (contract) {
    fs.mkdirSync(path.join(dir, '.vserence', 'decisions'), { recursive: true });
    const commands = {};
    for (const n of ['format', 'lint', 'typecheck', 'test', 'test_changed', 'build']) {
      commands[n] = { run: stub(n), quiet: stub(n) };
    }
    commands.e2e = { run: null, quiet: null };
    commands.mutation = { run: null, quiet: null };
    fs.writeFileSync(path.join(dir, '.vserence', 'checks.json'),
      JSON.stringify({ contract_version: 1, commands }, null, 2));
    fs.writeFileSync(path.join(dir, '.vserence', 'project.md'), '# Проект\n');
    fs.writeFileSync(path.join(dir, '.vserence', 'conventions.md'), '# Конвенции\n\n## Секреты\n- config/master.txt\n\n## Продакшен\n- db.prod.example.com\n');
    fs.writeFileSync(path.join(dir, '.vserence', 'risks.md'), '# Риски\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# demo\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  }
  if (gitInit) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

function runScript(script, input, dir, extraArgs = []) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...extraArgs], {
    cwd: dir,
    input: input == null ? '' : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, CLAUDE_PROJECT_DIR: dir },
  });
  let json = null;
  if (r.stdout.trim()) {
    try { json = JSON.parse(r.stdout); } catch { json = null; }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function state(dir, ...args) {
  return runScript('vserence-state.js', null, dir, args);
}

function startTask(dir, name = 'demo-task', mode = 'fix') {
  const r = state(dir, 'start', name, mode);
  if (r.status !== 0) throw new Error('start failed: ' + r.stderr);
  return r.json;
}

function readState(dir, name = 'demo-task') {
  return JSON.parse(fs.readFileSync(path.join(dir, '.vserence', 'tasks', name, 'state.json'), 'utf8'));
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function preTool(dir, tool_name, tool_input, extra = {}) {
  return runScript('test-guard.js', { hook_event_name: 'PreToolUse', cwd: dir, tool_name, tool_input, ...extra }, dir);
}

function isDenied(r) {
  return !!(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny');
}

module.exports = { fs, path, git, makeProject, runScript, state, startTask, readState, write, preTool, isDenied };
