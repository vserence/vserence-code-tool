#!/usr/bin/env node
'use strict';
// SessionStart: is there a contract, is it fresh, is the permanent context within budget,
// and (after compaction) which task is active. Adds an instruction to Claude's context.
const L = require('./lib.js');
const C = require('./contract.js');

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const source = input.source || 'startup';
  const lines = [];
  const state = L.path.join;

  if (!L.isGitRepo(dir)) {
    lines.push('vserence: папка не является git-репозиторием. Конвейеру нужна ветка vserence/<задача>: ' +
      'перед первой задачей спроси пользователя (условие 4 «нужны данные»), можно ли выполнить `git init` и первый коммит.');
  }

  const hasContract = L.exists(L.vserenceDir(dir)) && L.exists(state(L.vserenceDir(dir), 'checks.json'));
  if (!hasContract) {
    lines.push('vserence: контракта .vserence/ нет. ПЕРВЫЙ ШАГ перед первой задачей пользователя (не перед вопросом, ' +
      'начинающимся с «?»): вызови скилл vserence:onboarding и выполни его, затем продолжи исходную задачу.');
  } else {
    const reasons = C.staleness(dir);
    const budget = C.contextBudget(dir);
    if (budget.total > L.LIMITS.contextTokensMax) {
      reasons.push(`постоянный контекст ≈${budget.total} токенов > ${L.LIMITS.contextTokensMax} (` +
        budget.items.map((i) => `${i.label} ${i.tokens}`).join('; ') + ')');
    }
    if (reasons.length) {
      lines.push('vserence: контракт устарел — ' + reasons.join('; ') + '. ПЕРВЫЙ ШАГ перед первой задачей ' +
        '(не перед вопросом с «?»): вызови скилл vserence:sync и выполни его, затем продолжи задачу.');
    }
  }

  const task = L.isGitRepo(dir) ? L.activeTask(dir) : null;
  if (task && task.state.status === 'in_progress') {
    const s = task.state;
    const td = '.vserence/tasks/' + task.name + '/';
    if (source === 'compact' || source === 'resume') {
      lines.push(`vserence: продолжается задача «${task.name}» (режим ${s.mode}, этап ${s.stage}, ` +
        `циклы проверок ${s.check_cycles}/${L.LIMITS.checkCycles}, ревью ${s.review_cycles}/${L.LIMITS.reviewCycles}). ` +
        `Работай от файлов, а не от памяти диалога: прочитай ${td}state.json и, если есть, spec.md, plan.md, ` +
        `risks-analysis.md, review.md (открытые замечания). Продолжи с этапа ${s.stage}.`);
    } else {
      lines.push(`vserence: текущая ветка принадлежит незавершённой задаче «${task.name}» (этап ${s.stage}). ` +
        `Если пользователь пишет о ней, продолжай от файлов ${td}.`);
    }
  }

  if (lines.length === 0) return; // silent when everything is in order
  L.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence session-check: ' + e.message + '\n');
}
process.exit(0);
