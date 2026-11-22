#!/usr/bin/env node
'use strict';
// UserPromptSubmit: a message that starts with "?" is a question, not a task: no pipeline.
// Otherwise tells Claude to run the vserence pipeline through the router skill.
const L = require('./lib.js');

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const prompt = String(input.prompt || '');
  const trimmed = prompt.trimStart();

  // Explicit slash commands carry their own instructions.
  if (trimmed.startsWith('/')) return;

  if (trimmed.startsWith('?')) {
    L.emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'vserence: сообщение начинается с «?» — это вопрос, а не задача. Ответь на вопрос без ' +
          'конвейера vserence: не создавай ветку и файлы задачи, не правь файлы проекта.',
      },
    });
    return;
  }

  const task = L.isGitRepo(dir) ? L.activeTask(dir) : null;
  if (task && task.state.status === 'in_progress' && task.state.awaiting_user) {
    task.state.awaiting_user = false;
    L.saveState(task);
    L.emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `vserence: это ответ на вопрос по задаче «${task.name}». Запиши ответ в ` +
          `.vserence/tasks/${task.name}/spec.md (раздел «Ответы на вопросы») и продолжи конвейер с этапа ` +
          `${task.state.stage} по скиллу vserence:router.`,
      },
    });
    return;
  }

  L.emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'vserence: это задача. Вызови скилл vserence:router и выполни конвейер по нему ' +
        '(режим первой строкой). Если в контексте есть инструкция об онбординге или синхронизации, сначала она.',
    },
  });
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence prompt-router: ' + e.message + '\n');
}
process.exit(0);
