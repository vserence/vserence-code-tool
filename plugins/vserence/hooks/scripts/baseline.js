'use strict';
// Baseline of the test suite: failures that existed before the task are not "red".
// Failures are parsed from standard vitest / jest / pytest / go test output; unknown format -> not compared.
const L = require('./lib.js');

// Strip ANSI colour codes.
function plain(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function parseFailures(output) {
  const text = plain(output);
  const failures = new Set();
  let recognized = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    // vitest:  FAIL  tests/a.test.ts > suite > name     jest:  FAIL tests/a.test.js
    if ((m = /^(?:[×✕✗]\s+)?FAIL\s+(\S.*?)\s*$/.exec(line)) && !/^FAIL\s+\S+\s+\d+(\.\d+)?s$/.test(line)) {
      failures.add(m[1].replace(/\s+\[.*\]$/, '').replace(/\s+\(\d+\s*(m?s|tests?).*\)$/, ''));
      recognized = true;
      continue;
    }
    // go:  --- FAIL: TestName (0.00s)       FAIL	example.com/pkg	0.01s
    if ((m = /^--- FAIL:\s+(\S+)/.exec(line))) { failures.add(m[1]); recognized = true; continue; }
    if ((m = /^FAIL\s+(\S+)\s+\d+(\.\d+)?s$/.exec(line))) { failures.add(m[1]); recognized = true; continue; }
    // pytest:  FAILED tests/test_x.py::test_y - AssertionError     ERROR tests/test_x.py::test_z
    if ((m = /^(?:FAILED|ERROR)\s+(\S+::\S+|\S+\.py)/.exec(line))) { failures.add(m[1]); recognized = true; continue; }
    // pass/summary markers: the format is known even when nothing failed
    if (/^(Test Files|Tests)\s+\d+/.test(line) || /^Tests:\s+\d+/.test(line) || /^=+ .*\b(passed|failed|error)s?\b.* in [\d.]+s/.test(line) ||
      /^ok\s+\S+\s+[\d.]+s/.test(line) || /^PASS\s+\S+/.test(line) || /^✓ /.test(line)) recognized = true;
  }
  return { recognized, failures: [...failures] };
}

function isKnown(failure, known) {
  return known.some((k) => k && (failure === k || failure.startsWith(k + ' ') || failure.startsWith(k + '::') ||
    failure.startsWith(k + ' >') || k.startsWith(failure + ' ') || k.startsWith(failure + '::')));
}

// Compare a red run with the baseline. Returns {compared, red, new_failures, preexisting, fixed, note}.
function compare(baseline, run, changedFiles = []) {
  const known = (baseline && Array.isArray(baseline.known_failures)) ? baseline.known_failures : null;
  if (run.ok) {
    const fixed = known ? known.filter((k) => changedFiles.some((f) => k === f || k.startsWith(f + ' ') || k.startsWith(f + '::'))) : [];
    return { compared: !!known, red: false, new_failures: [], preexisting: [], fixed, note: '' };
  }
  if (!known) return { compared: false, red: true, new_failures: [], preexisting: [], fixed: [], note: 'baseline в checks.json не записан' };
  const parsed = parseFailures(run.out);
  if (!parsed.recognized || parsed.failures.length === 0) {
    return { compared: false, red: true, new_failures: [], preexisting: [], fixed: [],
      note: 'формат вывода тестов не распознан: сравнение с baseline не выполнено, красное по коду выхода' };
  }
  const fresh = parsed.failures.filter((f) => !isKnown(f, known));
  const pre = parsed.failures.filter((f) => isKnown(f, known));
  const fixed = known.filter((k) => !parsed.failures.some((f) => isKnown(f, [k])) &&
    changedFiles.some((f) => k === f || k.startsWith(f + ' ') || k.startsWith(f + '::')));
  return { compared: true, red: fresh.length > 0, new_failures: fresh, preexisting: pre, fixed, note: '' };
}

function headCommit(dir) {
  return (L.git(dir, ['rev-parse', 'HEAD']) || '').trim() || null;
}

module.exports = { parseFailures, compare, headCommit };
