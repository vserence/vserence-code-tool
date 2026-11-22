#!/usr/bin/env node
'use strict';
// PreToolUse: blocks (1) edits of tests while they are frozen, (2) secret files,
// (3) dangerous commands from "Определения и пороги", (4) direct edits of task state,
// (5) writes outside the role of read-only subagents. Explains the reason to Claude.
const L = require('./lib.js');

const FROZEN_STAGES = ['code', 'verify', 'review', 'report'];
const MAIN_BRANCHES = ['main', 'master', 'trunk'];
const READ_ONLY_CMDS = new Set(['grep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail', 'echo',
  'printf', 'ls', 'find', 'wc', 'type', 'which', 'man', 'cd', 'pushd', 'popd', 'mkdir', 'test']);
const READ_ONLY_GIT = new Set(['log', 'show', 'diff', 'grep', 'blame', 'status', 'shortlog']);

function deny(reason) {
  L.emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'vserence: ' + reason,
    },
  });
  process.exit(0);
}

function role(input) {
  const a = String(input.agent_type || '');
  if (!a) return 'main';
  const last = a.split(':').pop();
  if (['reviewer', 'risk-analyst', 'explorer'].includes(last)) return last;
  return 'subagent';
}

// ---- shell parsing (approximate, shell-agnostic) ----
function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '&') {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  // drop env assignments and sudo/command prefixes
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || ['sudo', 'command', 'exec', 'env', 'nohup', 'time'].includes(out[0]))) out.shift();
  return out;
}

function resolveTarget(dir, t) {
  let p = t;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = L.os.homedir() + p.slice(1);
  if (/^\$HOME\b|^\$\{HOME\}|^%USERPROFILE%/i.test(p)) p = L.os.homedir() + p.replace(/^\$HOME|^\$\{HOME\}|^%USERPROFILE%/i, '');
  if (/[$`%]/.test(p)) return null; // cannot resolve variables: treat as outside
  return L.path.resolve(dir, p.replace(/[*?]+.*$/, '') || '.');
}

function rmOutside(dir, toks) {
  const cmd = (toks[0] || '').toLowerCase();
  let recursive = false;
  let force = false;
  const targets = [];
  if (cmd === 'rm') {
    for (const t of toks.slice(1)) {
      if (t === '--recursive') recursive = true;
      else if (t === '--force') force = true;
      else if (/^-[a-zA-Z]+$/.test(t)) {
        if (/[rR]/.test(t)) recursive = true;
        if (/f/.test(t)) force = true;
      } else if (t !== '--') targets.push(t);
    }
  } else if (cmd === 'remove-item' || cmd === 'ri') {
    for (const t of toks.slice(1)) {
      if (/^-recurse$/i.test(t)) recursive = true;
      else if (/^-force$/i.test(t)) force = true;
      else if (!t.startsWith('-')) targets.push(t);
    }
  } else if (cmd === 'rd' || cmd === 'rmdir') {
    for (const t of toks.slice(1)) {
      if (/^\/s$/i.test(t)) recursive = true;
      else if (/^\/q$/i.test(t)) force = true;
      else if (!t.startsWith('/') || L.path.isAbsolute(t)) targets.push(t);
    }
  } else {
    return null;
  }
  if (!recursive || !force) return null;
  for (const t of targets) {
    const abs = resolveTarget(dir, t);
    if (abs == null) return `rm -rf с непроверяемым путём «${t}» (переменная)`;
    if (!L.isInside(dir, abs) || L.path.resolve(abs) === L.path.resolve(dir)) {
      return `rm -rf вне папки проекта или всей папки проекта: «${t}»`;
    }
  }
  return null;
}

function gitCheck(dir, toks, mainNames) {
  if (toks[0] !== 'git') return null;
  // skip global options like -C path, -c k=v
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) i += (toks[i] === '-C' || toks[i] === '-c') ? 2 : 1;
  const sub = toks[i];
  const args = toks.slice(i + 1);
  if (sub === 'push') {
    if (args.some((a) => ['--force', '-f', '--force-with-lease', '--force-if-includes'].includes(a) ||
      a.startsWith('--force-with-lease=') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) return 'git push --force';
    const refs = args.filter((a) => !a.startsWith('-'));
    if (refs.slice(1).some((r) => r.startsWith('+'))) return 'git push --force (refspec с «+»)';
    if (args.includes('--delete') || args.includes('-d') || refs.slice(1).some((r) => r.startsWith(':'))) return 'удаление ветки на удалённом репозитории';
    for (const r of refs.slice(1)) {
      const dst = r.includes(':') ? r.split(':').pop() : r;
      if (mainNames.includes(dst.replace(/^refs\/heads\//, ''))) return `push в основную ветку ${dst}`;
    }
    if (args.includes('--all') || args.includes('--mirror')) return 'git push --all/--mirror затрагивает основную ветку';
    if (refs.length <= 1) {
      const br = L.currentBranch(dir);
      if (br && mainNames.includes(br)) return `push с основной ветки ${br}`;
    }
  }
  if (sub === 'reset' && args.includes('--hard')) return 'git reset --hard';
  if (sub === 'branch' && args.some((a) => ['-d', '-D', '--delete'].includes(a) || /^-[a-zA-Z]*[dD]/.test(a))) return 'удаление ветки';
  if (sub === 'merge' && !args.includes('--abort')) {
    const br = L.currentBranch(dir);
    if (br && mainNames.includes(br)) return `мерж в основную ветку ${br}`;
  }
  return null;
}

function mergeAfterCheckout(segments, mainNames) {
  let onMain = false;
  for (const seg of segments) {
    const t = tokenize(seg);
    if (t[0] === 'git' && ['checkout', 'switch'].includes(t[1]) && mainNames.includes(t[t.length - 1])) onMain = true;
    if (t[0] === 'git' && t[1] === 'merge' && onMain) return 'мерж в основную ветку';
  }
  return null;
}

const PUBLISH = [
  /\b(npm|yarn|pnpm|bun)\s+publish\b/i, /\btwine\s+upload\b/i, /\bpoetry\s+publish\b/i, /\bflit\s+publish\b/i,
  /\bhatch\s+publish\b/i, /\buv\s+publish\b/i, /\bcargo\s+publish\b/i, /\bgem\s+push\b/i, /\bmvn\b.*\bdeploy\b/i,
  /\bgradlew?\b.*\bpublish\w*\b/i, /\bdotnet\s+nuget\s+push\b/i, /\bnuget\s+push\b/i, /\bdocker\s+push\b/i,
  /\bpodman\s+push\b/i, /\bgh\s+release\s+create\b/i, /\bvsce\s+publish\b/i, /\bpub\s+publish\b/i,
  /\bpod\s+trunk\s+push\b/i, /\bchangeset\s+publish\b/i,
];
const DEPLOY = [
  /\bkubectl\b.*\b(apply|create|delete|replace|patch|rollout|scale|set|edit|drain)\b/i,
  /\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b/i, /\b(terraform|tofu)\s+(apply|destroy|import)\b/i,
  /\bpulumi\s+(up|destroy)\b/i, /\bgit\s+push\s+(heroku|dokku)\b/i, /\bvercel\b(?!\s+(dev|login|whoami|env\s+pull))/i,
  /\bansible-playbook\b/i, /\bwrangler\s+(deploy|publish)\b/i, /\bflyctl?\s+deploy\b/i, /\bheroku\s+(releases|ps:scale|run)\b/i,
];
const PROD = [
  /\b[A-Z_]*(ENV|ENVIRONMENT|STAGE|PROFILE)\s*=\s*["']?prod(uction)?\b/i,
  /--(env|environment|stage|profile|context|target)[=\s]+["']?\S*prod(uction)?\b/i,
  /(^|\s)-e\s+prod(uction)?\b/i, /\s--prod(uction)?\b/i, /@prod(uction)?\b/i,
];

function sqlCheck(cmd) {
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLUMN|USER|ROLE|TRIGGER|FUNCTION|PROCEDURE|SEQUENCE|TYPE|EXTENSION|COLLECTION|KEYSPACE)\b/i.test(cmd)) return 'DROP';
  if (/\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\bFLUSHALL\b|\bFLUSHDB\b/i.test(cmd)) return 'удаление всех данных (drop/flush)';
  for (const seg of splitSegments(cmd)) {
    const t = tokenize(seg);
    if ((t[0] || '').toLowerCase() === 'truncate') continue; // coreutils truncate -s, a file utility
    if (/\bTRUNCATE\s+(TABLE\s+)?[\w"`[]/i.test(seg)) return 'TRUNCATE';
  }
  const re = /\bDELETE\s+FROM\s+([^;"']*)/gi;
  let m;
  while ((m = re.exec(cmd))) if (!/\bWHERE\b/i.test(m[1])) return 'DELETE без условия WHERE';
  if (/\bdeleteMany\s*\(\s*\{\s*\}\s*\)|\bremove\s*\(\s*\{\s*\}\s*\)/.test(cmd)) return 'DELETE без условия (deleteMany({}))';
  return null;
}

// Exact commands from checks.json (e.g. build with NODE_ENV=production) are the project's own checks.
function isProjectCheck(dir, cmd) {
  const checks = L.loadChecks(dir);
  if (!checks) return false;
  const src = checks.commands || checks;
  return Object.values(src).some((v) => v && (v === cmd.trim() || v.run === cmd.trim() || v.quiet === cmd.trim()));
}

function dangerous(dir, cmd, state) {
  if (/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|iex|Invoke-Expression|python3?|node|perl|ruby)\b/i.test(cmd) ||
    /\b(sh|bash|zsh)\s+(-c\s+)?["']?(\$\(|<\()\s*(curl|wget)\b/i.test(cmd)) return 'curl … | sh (выполнение скачанного скрипта)';
  const sql = sqlCheck(cmd);
  if (sql) return sql;
  const prodHosts = L.markdownSection(L.conventions(dir), /^продакшен$/i);
  if (prodHosts.some((h) => h && cmd.includes(h))) return 'команда против продакшен-окружения';
  if (!isProjectCheck(dir, cmd) && PROD.some((r) => r.test(cmd))) return 'команда против продакшен-окружения';
  if (PUBLISH.some((r) => r.test(cmd))) return 'публикация пакета или образа';
  if (/\b(gh\s+pr\s+merge|glab\s+mr\s+merge)\b/i.test(cmd)) return 'мерж PR/MR в основную ветку';
  const mainNames = MAIN_BRANCHES.concat(state && state.base_branch ? [state.base_branch] : []);
  const segments = splitSegments(cmd);
  const m2 = mergeAfterCheckout(segments, mainNames);
  if (m2) return m2;
  for (const seg of segments) {
    const toks = tokenize(seg);
    if (!toks.length) continue;
    const rm = rmOutside(dir, toks);
    if (rm) return rm;
    const g = gitCheck(dir, toks, mainNames);
    if (g) return g;
    const first = toks[0].toLowerCase();
    const readOnly = READ_ONLY_CMDS.has(first) || (first === 'git' && READ_ONLY_GIT.has(toks[1]));
    if (!readOnly) {
      if (toks.some((t) => /^deploy(:\S*)?$/i.test(t)) || DEPLOY.some((r) => r.test(seg))) return 'деплой';
    }
  }
  return null;
}

function secretInCommand(dir, cmd) {
  for (const seg of splitSegments(cmd)) {
    for (const t of tokenize(seg)) {
      const clean = t.replace(/^[<>]+/, '').replace(/[,;)]+$/, '');
      if (!clean || clean.startsWith('-')) continue;
      if (/[*?]/.test(clean) && !/\.env|\.pem|\.key|\.p12|id_rsa|credentials/i.test(clean)) continue;
      if (L.isSecretPath(dir, L.path.resolve(dir, clean.replace(/\*/g, 'x')))) return clean;
    }
  }
  return null;
}

function gitAddSecrets(dir, cmd) {
  const secretsIn = (list) => list.filter(Boolean).filter((f) => L.isSecretPath(dir, L.path.join(dir, f)));
  for (const t of splitSegments(cmd).map(tokenize)) {
    if (t[0] !== 'git') continue;
    const args = t.slice(2);
    if (t[1] === 'add') {
      const all = args.some((a) => ['-A', '--all', '.', '*', ':/'].includes(a)) || args.filter((a) => !a.startsWith('-')).length === 0;
      if (all) {
        const s = secretsIn((L.git(dir, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/)
          .concat((L.git(dir, ['diff', '--name-only']) || '').split(/\r?\n/)));
        if (s.length) return s.join(', ');
      }
    }
    if (t[1] === 'commit' && args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) {
      const s = secretsIn((L.git(dir, ['diff', '--name-only']) || '').split(/\r?\n/));
      if (s.length) return s.join(', ');
    }
  }
  return null;
}

const WRITE_OPS = /(^|\s)(sed\s+(-[a-zA-Z]*\s+)*-i|perl\s+-[a-zA-Z]*i|rm|mv|cp|tee|truncate|dd|git\s+(rm|mv|checkout|restore|stash)|Set-Content|Out-File|Remove-Item|Move-Item|Copy-Item)\b|>{1,2}/;

function bashTouchesTests(dir, cmd) {
  if (!WRITE_OPS.test(cmd)) return null;
  for (const seg of splitSegments(cmd)) {
    if (!WRITE_OPS.test(seg)) continue;
    for (const t of tokenize(seg)) {
      const clean = t.replace(/^[<>]+/, '');
      if (!clean || clean.startsWith('-')) continue;
      if (L.isTestPath(dir, L.path.resolve(dir, clean))) return clean;
    }
  }
  return null;
}

function fileOf(ti) {
  return ti.file_path || ti.notebook_path || ti.path || null;
}

function main() {
  const input = L.parseInput();
  const dir = L.projectDir(input);
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const who = role(input);
  const task = L.isGitRepo(dir) ? L.activeTask(dir) : null;
  const st = task && task.state.status === 'in_progress' ? task.state : null;
  const taskRel = task ? '.vserence/tasks/' + task.name + '/' : null;

  if (tool === 'Read') {
    const f = fileOf(ti);
    if (f && L.isSecretPath(dir, f)) deny(`чтение файла секретов «${L.relToProject(dir, f)}» запрещено: его содержимое не должно попасть в отчёт, коммиты и логи.`);
    if (f && st && (who === 'main' || who === 'subagent') &&
      L.relToProject(dir, f).startsWith(taskRel + 'acceptance/')) {
      deny('скрытые приёмочные тесты принадлежат ревьюеру: исполнитель их не читает.');
    }
    return;
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const f = fileOf(ti);
    if (!f) return;
    const abs = L.path.isAbsolute(f) ? f : L.path.join(dir, f);
    const rel = L.relToProject(dir, abs);
    if (L.isSecretPath(dir, abs)) deny(`правка файла секретов «${rel}» запрещена (список «Файлы секретов»). Укажи в отчёте, что и где нужно поменять человеку.`);
    if (/^\.vserence\/tasks\/[^/]+\/state\.json$/.test(rel)) deny('state.json меняется только скриптом: node "' + L.STATE_SCRIPT + '" <команда>.');
    if (who === 'explorer') deny('explorer только читает.');
    if (!st) return;
    const inTask = rel.startsWith(taskRel);
    const inAcceptance = rel.startsWith(taskRel + 'acceptance/');
    if (who === 'risk-analyst') {
      if (!inTask) deny(`risk-analyst пишет только в ${taskRel}.`);
      return;
    }
    if (who === 'reviewer') {
      if (inAcceptance || rel === taskRel + 'review.md') return;
      if (L.isTestPath(dir, abs)) deny('ревьюер не меняет тесты исполнителя; скрытые приёмочные тесты пиши в ' + taskRel + 'acceptance/.');
      if (rel.startsWith('.vserence/')) deny('ревьюер не меняет контракт и файлы задачи, кроме acceptance/ и review.md.');
      if (st.stage !== 'review') deny('намеренные поломки разрешены только на этапе review.');
      return; // intentional breakage of production code, must be rolled back
    }
    if (inAcceptance) deny('скрытые приёмочные тесты принадлежат ревьюеру: исполнитель их не читает и не меняет.');
    if (st.mode === 'investigate' && !inTask) deny('режим investigate: правки кода запрещены. Пиши выводы в ' + taskRel + '.');
    if (['spec', 'plan'].includes(st.stage) && !rel.startsWith('.vserence/') &&
      !['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.gitignore'].includes(rel) && !rel.startsWith('.claude/')) {
      deny(`этап ${st.stage}: код пишется после спецификации и плана. Сначала заверши ${taskRel}${st.stage}.md и перейди к этапу tests.`);
    }
    if (FROZEN_STAGES.includes(st.stage) && L.isTestPath(dir, abs)) {
      deny(`тесты заморожены на этапе ${st.stage}: «${rel}». Если тест неверный — остановись: ` +
        `node "${L.STATE_SCRIPT}" incomplete "<почему тест неверный>" и объясни это в отчёте.`);
    }
    return;
  }

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    if (!cmd.trim()) return;
    const d = dangerous(dir, cmd, st);
    if (d) deny(`опасная команда (${d}) заблокирована. Такие действия выполняет человек; опиши в отчёте, что нужно сделать.`);
    const s = secretInCommand(dir, cmd);
    if (s) deny(`команда обращается к файлу секретов «${s}». Содержимое секретов не должно попадать в вывод, отчёт и коммиты. Для .gitignore используй Edit.`);
    const ga = gitAddSecrets(dir, cmd);
    if (ga) deny(`git add/commit захватит файлы секретов: ${ga}. Добавь их в .gitignore или добавляй файлы поимённо.`);
    if (/state\.json/.test(cmd) && !/vserence-state\.js/.test(cmd) && !/^\s*(cat|type|git\s+(diff|show|log))\b/.test(cmd)) {
      deny('state.json меняется только скриптом: node "' + L.STATE_SCRIPT + '" <команда>.');
    }
    if (st && who !== 'reviewer' && FROZEN_STAGES.includes(st.stage)) {
      const t = bashTouchesTests(dir, cmd);
      if (t) deny(`тесты заморожены на этапе ${st.stage}: команда меняет «${t}».`);
    }
    if (st && who === 'main' && /\.vserence\/tasks\/[^/\s]+\/acceptance/.test(cmd)) {
      deny('скрытые приёмочные тесты принадлежат ревьюеру.');
    }
  }
}

try {
  main();
} catch (e) {
  process.stderr.write('vserence test-guard: ' + e.message + '\n');
}
process.exit(0);
