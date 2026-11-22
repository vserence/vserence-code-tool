'use strict';
// Pre-start Bash classification: real commands from the second live run must pass; mutations must not.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers.js');

const PLUGIN = h.path.resolve(__dirname, '..', 'plugins', 'vserence');
const prompt = (dir) => h.runScript('prompt-router.js', { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'Исправь шахматку' }, dir);
const bash = (dir, command) => h.preTool(dir, 'Bash', { command });

function allowed(contract) {
  return (dir) => [
    'git status --short && git rev-parse HEAD && git fetch origin 2>&1 | tail -2; git rev-list --left-right --count HEAD...origin/main; ls; ls .vserence 2>&1; ls /Users/maria/.claude/plugins/cache/vserence-code-tool/vserence/0.2.0/templates/; cat package.json | head -40',
    "(time npm run lint --silent >/tmp/x 2>&1; echo lint=$?) 2>&1 | tail -4; tail -5 /tmp/x; (time npm run typecheck --silent 2>&1 | tail -5; ) 2>&1 | tail -8; ls node_modules/.bin | grep -iE 'prettier|stryker'",
    `mkdir -p ${dir}/.vserence/decisions && cp ${PLUGIN}/templates/.vserence/decisions/README.md ${dir}/.vserence/decisions/README.md && ls ${dir}/.vserence`,
    "printf '\\n# local agent files\\nCLAUDE.local.md\\n.claude/settings.local.json\\n' >> .gitignore && tail -3 .gitignore",
    'sed -n 55,85p docs/tz/2026-11-18-chessboard-multi-source.md; ls tests/fixtures/feeds/; grep -c "<flat>" tests/fixtures/feeds/rzv-tamerun.xml',
    'npx vitest run tests/app.test.js 2>&1 | tail -20',
    'npx tsc --noEmit -p . > $TMPDIR/tsc.log 2>&1; echo $?',
    'npx eslint src > /dev/null',
    "cat > .vserence/conventions.md <<'EOF'\n# Конвенции\n> цитата\nrm -rf src\nEOF",
    ...(contract ? [] : ['npm test', 'npm run test -- --run']),
  ];
}

const BLOCKED = [
  "sed -i 's/a/b/' src/app.js",
  'echo x > src/a.ts',
  'cp a src/',
  'npx eslint --fix src',
  'find . -name "*.orig" -delete',
  'rm src/app.js',
  'git checkout -- src/app.js',
  'git stash',
  'npm install',
  'npm run format',
  'python3 scripts/regen.py',
  'ls; tee src/out.txt < /dev/null',
];

for (const contract of [false, true]) {
  test(`bash before start (${contract ? 'with' : 'without'} contract): live-run commands are allowed`, () => {
    const dir = h.makeProject({ contract });
    prompt(dir);
    for (const c of allowed(contract)(dir)) {
      const r = bash(dir, c);
      assert.ok(!h.isDenied(r), 'should allow: ' + c + '\n' + (r.json ? r.json.hookSpecificOutput.permissionDecisionReason : ''));
    }
  });

  test(`bash before start (${contract ? 'with' : 'without'} contract): mutations are blocked`, () => {
    const dir = h.makeProject({ contract });
    prompt(dir);
    for (const c of BLOCKED) assert.ok(h.isDenied(bash(dir, c)), 'should block: ' + c);
  });
}
