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

const MAX_IDLE_BLOCKS = 3;

// Progress = something observable changed since the previous block: contract, task, stage, counters, files.
function progressSig(dir, task) {
  const porcelain = L.isGitRepo(dir) ? (L.git(dir, ['status', '--porcelain']) || '') : '';
  const s = task ? task.state : {};
  return require('node:crypto').createHash('sha1').update(JSON.stringify([
    L.hasChecks(dir), task && task.name, s.stage, s.status, s.check_cycles, s.review_cycles, porcelain,
  ])).digest('hex').slice(0, 16);
}

// Pipeline-incomplete block, limited to MAX_IDLE_BLOCKS consecutive blocks without progress.
// After the limit the stop is let through and a warning is left for the next SessionStart.
function guardedBlock(dir, pending, task, reason) {
  if (pending) {
    const sig = progressSig(dir, task);
    if (pending.last_sig !== sig) pending.stop_blocks = 0;
    pending.last_sig = sig;
    if ((pending.stop_blocks || 0) >= MAX_IDLE_BLOCKS) {
      pending.stop_blocks = 0;
      pending.skipped_warning = `Stop-ворота пропустили остановку после ${MAX_IDLE_BLOCKS} блокировок подряд без прогресса ` +
        `(${new Date().toISOString()}). Конвейер не пройден: ${reason.replace(/^vserence stop-gate: /, '')}`;
      L.writePending(dir, pending);
      L.emit({ systemMessage: 'vserence: конвейер не пройден, остановка пропущена после ' + MAX_IDLE_BLOCKS +
        ' блокировок без прогресса. Результат не проверен.' });
      process.exit(0);
    }
    pending.stop_blocks = (pending.stop_blocks || 0) + 1;
    L.writePending(dir, pending);
  }
  block(reason + (pending ? ` (блокировка ${pending.stop_blocks} из ${MAX_IDLE_BLOCKS} без прогресса)` : ''));
}

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const isGit = L.isGitRepo(dir);
  const pending = L.readPending(dir);
  if (pending && (pending.question_turn || pending.awaiting_user)) return; // question or waiting for the user
  let task = isGit ? L.activeTask(dir) : null;
  if (task && pending && pending.task !== task.name) task = null; // old task branch, new message not started

  if (pending && !task) {
    const steps = [];
    if (!isGit) steps.push('папка не git-репозиторий: спроси пользователя про `git init` (`node "' + L.STATE_SCRIPT + '" ask`)');
    if (!L.hasChecks(dir)) steps.push('онбординг (скилл vserence:onboarding): контракта .vserence/checks.json нет');
    steps.push('скилл vserence:router и `node "' + L.STATE_SCRIPT + '" start <имя> <режим>`');
    steps.push('этапы режима, ревью и отчёт .vserence/tasks/<имя>/report.md');
    guardedBlock(dir, pending, null, 'vserence stop-gate: сообщение-задача не прошло конвейер. Нужно: ' +
      steps.map((x, i) => `(${i + 1}) ${x}`).join('; ') + '. Пропускать конвейер нельзя, даже для маленькой правки. ' +
      'Если нужен ответ пользователя — задай вопрос и выполни `ask`.');
  }
  if (!isGit || !task) return;
  const checks = L.loadChecks(dir);
  const s = task.state;
  const td0 = '.vserence/tasks/' + task.name + '/';
  const reportExists = L.exists(L.path.join(dir, td0, 'report.md'));
  if (s.status === 'incomplete' && !reportExists) {
    guardedBlock(dir, pending, task, `vserence stop-gate: задача «${task.name}» остановлена (${s.incomplete_reason || 'не завершено'}). ` +
      `Выпусти отчёт ${td0}report.md по скиллу vserence:report со статусом «не завершено» и списком открытых проблем.`);
  }
  if (s.status !== 'in_progress') {
    if (reportExists) L.clearPending(dir);
    return;
  }
  if (s.awaiting_user) return; // the only mandatory stop: a question to the user
  if (!checks) {
    guardedBlock(dir, pending, task, 'vserence stop-gate: нет .vserence/checks.json — онбординг не завершён. ' +
      'Выполни скилл vserence:onboarding, затем продолжи задачу.');
  }
  const base = s.base_sha || s.base_branch;
  if (!base) return;
  const td = '.vserence/tasks/' + task.name + '/';
  const files = changedFiles(dir, base);

  if (s.mode === 'investigate') {
    if (files.length) {
      guardedBlock(dir, pending, task, `vserence stop-gate: режим investigate запрещает правки кода, а изменены: ${files.map((f) => f.file).join(', ')}. ` +
        'Откати их (git checkout -- <файл> / удали новые файлы) и запиши выводы в ' + td + 'report.md.');
    }
    if (s.stage !== 'done' && !L.exists(L.path.join(dir, td, 'report.md'))) {
      guardedBlock(dir, pending, task, 'vserence stop-gate: результат investigate не записан: создай ' + td + 'report.md (гипотезы по убыванию ' +
        'вероятности, доказательство и способ проверки каждой, следующая задача с режимом) и выполни done.');
    }
    L.clearPending(dir); // report.md written
    return;
  }

  // Nothing changed in code yet (spec/plan stages): nothing to check, but the pipeline is not finished.
  if (files.length === 0 && ['spec', 'plan'].includes(s.stage)) {
    if (!pending) return;
    guardedBlock(dir, pending, task, `vserence stop-gate: задача «${task.name}» на этапе ${s.stage}: ` +
      'допиши spec.md/plan.md и продолжай конвейер; остановка только для вопроса пользователю (`ask`).');
  }

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
    if (name === 'test_changed' && checks.baseline && !r.timedOut) {
      const cmp = require('./baseline.js').compare(checks.baseline, r, changed);
      s.baseline_report = { at: new Date().toISOString(), command: 'test_changed', ...cmp };
      if (!cmp.red) {
        if (cmp.preexisting.length) notes.push('падали до задачи (baseline, не красное): ' + cmp.preexisting.join(', '));
        if (cmp.fixed.length) notes.push('починены тесты из baseline: ' + cmp.fixed.join(', '));
        continue;
      }
      red.push(`${name} (${cmd}) exit ${r.status}` +
        (cmp.compared ? `, новые падения (нет в baseline): ${cmp.new_failures.join(', ')}` : ` (${cmp.note})`) +
        `:\n${L.tail(r.out, 1200)}`);
      continue;
    }
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
  if (s.baseline_report) L.saveState(task);
  const report = L.path.join(dir, td, 'report.md');
  const remaining = {
    tests: 'тесты → код → verify (полные test и build один раз, e2e если затронуты критичные пути) → ревью → отчёт',
    code: 'verify (полные test и build один раз, e2e если затронуты критичные пути) → ревью → отчёт',
    verify: 'полные test и build один раз (e2e если затронуты критичные пути), затем stage review и ревьюер',
    review: 'ревьюер (сабагент vserence:reviewer) и его вердикт, затем stage report',
    report: 'отчёт ' + td + 'report.md по скиллу vserence:report, коммит, затем done',
  };
  if (s.stage === 'report' && L.exists(report)) { // report written: allow stop, drop the flag
    L.clearPending(dir);
    return;
  }
  if (remaining[s.stage]) {
    guardedBlock(dir, pending, task, `vserence stop-gate: проверки зелёные${notes.length ? ' (' + notes.join('; ') + ')' : ''}. ` +
      `Задача «${task.name}» не завершена, этап ${s.stage}. Осталось: ${remaining[s.stage]}.`);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence stop-gate: ' + e.message + '\n');
}
process.exit(0);
