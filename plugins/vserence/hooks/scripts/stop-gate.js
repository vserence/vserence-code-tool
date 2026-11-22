#!/usr/bin/env node
'use strict';
// Stop: lint, typecheck, test_changed from checks.json + diff guard (skip/only/xfail, deleted tests,
// weakened assertions, "if test environment" branches in production code).
// Red = Claude does not stop (decision: block). Up to 5 returns, then status "не завершено".
const L = require('./lib.js');

const SKIP_PATTERNS = [
  [/\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(/, '.skip/.only/.todo'],
  [/\b(xit|xtest|xdescribe|fit|fdescribe|xcontext)\s*\(/, 'xit/fit/xdescribe'],
  [/@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail)\s*\(/, 'pytest skip/xfail'],
  [/@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/, 'unittest skip'],
  [/@(Disabled|Ignore)\b|\[(Ignore|Skip)\b|\(Skip\s*=/, '@Disabled/@Ignore'],
  [/\bt\.Skip(Now|f)?\s*\(/, 'Go t.Skip'],
  [/#\[ignore\]/, 'Rust #[ignore]'],
  [/\bskip\s*\(\s*["']|\bpending\s*\(|\bxspecify\b/, 'skip/pending'],
  [/\bmarkTestSkipped\s*\(|@group\s+skip/, 'PHPUnit skip'],
];
const TEST_ENV_BRANCH = [
  /NODE_ENV\s*[!=]==?\s*["']test["']|["']test["']\s*[!=]==?\s*process\.env\.NODE_ENV/,
  /process\.env\.(JEST_WORKER_ID|VITEST|CI_TEST|TESTING|IS_TEST)\b/,
  /["']pytest["']\s+in\s+sys\.modules|\bsys\.modules\.get\(\s*["']pytest/,
  /os\.environ(\.get)?\s*[[(]\s*["'](TESTING|PYTEST_CURRENT_TEST|IS_TEST)["']/,
  /\bsettings\.TESTING\b|\bapp\.config\[\s*["']TESTING["']\s*\]|\bapp\.testing\b/,
  /Rails\.env\.test\?|\bENV\[\s*["'](RAILS_ENV|RACK_ENV)["']\s*\]\s*==\s*["']test["']/,
  /\btesting\.Testing\(\)|flag\.Lookup\(\s*"test\./,
  /\bif\s+(TEST|TESTING|IS_TEST|isTest|isTesting|inTest)\b/,
  /\bAPP_ENV\s*[!=]==?\s*["']test(ing)?["']|\benv\(\s*["']APP_ENV["']\s*\)\s*===?\s*["']testing["']/,
];
const ASSERT_RE = /\b(assert\w*|expect|should|verify|assertThat|require\.\w+|t\.(Error|Fatal)\w*)\b/;
const TEST_DEF_RE = /^\s*(def\s+test_|func\s+Test|(it|test)\s*\(|@Test\b|#\[test\]|\[(Fact|Test|TestMethod)\]|public\s+function\s+test)/;

function changedFiles(dir, base) {
  const diffNames = (L.git(dir, ['diff', '--name-status', base]) || '').split(/\r?\n/).filter(Boolean);
  const files = [];
  for (const line of diffNames) {
    const parts = line.split('\t');
    const status = parts[0][0];
    const file = parts[parts.length - 1];
    files.push({ status, file, from: parts.length > 2 ? parts[1] : null });
  }
  const untracked = (L.git(dir, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/).filter(Boolean);
  for (const f of untracked) files.push({ status: 'A', file: f, untracked: true });
  return files.filter((f) => !L.toPosix(f.file).startsWith('.vserence/'));
}

function addedRemoved(dir, base, f) {
  if (f.untracked) {
    const t = L.readText(L.path.join(dir, f.file)) || '';
    return { added: t.split(/\r?\n/), removed: [] };
  }
  const d = L.git(dir, ['diff', '-U0', base, '--', f.file]) || '';
  const added = [];
  const removed = [];
  for (const line of d.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

function diffGuard(dir, base, files) {
  const issues = [];
  for (const f of files) {
    const abs = L.path.join(dir, f.file);
    const isTest = L.isTestPath(dir, abs);
    if (f.status === 'D' && isTest) {
      issues.push(`удалён тестовый файл ${f.file}`);
      continue;
    }
    if (f.status === 'D' || L.isSecretPath(dir, abs)) continue;
    const { added, removed } = addedRemoved(dir, base, f);
    if (isTest) {
      for (const line of added) {
        for (const [re, label] of SKIP_PATTERNS) {
          if (re.test(line)) issues.push(`${f.file}: ${label} — «${line.trim().slice(0, 120)}»`);
        }
      }
      const defsRemoved = removed.filter((l) => TEST_DEF_RE.test(l)).length;
      const defsAdded = added.filter((l) => TEST_DEF_RE.test(l)).length;
      if (defsRemoved > defsAdded) issues.push(`${f.file}: удалено тестов ${defsRemoved - defsAdded} (определения тестов)`);
      const asRemoved = removed.filter((l) => ASSERT_RE.test(l)).length;
      const asAdded = added.filter((l) => ASSERT_RE.test(l)).length;
      if (asRemoved > asAdded) issues.push(`${f.file}: ослаблены проверки — удалено утверждений ${asRemoved - asAdded}`);
    } else {
      for (const line of added) {
        if (TEST_ENV_BRANCH.some((re) => re.test(line))) {
          issues.push(`${f.file}: ветка «если тестовое окружение» в рабочем коде — «${line.trim().slice(0, 120)}»`);
        }
      }
    }
  }
  return issues;
}

function block(reason) {
  L.emit({ decision: 'block', reason });
  process.exit(0);
}

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  if (!L.isGitRepo(dir)) return;
  const checks = L.loadChecks(dir);
  if (!checks) return;
  const task = L.activeTask(dir);
  if (!task) return;
  const s = task.state;
  const td0 = '.vserence/tasks/' + task.name + '/';
  if (s.status === 'incomplete' && !L.exists(L.path.join(dir, td0, 'report.md'))) {
    block(`vserence stop-gate: задача «${task.name}» остановлена (${s.incomplete_reason || 'не завершено'}). ` +
      `Выпусти отчёт ${td0}report.md по скиллу vserence:report со статусом «не завершено» и списком открытых проблем.`);
  }
  if (s.status !== 'in_progress') return;
  if (s.awaiting_user) return; // the only mandatory stop: a question to the user
  const base = s.base_sha || s.base_branch;
  if (!base) return;
  const td = '.vserence/tasks/' + task.name + '/';
  const files = changedFiles(dir, base);

  if (s.mode === 'investigate') {
    if (files.length) {
      block(`vserence stop-gate: режим investigate запрещает правки кода, а изменены: ${files.map((f) => f.file).join(', ')}. ` +
        'Откати их (git checkout -- <файл> / удали новые файлы) и запиши выводы в ' + td + 'report.md.');
    }
    if (s.stage !== 'done' && !L.exists(L.path.join(dir, td, 'report.md'))) {
      block('vserence stop-gate: результат investigate не записан: создай ' + td + 'report.md (гипотезы по убыванию ' +
        'вероятности, доказательство и способ проверки каждой, следующая задача с режимом) и выполни done.');
    }
    return;
  }

  // Nothing changed in code yet (spec/plan stages): nothing to check.
  if (files.length === 0 && ['spec', 'plan'].includes(s.stage)) return;

  const red = [];
  const notes = [];
  const changed = files.filter((f) => f.status !== 'D').map((f) => L.toPosix(f.file));
  for (const name of ['lint', 'typecheck', 'test_changed']) {
    const raw = L.checkCommand(checks, name, true);
    if (!raw) {
      notes.push(`${name}: нет команды в checks.json (не проверено)`);
      continue;
    }
    const cmd = L.fillCommand(raw, changed);
    if (!cmd) continue; // command needs files and nothing changed
    const timeout = name === 'test_changed' ? 280000 : 180000;
    const r = L.runCommand(cmd, dir, timeout);
    if (!r.ok) red.push(`${name} (${cmd}) ${r.timedOut ? 'превысил таймаут' : 'exit ' + r.status}:\n${L.tail(r.out, 1200)}`);
    if (name === 'test_changed' && r.seconds > L.LIMITS.testChangedSeconds) {
      notes.push(`test_changed шёл ${Math.round(r.seconds)} с > ${L.LIMITS.testChangedSeconds} с: нестабильная скорость, отметь в отчёте`);
    }
  }
  const guard = diffGuard(dir, base, files);
  if (guard.length) red.push('защита тестов:\n- ' + guard.join('\n- '));

  if (red.length) {
    s.check_cycles += 1;
    s.open_issues = red.map((r) => r.split('\n')[0]);
    if (s.check_cycles > L.LIMITS.checkCycles) {
      s.status = 'incomplete';
      s.stage = 'report';
      s.incomplete_reason = `красные проверки после ${L.LIMITS.checkCycles} циклов исправлений`;
      L.saveState(task);
      block(`vserence stop-gate: лимит циклов исправлений (${L.LIMITS.checkCycles}) исчерпан. Не исправляй дальше. ` +
        `Выпусти отчёт по скиллу vserence:report со статусом «не завершено», уверенность низкая, и списком открытых проблем:\n` +
        red.join('\n\n'));
    }
    L.saveState(task);
    block(`vserence stop-gate: проверки красные (возврат ${s.check_cycles} из ${L.LIMITS.checkCycles}). Исправь и продолжай.\n` +
      red.join('\n\n') + (notes.length ? '\n\nЗаметки: ' + notes.join('; ') : ''));
  }

  // Green. Do not let the pipeline end before review and report.
  const report = L.path.join(dir, td, 'report.md');
  const remaining = {
    tests: 'тесты → код → verify (полные test и build один раз, e2e если затронуты критичные пути) → ревью → отчёт',
    code: 'verify (полные test и build один раз, e2e если затронуты критичные пути) → ревью → отчёт',
    verify: 'полные test и build один раз (e2e если затронуты критичные пути), затем stage review и ревьюер',
    review: 'ревьюер (сабагент vserence:reviewer) и его вердикт, затем stage report',
    report: 'отчёт ' + td + 'report.md по скиллу vserence:report, коммит, затем done',
  };
  if (s.stage === 'report' && L.exists(report)) return; // report written: allow stop
  if (remaining[s.stage]) {
    block(`vserence stop-gate: проверки зелёные${notes.length ? ' (' + notes.join('; ') + ')' : ''}. ` +
      `Задача «${task.name}» не завершена, этап ${s.stage}. Осталось: ${remaining[s.stage]}.`);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence stop-gate: ' + e.message + '\n');
}
process.exit(0);
