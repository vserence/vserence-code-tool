'use strict';
// Contract freshness and permanent-context budget. Used by session-check and vserence-state.
const crypto = require('node:crypto');
const L = require('./lib.js');
const { fs, path, os } = L;

// Dependency manifests (spec: package.json, pyproject.toml, go.mod and analogues).
const MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py',
  'setup.cfg', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml',
  'Package.swift', 'deno.json', 'CMakeLists.txt', 'Makefile',
];
const MANIFEST_EXT = ['.csproj', '.fsproj', '.sln'];
// CI files.
const CI_FILES = ['.gitlab-ci.yml', '.travis.yml', 'Jenkinsfile', 'azure-pipelines.yml',
  'bitbucket-pipelines.yml', '.drone.yml'];
const CI_DIRS = ['.github/workflows', '.circleci', '.buildkite'];
const IGNORED_TOP = new Set(['.git', 'node_modules', '.vserence', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'target', '.idea', '.vscode', '.next', 'coverage']);

function hashFile(p) {
  const t = L.readText(p);
  if (t == null) return null;
  return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function snapshot(dir) {
  const manifests = {};
  for (const e of listDir(dir)) {
    if (!e.isFile()) continue;
    if (MANIFESTS.includes(e.name) || MANIFEST_EXT.includes(path.extname(e.name))) {
      manifests[e.name] = hashFile(path.join(dir, e.name));
    }
  }
  // first-level subfolders' manifests (monorepo packages)
  const topDirs = [];
  for (const e of listDir(dir)) {
    if (!e.isDirectory() || IGNORED_TOP.has(e.name)) continue;
    topDirs.push(e.name);
    for (const f of listDir(path.join(dir, e.name))) {
      if (f.isFile() && (MANIFESTS.includes(f.name) || MANIFEST_EXT.includes(path.extname(f.name)))) {
        manifests[e.name + '/' + f.name] = hashFile(path.join(dir, e.name, f.name));
      }
    }
  }
  const ci = {};
  for (const f of CI_FILES) {
    const h = hashFile(path.join(dir, f));
    if (h) ci[f] = h;
  }
  for (const d of CI_DIRS) {
    for (const f of listDir(path.join(dir, d))) {
      if (f.isFile()) ci[d + '/' + f.name] = hashFile(path.join(dir, d, f.name));
    }
  }
  topDirs.sort();
  return { manifests, ci, top_dirs: topDirs };
}

function pluginVersion() {
  const pj = L.readJson(path.join(L.PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  return (pj && pj.version) || '0.0.0';
}

function syncStatePath(dir) {
  return path.join(L.vserenceDir(dir), 'sync-state.json');
}

function writeSnapshot(dir) {
  const s = {
    contract_version: L.CONTRACT_VERSION,
    plugin_version: pluginVersion(),
    synced_at: new Date().toISOString(),
    ...snapshot(dir),
  };
  L.writeJson(syncStatePath(dir), s);
  return s;
}

function diffKeys(a = {}, b = {}) {
  const changed = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) changed.push(k);
  return changed;
}

// Returns list of human-readable reasons why sync is needed (empty = fresh).
function staleness(dir) {
  const reasons = [];
  const prev = L.readJson(syncStatePath(dir));
  const checks = L.loadChecks(dir);
  const cv = checks && checks.contract_version;
  if (cv !== undefined && cv !== L.CONTRACT_VERSION) {
    reasons.push(`версия контракта ${cv} ≠ версии формата плагина ${L.CONTRACT_VERSION}`);
  }
  if (!prev) {
    reasons.push('нет .vserence/sync-state.json (снимок прошлой синхронизации)');
    return reasons;
  }
  if (prev.contract_version !== L.CONTRACT_VERSION) {
    reasons.push(`снимок сделан для контракта v${prev.contract_version}, плагин ждёт v${L.CONTRACT_VERSION}`);
  }
  const now = snapshot(dir);
  const m = diffKeys(prev.manifests, now.manifests);
  if (m.length) reasons.push('изменились манифесты зависимостей: ' + m.join(', '));
  const c = diffKeys(prev.ci, now.ci);
  if (c.length) reasons.push('изменились файлы CI: ' + c.join(', '));
  const added = now.top_dirs.filter((d) => !(prev.top_dirs || []).includes(d));
  const removed = (prev.top_dirs || []).filter((d) => !now.top_dirs.includes(d));
  if (added.length || removed.length) {
    reasons.push('изменился список папок первого уровня: ' +
      [...added.map((d) => '+' + d), ...removed.map((d) => '-' + d)].join(', '));
  }
  return reasons;
}

// Files with @imports, one level deep (CLAUDE.md "@AGENTS.md").
function withImports(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const t = L.readText(file);
  if (t == null) return '';
  let out = t;
  const re = /(^|\s)@([^\s`]+\.md)\b/g;
  let m;
  while ((m = re.exec(t))) {
    const target = path.resolve(path.dirname(file), m[2].replace(/^~(?=\/)/, os.homedir()));
    out += '\n' + withImports(target, seen);
  }
  return out;
}

function skillDescriptions(skillsRoot) {
  const parts = [];
  for (const e of listDir(skillsRoot)) {
    if (!e.isDirectory()) continue;
    const t = L.readText(path.join(skillsRoot, e.name, 'SKILL.md'));
    if (!t) continue;
    const fm = L.frontmatter(t);
    if (String(fm['disable-model-invocation']).toLowerCase() === 'true') continue;
    parts.push((fm.name || e.name) + ': ' + (fm.description || '') + ' ' + (fm.when_to_use || ''));
  }
  return parts.join('\n');
}

function mdDescriptions(dirPath) {
  const parts = [];
  for (const e of listDir(dirPath)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const fm = L.frontmatter(L.readText(path.join(dirPath, e.name)) || '');
    if (String(fm['disable-model-invocation']).toLowerCase() === 'true') continue;
    parts.push(e.name.replace(/\.md$/, '') + ': ' + (fm.description || ''));
  }
  return parts.join('\n');
}

function rulesWithoutPaths(dir) {
  const parts = [];
  const rd = path.join(dir, '.claude', 'rules');
  for (const e of listDir(rd)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const t = L.readText(path.join(rd, e.name)) || '';
    if (!/^paths:/m.test(t.split('\n---')[0] || '')) parts.push(t);
  }
  return parts.join('\n');
}

// Estimate of permanently loaded context (MCP schemas and other plugins are NOT counted).
function contextBudget(dir) {
  const home = os.homedir();
  const items = [];
  const add = (label, text) => {
    const tokens = L.estimateTokens(text);
    if (tokens > 0) items.push({ label, tokens });
  };
  add('~/.claude/CLAUDE.md', withImports(path.join(home, '.claude', 'CLAUDE.md')));
  add('CLAUDE.md (+@imports)', withImports(path.join(dir, 'CLAUDE.md')));
  const claudeText = L.readText(path.join(dir, 'CLAUDE.md')) || '';
  if (!/@AGENTS\.md/.test(claudeText)) add('AGENTS.md', L.readText(path.join(dir, 'AGENTS.md')));
  add('CLAUDE.local.md', withImports(path.join(dir, 'CLAUDE.local.md')));
  add('.claude/rules без paths', rulesWithoutPaths(dir));
  add('описания скиллов проекта', skillDescriptions(path.join(dir, '.claude', 'skills')));
  add('описания скиллов vserence', skillDescriptions(path.join(L.PLUGIN_ROOT, 'skills')));
  add('описания команд vserence', mdDescriptions(path.join(L.PLUGIN_ROOT, 'commands')));
  add('описания агентов vserence', mdDescriptions(path.join(L.PLUGIN_ROOT, 'agents')));
  const total = items.reduce((s, i) => s + i.tokens, 0);
  return { total, items };
}

module.exports = { snapshot, writeSnapshot, staleness, contextBudget, pluginVersion, syncStatePath };
