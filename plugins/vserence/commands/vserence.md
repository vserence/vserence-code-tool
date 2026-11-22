---
description: Run the vserence pipeline on a task. Optional first word forces the mode - fix|feature|refactor|greenfield|investigate.
argument-hint: "[fix|feature|refactor|greenfield|investigate] <задача>"
disable-model-invocation: true
---

Запусти конвейер vserence по скиллу `vserence:router` для задачи ниже.

Аргументы: `$ARGUMENTS`

Если первое слово аргументов — одно из `fix`, `feature`, `refactor`, `greenfield`, `investigate`, это режим, заданный человеком явно: роутер не выбирает режим сам, но правила подъёма режима (fix → feature по триггерам) действуют. Остальной текст — задача. Если первого слова-режима нет, режим выбирает роутер.
