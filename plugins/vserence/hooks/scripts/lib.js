'use strict';
// Shared helpers for vserence hook scripts. Node.js standard library only.
// Works on macOS, Linux and Windows: no shell utilities, paths via node:path.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CONTRACT_VERSION = 1;
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const STATE_SCRIPT = path.join(__dirname, 'vserence-state.js');

// ---- Definitions and thresholds (spec: "Определения и пороги") ----
const LIMITS = {
  checkCycles: 5,          // red checks return work up to 5 times
  reviewCycles: 2,         // review returns work up to 2 times
  testChangedSeconds: 60,  // test_changed must fit in 60 s
  unitSuiteSeconds: 300,   // full unit suite must fit in 5 min
  contextTokensMax: 8000,  // permanent context budget 6-8k tokens
  contextTokensMin: 6000,
  compactPercent: 60,
};

const MODES = ['fix', 'feature', 'refactor', 'greenfield', 'investigate'];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput() {
  const raw = readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function projectDir(input) {
  const d = process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
  return path.resolve(d);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return undefined; // exists but invalid
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function isGitRepo(dir) {
  const out = git(dir, ['rev-parse', '--is-inside-work-tree']);
  return out != null && out.trim() === 'true';
}

function currentBranch(dir) {
  const out = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out ? out.trim() : null;
}

function vserenceDir(dir) {
  return path.join(dir, '.vserence');
}

function taskDir(dir, name) {
  return path.join(vserenceDir(dir), 'tasks', name);
}

function statePath(dir, name) {
  return path.join(taskDir(dir, name), 'state.json');
}

// Active task = current git branch vserence/<name> with an existing state.json.
function activeTask(dir) {
  const br = currentBranch(dir);
  if (!br || !br.startsWith('vserence/')) return null;
  const name = br.slice('vserence/'.length);
  const p = statePath(dir, name);
  const state = readJson(p);
  if (!state) return null;
  return { name, path: p, state };
}

function saveState(task) {
  task.state.updated_at = new Date().toISOString();
  writeJson(task.path, task.state);
}

function loadChecks(dir) {
  const p = path.join(vserenceDir(dir), 'checks.json');
  const c = readJson(p);
  if (!c || typeof c !== 'object') return null;
  return c;
}

// checks.json entry: "lint": {"run": "...", "quiet": "..."} or a plain string or null.
function checkCommand(checks, name, preferQuiet = true) {
  if (!checks) return null;
  const src = checks.commands && typeof checks.commands === 'object' ? checks.commands : checks;
  const v = src[name];
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (preferQuiet && typeof v.quiet === 'string' && v.quiet.trim()) return v.quiet;
    if (typeof v.run === 'string' && v.run.trim()) return v.run;
  }
  return null;
}

function quoteArg(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

// Substitutes {file} and {files}. Returns null if command needs files but none given.
function fillCommand(cmd, files) {
  const needs = /\{files?\}/.test(cmd);
  if (!needs) return cmd;
  if (!files || files.length === 0) return null;
  const joined = files.map(quoteArg).join(' ');
  return cmd.replace(/\{files\}/g, joined).replace(/\{file\}/g, quoteArg(files[0]));
}

function runCommand(cmd, cwd, timeoutMs) {
  const started = Date.now();
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs || 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const seconds = (Date.now() - started) / 1000;
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return { ok: !r.error && r.status === 0, status: r.status, out, seconds, timedOut };
}

function tail(text, max = 1500) {
  if (!text) return '';
  if (text.length <= max) return text;
  return '…\n' + text.slice(text.length - max);
}

// ---- Path classification ----
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function relToProject(dir, file) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(dir, file);
  return toPosix(path.relative(dir, abs));
}

function globToRegExp(glob) {
  // Supports **, *, ? ; matches against posix relative path or basename.
  let re = '';
  const g = toPosix(glob.trim());
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function matchesGlob(rel, glob) {
  const re = globToRegExp(glob);
  const base = rel.split('/').pop();
  return re.test(rel) || (!glob.includes('/') && re.test(base));
}

// Secret files (spec): .env* except .env.example; *.pem, *.key, *.p12; id_rsa*; credentials*;
// plus paths from the "Секреты" section of conventions.md.
const SECRET_GLOBS = ['.env*', '*.pem', '*.key', '*.p12', 'id_rsa*', 'credentials*'];
const SECRET_EXCEPTIONS = ['.env.example'];

function markdownSection(text, titleRegex) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const items = [];
  let inside = false;
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inside = titleRegex.test(h[1].trim());
      continue;
    }
    if (!inside) continue;
    const m = /^\s*[-*]\s+`?([^`]+?)`?\s*$/.exec(line);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function conventions(dir) {
  return readText(path.join(vserenceDir(dir), 'conventions.md')) || '';
}

function secretGlobs(dir) {
  const extra = markdownSection(conventions(dir), /^секреты$/i);
  return SECRET_GLOBS.concat(extra);
}

function isSecretPath(dir, file) {
  const rel = relToProject(dir, file);
  if (rel == null) return false;
  const base = rel.split('/').pop();
  if (SECRET_EXCEPTIONS.some((e) => e.toLowerCase() === base.toLowerCase())) return false;
  return secretGlobs(dir).some((g) => matchesGlob(rel, g));
}

// Test files: language-agnostic defaults plus "Пути тестов" section in conventions.md.
const TEST_GLOBS = [
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/specs/**', '**/e2e/**',
  '**/testdata/**', '**/fixtures/**',
  '*.test.*', '*.spec.*', '*_test.*', '*_spec.*', 'test_*.py', '*Test.java', '*Tests.java',
  '*Test.kt', '*Tests.cs', '*Test.cs', '*Test.php', '*_test.go', 'conftest.py',
];

function testGlobs(dir) {
  const extra = markdownSection(conventions(dir), /^пути тестов$/i);
  return TEST_GLOBS.concat(extra);
}

function isTestPath(dir, file) {
  const rel = relToProject(dir, file);
  if (rel == null || rel.startsWith('..')) return false;
  if (rel.startsWith('.vserence/')) return false;
  return testGlobs(dir).some((g) => matchesGlob(rel, g));
}

function isInside(dir, file) {
  const rel = path.relative(dir, path.resolve(dir, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---- Token estimate: chars/4 for latin, chars/2.5 for cyrillic ----
function estimateTokens(text) {
  if (!text) return 0;
  let cyr = 0;
  for (const ch of text) if (/[Ѐ-ӿ]/.test(ch)) cyr++;
  const other = [...text].length - cyr;
  return Math.round(cyr / 2.5 + other / 4);
}

function frontmatter(text) {
  if (!text || !text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

module.exports = {
  fs, path, os,
  CONTRACT_VERSION, PLUGIN_ROOT, STATE_SCRIPT, LIMITS, MODES,
  parseInput, projectDir, exists, readText, readJson, writeJson, git, isGitRepo, currentBranch,
  vserenceDir, taskDir, statePath, activeTask, saveState, loadChecks, checkCommand, fillCommand,
  runCommand, tail, toPosix, relToProject, matchesGlob, isSecretPath, isTestPath, isInside,
  secretGlobs, testGlobs, markdownSection, conventions, estimateTokens, frontmatter, emit,
};
