---
description: Sync the vserence contract with changed manifests, CI, top-level folders, contract version or context budget. Runs automatically when stale.
---

Выполни синхронизацию контракта по скиллу `vserence:onboarding`, режим «синхронизация»: обнови только изменившееся (причины перечислил SessionStart-хук; если их нет в контексте, выясни сам: `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/vserence-state.js" context` и сравнение с `.vserence/sync-state.json`). $ARGUMENTS
