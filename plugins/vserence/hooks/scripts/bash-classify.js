'use strict';
// Segment classifier for Bash commands before `start` (pre-task mode).
// A command is blocked only if at least one segment mutates files outside the paths allowed before start.
// Unknown commands are treated as mutating (fail-closed).
const L = require('./lib.js');

// ---- quote-aware scanning helpers ----
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let delim = null;
  for (const line of lines) {
    if (delim) {
      if (line.trim() === delim) delim = null;
      continue;
    }
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (m) delim = m[1];
    out.push(line.replace(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/, ' '));
  }
  return out.join('\n');
}

// Splits on ; && || | & newline and ( ) outside quotes. Drops fd duplications like 2>&1.
function segments(cmd) {
  const src = stripHeredocs(cmd);
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < src.length) cur += src[++i];
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      cur += c + src[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    // fd duplication: 2>&1, >&2, <&0
    const dup = /^\d*[<>]&\d/.exec(src.slice(i));
    if (dup) {
      cur += ' ';
      i += dup[0].length - 1;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') { // &> file == > file
      cur += '>';
      i++;
      if (src[i + 1] === '>') { cur += '>'; i++; }
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { // command substitution: its own segment
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if ('&|;\n()'.includes(c)) {
      segs.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && src[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

// Extracts unquoted output redirections; returns {rest, targets, append}.
function redirections(seg) {
  let rest = '';
  const targets = [];
  let q = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      rest += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      rest += c;
      continue;
    }
    if (c === '>') {
      // drop a leading fd number already copied into rest (e.g. "2>")
      rest = rest.replace(/\d$/, '');
      let j = i + 1;
      if (seg[j] === '>') j++;
      if (seg[j] === '|') j++;
      while (seg[j] === ' ' || seg[j] === '\t') j++;
      let t = '';
      let tq = null;
      while (j < seg.length) {
        const d = seg[j];
        if (tq) {
          if (d === tq) tq = null;
          else t += d;
          j++;
          continue;
        }
        if (d === '"' || d === "'") { tq = d; j++; continue; }
        if (/\s/.test(d)) break;
        t += d;
        j++;
      }
      targets.push(t);
      i = j - 1;
      rest += ' ';
      continue;
    }
    rest += c;
  }
  return { rest, targets };
}

function tokens(seg) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) ||
    ['time', 'command', 'nohup', 'env', 'nice', 'builtin'].includes(out[0]))) {
    out.shift();
    while (out.length && out[0].startsWith('-') && out[0] !== '-') out.shift(); // time -p, nice -n 5 (approx)
  }
  return out;
}

// ---- path policy ----
function expandPath(dir, p) {
  let s = String(p);
  if (s === '~' || s.startsWith('~/')) s = L.os.homedir() + s.slice(1);
  s = s.replace(/^\$\{?TMPDIR\}?/, L.os.tmpdir()).replace(/^\$\{?HOME\}?/, L.os.homedir());
  return L.path.resolve(dir, s);
}

function isTmpPath(dir, p) {
  if (/^(\/dev\/null|nul)$/i.test(p)) return true;
  const abs = expandPath(dir, p);
  if (L.isInside(dir, abs)) return false; // the project itself may live under a temp dir
  if (/^\$\{?TMPDIR\}?(\/|$)/.test(p)) return true;
  const roots = ['/tmp', '/private/tmp', '/var/tmp', L.os.tmpdir()].map((r) => L.path.resolve(r));
  return roots.some((r) => abs === r || abs.startsWith(r + L.path.sep)) || /^\/(private\/)?var\/folders\//.test(abs);
}

function isAllowedWritePath(dir, p) {
  if (isTmpPath(dir, p)) return true;
  const abs = expandPath(dir, p);
  if (!L.isInside(dir, abs)) return false;
  const rel = L.relToProject(dir, abs).replace(/\/$/, '');
  if (['.vserence', '.claude', '.claude/rules'].includes(rel)) return true;
  return L.isContractFile(dir, abs);
}

// ---- command policy ----
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo',
  'printf', 'true', 'false', 'test', '[', 'pwd', 'which', 'type', 'stat', 'file', 'du', 'df', 'diff', 'cmp', 'sort',
  'uniq', 'cut', 'tr', 'jq', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'cd', 'pushd', 'popd', 'exit',
  'less', 'more', 'column', 'nl', 'od', 'xxd', 'hexdump', 'sha1sum', 'sha256sum', 'shasum', 'md5sum', 'md5', 'uname',
  'whoami', 'hostname', 'id', 'ps', 'tree', 'comm', 'paste', 'fold', 'rev', 'seq', 'sleep', 'node --version']);
const READ_GIT = new Set(['status', 'log', 'diff', 'show', 'grep', 'blame', 'shortlog', 'fetch', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'describe', 'remote', 'reflog', 'check-ignore', 'merge-base', 'name-rev',
  'for-each-ref', 'show-ref', 'count-objects', 'version', 'help']);
const CHECK_SCRIPT = /^(lint|typecheck|type-check|types|tsc|check|test|tests|test:[\w:.-]+|lint:(?!fix)[\w:.-]+|typecheck:[\w:.-]+|vitest|jest)$/;
const CHECK_TOOLS = new Set(['vitest', 'jest', 'tsc', 'eslint', 'mocha', 'pytest', 'ruff', 'mypy', 'pyright',
  'prettier', 'biome', 'golangci-lint', 'flake8', 'pylint', 'rubocop']);
const FIX_FLAGS = /^(--fix|--fix-dry-run=false|--write|-w|--update|-u|--updateSnapshot|--update-snapshots|--in-place|--apply|--unsafe-fixes)$|^--fix=/;

function checkTool(toks) {
  // toks start at the tool name
  const tool = toks[0];
  if (!CHECK_TOOLS.has(tool)) return false;
  if (toks.some((t) => FIX_FLAGS.test(t))) return false;
  if (tool === 'tsc' && !toks.includes('--noEmit') && !toks.some((t) => /^--noEmit(=true)?$/.test(t))) return false;
  if (tool === 'prettier' && !toks.some((t) => t === '--check' || t === '-c' || t === '--list-different' || t === '-l')) return false;
  if ((tool === 'ruff' || tool === 'biome') && toks.includes('format') && !toks.includes('--check')) return false;
  return true;
}

function pkgManagerCheck(toks) {
  const pm = toks[0];
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return null;
  const args = toks.slice(1).filter((t) => !/^(--silent|-s|--quiet|-q|--if-present|--reporter=\S+)$/.test(t));
  if (args[0] === 'test' || args[0] === 't') return !args.some((t) => FIX_FLAGS.test(t));
  if (args[0] === 'run' || args[0] === 'run-script' || (pm !== 'npm' && args[0] && CHECK_SCRIPT.test(args[0]))) {
    const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0];
    if (!script || /fix|format|write/i.test(script) || !CHECK_SCRIPT.test(script)) return false;
    return !args.some((t) => FIX_FLAGS.test(t));
  }
  if (['exec', 'dlx', 'x'].includes(args[0])) return checkTool(args.slice(1).filter((t) => t !== '--'));
  if (['ls', 'list', 'view', 'info', 'outdated', 'why', 'audit'].includes(args[0]) && !args.includes('fix')) return true;
  if (args[0] === '--version' || args[0] === '-v') return true;
  return false;
}

function nonFlagArgs(toks) {
  return toks.slice(1).filter((t) => !t.startsWith('-'));
}

// Returns null if the segment is allowed before start, or a short description of the mutation.
function classifySegment(dir, seg, isProjectCheck) {
  const { rest, targets } = redirections(seg);
  for (const t of targets) {
    if (!t || !isAllowedWritePath(dir, t)) return `перенаправление в «${t || '?'}»`;
  }
  const toks = tokens(rest);
  if (!toks.length) return null;
  const restTrim = rest.trim();
  if (/vserence-state\.js/.test(restTrim)) return null;
  if (isProjectCheck(restTrim)) return null;
  let cmd = toks[0];
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') {
    const t = toks.slice(1).filter((x) => !/^(--yes|-y|--no-install|--no|-q|--quiet)$/.test(x));
    return checkTool(t) ? null : `npx ${t[0] || ''}`;
  }
  const pm = pkgManagerCheck(toks);
  if (pm === true) return null;
  if (pm === false) return toks.slice(0, 3).join(' ');
  if (cmd.includes('/') && CHECK_TOOLS.has(cmd.split('/').pop())) {
    return checkTool([cmd.split('/').pop(), ...toks.slice(1)]) ? null : cmd;
  }
  if (CHECK_TOOLS.has(cmd)) return checkTool(toks) ? null : toks.slice(0, 2).join(' ');
  if (cmd === 'go' && ['test', 'vet', 'version', 'list', 'env'].includes(toks[1])) return null;
  if (cmd === 'cargo' && ['test', 'check', 'clippy', 'metadata', '--version'].includes(toks[1]) && !toks.includes('--fix')) return null;
  if (cmd === 'node' && (toks[1] === '--version' || toks[1] === '-v')) return null;
  if (cmd === 'xargs') {
    const inner = toks.slice(1);
    while (inner.length && inner[0].startsWith('-')) inner.shift();
    return inner.length ? classifySegment(dir, inner.join(' '), isProjectCheck) : null;
  }
  if (cmd === 'git') {
    let i = 1;
    while (i < toks.length && toks[i].startsWith('-')) i += (toks[i] === '-C' || toks[i] === '-c') ? 2 : 1;
    const sub = toks[i];
    const args = toks.slice(i + 1);
    if (READ_GIT.has(sub)) return null;
    if (sub === 'branch' && !args.some((a) => /^-[a-zA-Z]*[dDmMcCf]|^--(delete|move|copy|force|set-upstream)/.test(a))) return null;
    if (sub === 'stash' && args[0] === 'list') return null;
    if ((sub === 'checkout' || sub === 'switch') && !args.includes('--') &&
      args.filter((a) => !a.startsWith('-')).length <= 1 &&
      !args.some((a) => !a.startsWith('-') && L.exists(L.path.resolve(dir, a)) &&
        !L.fs.statSync(L.path.resolve(dir, a)).isDirectory())) return null;
    if (sub === 'pull' && args.includes('--ff-only')) return null;
    return `git ${sub || ''}`.trim();
  }
  if (cmd === 'find') {
    if (toks.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(t))) return 'find с -delete/-exec';
    return null;
  }
  if (cmd === 'sed' || cmd === 'gsed') {
    if (toks.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t) && t !== '-n')) return 'sed -i';
    return null;
  }
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') {
    if (toks.some((t) => /inplace/.test(t))) return 'awk -i inplace';
    return null;
  }
  if (READ_ONLY.has(cmd)) return null;
  if (cmd === 'mkdir' || cmd === 'touch') {
    const bad = nonFlagArgs(toks).find((a) => !isAllowedWritePath(dir, a));
    return bad ? `${cmd} ${bad}` : null;
  }
  if (cmd === 'tee') {
    const bad = nonFlagArgs(toks).find((a) => !isAllowedWritePath(dir, a));
    return bad ? `tee ${bad}` : null;
  }
  if (cmd === 'cp' || cmd === 'install') {
    const args = nonFlagArgs(toks);
    const dest = args[args.length - 1];
    return args.length >= 2 && isAllowedWritePath(dir, dest) ? null : `${cmd} → ${dest || '?'}`;
  }
  if (cmd === 'mv') {
    const args = nonFlagArgs(toks);
    return args.length >= 2 && args.every((a) => isAllowedWritePath(dir, a)) ? null : `mv ${args.join(' ')}`;
  }
  if (cmd === 'rm') {
    const args = nonFlagArgs(toks);
    return args.length && args.every((a) => isTmpPath(dir, a)) ? null : `rm ${args.join(' ')}`;
  }
  return `неизвестная команда «${cmd}» (до start считается меняющей файлы)`;
}

function classify(dir, cmd, isProjectCheck) {
  if (isProjectCheck(cmd.trim())) return null;
  for (const seg of segments(cmd)) {
    const r = classifySegment(dir, seg, isProjectCheck);
    if (r) return r;
  }
  return null;
}

module.exports = { classify, segments, redirections, isAllowedWritePath };
