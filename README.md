# vserence-code-tool

Плагин Claude Code `vserence` и маркетплейс, из которого он ставится вместе с готовыми плагинами (Superpowers, code-review, security-guidance, frontend-design). Задача, написанная обычным текстом, превращается в результат в отдельной ветке `vserence/<задача>` и отчёт: что изменилось, как проверено, что не проверено.

## Установка (две команды, уровень User)

```
/plugin marketplace add vserence/vserence-code-tool
/plugin install vserence@vserence-code-tool
```

Из терминала то же самое: `claude plugin marketplace add vserence/vserence-code-tool` и `claude plugin install vserence@vserence-code-tool`. Плагин объявляет зависимости `superpowers`, `code-review`, `security-guidance`, `frontend-design`; они ставятся автоматически из этого же маркетплейса.

Обновление сборки: push в этот репозиторий → `/plugin marketplace update vserence-code-tool`. SessionStart-хук сравнит версию контракта проекта с версией формата плагина и попросит синхронизацию.

**Требование:** `node` (Node.js 18+, проверено на v22) в `PATH`. Все хуки — скрипты Node.js без внешних пакетов и без системных утилит (bash, jq, grep не нужны), работают на macOS, Linux и Windows. Нужен `git`.

## Что делает сборка

1. **Подготовка.** SessionStart-хук проверяет: есть ли `.vserence/`; версию контракта; изменились ли с прошлой синхронизации манифесты зависимостей, CI, список папок первого уровня; размер постоянного контекста (порог 8000 токенов). Нужное → Claude первым шагом делает онбординг или синхронизацию.
2. **Разбор задачи.** UserPromptSubmit-хук: сообщение с `?` в начале — вопрос, конвейер не запускается; иначе скилл `vserence:router` выбирает режим (fix, feature, refactor, greenfield, investigate) и задаёт вопрос только по пяти условиям.
3. **Процесс режима** в ветке `vserence/<задача>`. Мерж в основную ветку и деплой делает человек.
4. **Проверки.** PostToolUse: format и lint из `checks.json` после каждой правки (тихо). PreToolUse (`test-guard`): заморозка тестов на этапе кода, файлы секретов, опасные команды. Stop: lint, typecheck, test_changed и защита diff (skip/only/xfail, удалённые тесты, ослабленные проверки, ветки «если тестовое окружение»); до 5 возвратов.
5. **Ревью.** Сабагент `vserence:reviewer` с чистым контекстом: скрытые приёмочные тесты, намеренные поломки, чеклисты стандартов. До 2 возвратов.
6. **Отчёт** `.vserence/tasks/<задача>/report.md` по фиксированному шаблону.

Ручные входы (не обязательны): `/vserence:vserence [режим] <задача>`, `/vserence:init`, `/vserence:sync`, `/vserence:postmortem <баг>`.

## Структура

```
.claude-plugin/marketplace.json     наш плагин + внешние плагины
plugins/vserence/
  .claude-plugin/plugin.json        v0.1.0
  commands/   vserence.md, init.md, sync.md, postmortem.md
  agents/     explorer.md (haiku), risk-analyst.md (opus), reviewer.md (opus; sonnet в fix)
  skills/     router, onboarding, report, architecture-principles, testing-standards,
              standards-backend, standards-database, standards-api, standards-security,
              standards-ui, risk-catalog (9 доменов)
  hooks/      hooks.json + scripts/ (session-check, prompt-router, post-edit, test-guard,
              stop-gate, vserence-state, lib, contract)
  templates/  AGENTS.md, CLAUDE.md, CLAUDE.local.md, .claude/settings.json,
              .claude/settings.local.json, .vserence/*, report.md
tests/        тесты хуков: npm test  (= node --test "tests/*.test.js")
```

## TODO перед первым распространением

- [ ] **Закрепить коммиты внешних плагинов.** В `.claude-plugin/marketplace.json` у `superpowers`, `code-review`, `security-guidance`, `frontend-design` стоит `metadata.pin_commit_sha: "PIN_COMMIT_SHA"`. Формат требует в `source.sha` полный 40-символьный SHA в нижнем регистре, поэтому плейсхолдер вынесен в `metadata` (иначе `claude plugin validate` падает). После просмотра хуков каждого плагина впиши SHA в `source.sha` и удали `metadata.pin_commit_sha`. Пока SHA не вписан, ставится последний коммит ветки по умолчанию.
- [x] Репозиторий: github.com/vserence/vserence-code-tool.

## Известные ограничения

- Хук не вызывает команды Claude сам: он добавляет инструкцию в контекст, и Claude выполняет её первым шагом. Если модель проигнорирует инструкцию, онбординг не запустится; Stop-ворота при этом всё равно не дадут закончить активную задачу с красными проверками.
- Ручной вход называется `/vserence:vserence`: имена команд плагина всегда с префиксом `<плагин>:`. Сработает ли короткая форма `/vserence fix …`, не проверено.
- Распознавание опасных команд, тестовых файлов и веток «если тестовое окружение» — по шаблонам (регулярные выражения). Команду, собранную через переменные или скрипт-обёртку, хук может не распознать. Есть ложные срабатывания: например, `NODE_ENV=production …` блокируется как команда против продакшена (кроме команд, записанных в `checks.json`), а любая команда со словом `deploy` (`npx prisma migrate deploy`) блокируется как деплой.
- Если скрипт хука упадёт с внутренней ошибкой, он пропускает действие (fail-open) и пишет ошибку в stderr. Так ошибка в хуке не блокирует работу.
- «Скрытость» приёмочных тестов обеспечена порядком действий ревьюера и запретом исполнителю читать `.vserence/tasks/<задача>/acceptance/` через Read. Чтение через Grep/Glob не блокируется.
- Модель главной сессии не переключается автоматически: «fix целиком на Sonnet» выполняется для сабагентов (ревьюер, исполнители по плану); основная сессия работает на модели, выбранной человеком.
- Порог сжатия 60% задаётся через `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` в шаблоне `.claude/settings.json` проекта: переменная может только понизить порог, но не повысить его.
- Бюджет постоянного контекста в SessionStart-хуке считается приблизительно (символы/4 для латиницы, символы/2.5 для кириллицы). Схемы MCP и описания скиллов чужих плагинов в него не входят.
- security-guidance (Anthropic) запускает свои хуки через `bash` и Python, на Windows без Git Bash они не работают; его Stop-хук делает LLM-ревью diff, это стоит токенов.
- Superpowers на SessionStart добавляет в контекст скилл `using-superpowers` (около 3.2 КБ). Этот скилл требует brainstorming перед работой; роутер явно это отменяет, как требует спецификация.
