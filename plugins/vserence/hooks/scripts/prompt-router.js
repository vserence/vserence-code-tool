#!/usr/bin/env node
'use strict';
// UserPromptSubmit: a message that starts with "?" is a question, not a task: no pipeline.
// Every task message writes a pending flag (git dir, or tmpdir without git). While the flag is set and
// no task is in progress, test-guard blocks code edits and stop-gate blocks stopping: fail-closed.
const crypto = require('node:crypto');
const L = require('./lib.js');

// Slash commands of this plugin that start the pipeline.
const PIPELINE_COMMANDS = /^\/vserence(:vserence|:postmortem)?(\s|$)/;

function ctx(text) {
  L.emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const prompt = String(input.prompt || '');
  const trimmed = prompt.trimStart();

  if (trimmed.startsWith('?')) {
    const p = L.readPending(dir);
    if (p) {
      p.question_turn = true;
      L.writePending(dir, p);
    }
    ctx('vserence: сообщение начинается с «?» — это вопрос, а не задача. Ответь на вопрос без ' +
      'конвейера vserence: не создавай ветку и файлы задачи, не правь файлы проекта.');
    return;
  }

  // Other slash commands carry their own instructions.
  if (trimmed.startsWith('/') && !PIPELINE_COMMANDS.test(trimmed)) return;

  const git = L.isGitRepo(dir);
  const task = git ? L.activeTask(dir) : null;
  if (task && task.state.status === 'in_progress' && task.state.awaiting_user) {
    task.state.awaiting_user = false;
    L.saveState(task);
    const p = L.readPending(dir) || { at: new Date().toISOString(), contract_present: L.hasChecks(dir) };
    p.question_turn = false;
    p.awaiting_user = false;
    p.stop_blocks = 0;
    L.writePending(dir, p);
    ctx(`vserence: это ответ на вопрос по задаче «${task.name}». Запиши ответ в ` +
      `.vserence/tasks/${task.name}/spec.md (раздел «Ответы на вопросы») и продолжи конвейер с этапа ` +
      `${task.state.stage} по скиллу vserence:router.`);
    return;
  }

  const contract = L.hasChecks(dir);
  L.writePending(dir, {
    prompt_hash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    at: new Date().toISOString(),
    contract_present: contract,
    stop_blocks: 0,
    question_turn: false,
    awaiting_user: false,
  });

  const steps = [];
  if (!contract) steps.push('онбординг (скилл vserence:onboarding) — контракта .vserence/checks.json нет');
  steps.push('скилл vserence:router: режим первой строкой, затем `node "' + L.STATE_SCRIPT + '" start <имя> <режим>`');
  steps.push('все этапы режима, ревью (кроме investigate) и отчёт .vserence/tasks/<имя>/report.md');
  ctx('vserence: это задача. Обязательно и по порядку: ' + steps.map((s, i) => `(${i + 1}) ${s}`).join('; ') +
    '. До `start` хуки блокируют правки кода и остановку; размер задачи не отменяет этапы. ' +
    'superpowers:brainstorming не вызывай.');
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence prompt-router: ' + e.message + '\n');
}
process.exit(0);
