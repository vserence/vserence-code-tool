#!/usr/bin/env node
'use strict';
// The only sanctioned way to change task state (.vserence/tasks/<name>/state.json).
// Direct edits of state.json are blocked by test-guard.
//
// Usage (from the project root):
//   node vserence-state.js start <task-name> <mode>      create branch vserence/<name> and state
//   node vserence-state.js stage <stage>                 move forward to a stage
//   node vserence-state.js escalate <mode> "<reason>"    raise mode (fix -> feature); never lowers
//   node vserence-state.js ask                           mark: waiting for the user's answer
//   node vserence-state.js review-fail "<summary>"       reviewer returned work (limit 2)
//   node vserence-state.js incomplete "<reason>"         stop with status "не завершено"
//   node vserence-state.js done                          finish (requires report.md)
//   node vserence-state.js status                        print state
//   node vserence-state.js snapshot                      write .vserence/sync-state.json
//   node vserence-state.js context                       estimate permanent context tokens
const L = require('./lib.js');
const C = require('./contract.js');

// Stage sequence per mode (spec: "Режимы задач").
const FLOW = {
  fix: ['tests', 'code', 'verify', 'review', 'report'],
  feature: ['spec', 'plan', 'tests', 'code', 'verify', 'review', 'report'],
  refactor: ['plan', 'tests', 'code', 'verify', 'review', 'report'],
  greenfield: ['spec', 'plan', 'tests', 'code', 'verify', 'review', 'report'],
  investigate: ['investigate', 'report'],
};
const MODE_RANK = { investigate: 0, fix: 1, feature: 2, refactor: 2, greenfield: 3 };

function fail(msg) {
  process.stderr.write('vserence-state: ' + msg + '\n');
  process.exit(1);
}

function ok(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(0);
}

function requireTask(dir) {
  const t = L.activeTask(dir);
  if (!t) fail('нет активной задачи: текущая ветка не vserence/<имя> или нет state.json');
  return t;
}

function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const dir = L.projectDir({});

  switch (cmd) {
    case 'start': {
      const name = a1;
      const mode = a2;
      if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) fail('имя задачи: kebab-case, латиница, до 40 символов');
      if (!L.MODES.includes(mode)) fail('режим: ' + L.MODES.join('|'));
      if (!L.isGitRepo(dir)) fail('не git-репозиторий');
      let base = L.currentBranch(dir);
      if (base && base.startsWith('vserence/')) {
        const prev = L.activeTask(dir);
        if (prev && prev.state.status === 'in_progress') {
          fail(`на ветке незавершённой задачи ${base}; закончи её (report + done) или остановись (incomplete)`);
        }
        const back = (prev && prev.state.base_branch) || null;
        if (!back || L.git(dir, ['checkout', back]) == null) fail(`на ветке задачи ${base}; не удалось вернуться на основную ветку`);
        base = back;
      }
      const baseSha = (L.git(dir, ['rev-parse', 'HEAD']) || '').trim() || null;
      const branch = 'vserence/' + name;
      const existsBranch = L.git(dir, ['rev-parse', '--verify', '--quiet', branch]) != null;
      if (existsBranch) fail(`ветка ${branch} уже существует; выбери другое имя`);
      if (L.git(dir, ['checkout', '-b', branch]) == null) fail('не удалось создать ветку ' + branch);
      const state = {
        task: name,
        mode,
        mode_history: [{ mode, at: new Date().toISOString(), reason: 'router' }],
        stage: FLOW[mode][0],
        status: 'in_progress',
        branch,
        base_branch: base,
        base_sha: baseSha,
        check_cycles: 0,
        review_cycles: 0,
        awaiting_user: false,
        open_issues: [],
        created_at: new Date().toISOString(),
      };
      const task = { name, path: L.statePath(dir, name), state };
      L.saveState(task);
      const p = L.readPending(dir) || { at: new Date().toISOString() };
      Object.assign(p, { task: name, stop_blocks: 0, awaiting_user: false, contract_present: L.hasChecks(dir) });
      L.writePending(dir, p);
      ok(state);
      break;
    }
    case 'stage': {
      const t = requireTask(dir);
      const flow = FLOW[t.state.mode];
      if (!flow.includes(a1)) fail(`этап «${a1}» не входит в режим ${t.state.mode}: ${flow.join(' → ')}`);
      const from = flow.indexOf(t.state.stage);
      const to = flow.indexOf(a1);
      if (to < from) {
        fail(`назад нельзя: ${t.state.stage} → ${a1}. Неверный тест на этапе кода = остановка и объяснение ` +
          'в отчёте (incomplete). Возврат после ревью только через review-fail.');
      }
      if (a1 === 'report' && t.state.mode !== 'investigate' && t.state.stage !== 'review') {
        fail('к отчёту только после ревью (этап review); при остановке используй incomplete');
      }
      t.state.stage = a1;
      L.saveState(t);
      ok(t.state);
      break;
    }
    case 'escalate': {
      const t = requireTask(dir);
      if (!L.MODES.includes(a1)) fail('режим: ' + L.MODES.join('|'));
      if (MODE_RANK[a1] <= MODE_RANK[t.state.mode]) fail(`режим не опускается и не меняется вбок: ${t.state.mode} → ${a1}`);
      if (!a2) fail('нужна причина (какой триггер сработал)');
      t.state.mode = a1;
      t.state.mode_history.push({ mode: a1, at: new Date().toISOString(), reason: a2 });
      // continue at the earliest stage of the new mode that is not done yet
      t.state.stage = FLOW[a1][0];
      L.saveState(t);
      ok(t.state);
      break;
    }
    case 'ask': {
      // Works before `start` too (e.g. question about git init or an ambiguous object of change).
      const t = L.isGitRepo(dir) ? L.activeTask(dir) : null;
      const p = L.readPending(dir);
      if (p) {
        p.awaiting_user = true;
        L.writePending(dir, p);
      }
      if (t) {
        t.state.awaiting_user = true;
        L.saveState(t);
        ok(t.state);
      }
      ok({ awaiting_user: true, pending: !!p });
      break;
    }
    case 'review-fail': {
      const t = requireTask(dir);
      if (t.state.stage !== 'review') fail('review-fail только на этапе review');
      t.state.review_cycles += 1;
      if (a1) t.state.open_issues = [a1];
      if (t.state.review_cycles > L.LIMITS.reviewCycles) {
        t.state.status = 'incomplete';
        t.state.stage = 'report';
        t.state.incomplete_reason = `ревью вернуло работу больше ${L.LIMITS.reviewCycles} раз`;
      } else {
        // refactor: tests of current behaviour must not change -> back to code only
        t.state.stage = t.state.mode === 'refactor' ? 'code' : 'tests';
      }
      L.saveState(t);
      ok(t.state);
      break;
    }
    case 'incomplete': {
      const t = requireTask(dir);
      t.state.status = 'incomplete';
      t.state.stage = 'report';
      t.state.incomplete_reason = a1 || 'не указана';
      L.saveState(t);
      ok(t.state);
      break;
    }
    case 'done': {
      const t = requireTask(dir);
      const report = L.path.join(L.taskDir(dir, t.name), 'report.md');
      if (!L.exists(report)) fail('нет ' + report);
      if (t.state.status === 'in_progress') t.state.status = 'done';
      t.state.stage = 'done';
      L.saveState(t);
      L.clearPending(dir);
      ok(t.state);
      break;
    }
    case 'status':
      ok(requireTask(dir).state);
      break;
    case 'snapshot':
      ok(C.writeSnapshot(dir));
      break;
    case 'context':
      ok(C.contextBudget(dir));
      break;
    default:
      fail('команды: start|stage|escalate|ask|review-fail|incomplete|done|status|snapshot|context');
  }
}

main();
