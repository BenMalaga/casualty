// End-to-end tests against real, programmatically-built git repos. Each test
// constructs a repo with a known merge outcome and asserts the CLI's verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureRepo } from './fixtures/build-repo.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'casualty.js');

function sh(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
}
function gitc(cwd, ...args) {
  return sh(cwd, 'git', '-c', 'user.name=ct', '-c', 'user.email=t@e.com', '-c', 'commit.gpgsign=false', ...args);
}
function write(repo, rel, content) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function casualty(cwd, ...args) {
  return sh(cwd, process.execPath, BIN, ...args);
}

test('detects a function dropped during a botched merge', (t) => {
  const fix = buildFixtureRepo();
  t.after(fix.cleanup);

  const out = casualty(fix.repo, `${fix.base}..HEAD`, '--json');
  const d = JSON.parse(out);

  assert.equal(d.mergesAnalyzed, 1);
  assert.equal(d.totalCasualties, 1);

  const merge = d.merges.find((m) => m.casualties.length);
  assert.ok(merge, 'a merge with casualties should be reported');
  const cas = merge.casualties[0];

  assert.equal(cas.path, 'app.js');
  // The lost content is the multiply function from the feature side, intact.
  assert.ok(cas.lostContent.some((l) => l.includes('export function multiply')));
  assert.ok(cas.lostContent.some((l) => l.includes('return a * b;')));
  assert.ok(cas.lostContent.some((l) => l.trim() === '}'));
  // It came from the second parent (the branch merged in) and is unambiguous:
  // the merge was clean, so a dropped contribution is a CLEAR drop.
  assert.equal(cas.side, 'p2');
  assert.equal(cas.confidence, 'clear');
  assert.equal(cas.fileConflicted, false);
  // The base content (VERSION line) must NOT be reported as lost.
  assert.ok(!cas.lostContent.some((l) => l.includes('VERSION')));
});

test('human output names the merge, the file:line, and the lost content', (t) => {
  const fix = buildFixtureRepo();
  t.after(fix.cleanup);

  const text = casualty(fix.repo, `${fix.base}..HEAD`, '--no-color');
  assert.match(text, /CLEAR DROP/);
  assert.match(text, /app\.js:/);
  assert.match(text, /export function multiply/);
  assert.match(text, /Summary: 1 casualty/);
});

test('--fail-on-clear exits 1 when a clear drop exists', (t) => {
  const fix = buildFixtureRepo();
  t.after(fix.cleanup);

  let code = 0;
  try {
    casualty(fix.repo, `${fix.base}..HEAD`, '--fail-on-clear', '--no-color');
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
});

test('a clean merge that keeps both sides reports no casualties', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-clean-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  gitc(repo, 'init', '-q', '-b', 'main');
  write(repo, 'f.txt', 'a\nb\nc\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  gitc(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'f.txt', 'a\nb\nc\nFEATURE\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'feat');
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'f.txt', 'MAIN\na\nb\nc\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'mainchange');
  gitc(repo, 'merge', '-q', '--no-edit', 'feature');

  const d = JSON.parse(casualty(repo, `${base}..HEAD`, '--json'));
  assert.equal(d.totalCasualties, 0);
});

test('a line dropped at merge but reintroduced later is not a casualty', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-reintro-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  gitc(repo, 'init', '-q', '-b', 'main');
  write(repo, 'f.txt', 'a\nb\nc\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  gitc(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'f.txt', 'a\nb\nc\nLATER_RESTORED\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'feat');
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'f.txt', 'a\nb-main\nc\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'mainchange');
  try {
    gitc(repo, 'merge', '--no-commit', '--no-ff', 'feature');
  } catch {}
  write(repo, 'f.txt', 'a\nb-main\nc\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'merge (dropped line)');
  const merge = gitc(repo, 'rev-parse', 'HEAD').trim();
  // later commit restores the line
  write(repo, 'f.txt', 'a\nb-main\nc\nLATER_RESTORED\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'restore the line');

  // Against the tip: reintroduced, so no casualty.
  const atTip = JSON.parse(casualty(repo, `${base}..HEAD`, '--json'));
  assert.equal(atTip.totalCasualties, 0);

  // Against the merge as tip: the line was not yet restored, so it is a casualty.
  const atMerge = JSON.parse(casualty(repo, `${base}..HEAD`, '--tip', merge, '--json'));
  assert.equal(atMerge.totalCasualties, 1);
});

test('a true conflict resolved by choosing one side is flagged ambiguous, not clear', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-conflict-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  gitc(repo, 'init', '-q', '-b', 'main');
  write(repo, 'f.txt', 'alpha\nVALUE=1\ngamma\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  gitc(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'f.txt', 'alpha\nVALUE=FEATURE\ngamma\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'feat');
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'f.txt', 'alpha\nVALUE=MAIN\ngamma\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'mainchange');
  try {
    gitc(repo, 'merge', '--no-commit', '--no-ff', 'feature');
  } catch {}
  write(repo, 'f.txt', 'alpha\nVALUE=MAIN\ngamma\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'merge chose main');

  const d = JSON.parse(casualty(repo, `${base}..HEAD`, '--json'));
  assert.equal(d.totalCasualties, 1);
  const cas = d.merges.find((m) => m.casualties.length).casualties[0];
  assert.equal(cas.confidence, 'ambiguous');
  assert.equal(cas.fileConflicted, true);

  // --fail-on-clear must NOT fail on a purely-ambiguous result.
  let code = 0;
  try {
    casualty(repo, `${base}..HEAD`, '--fail-on-clear', '--no-color');
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 0);
});

test('whitespace-only changes never become casualties', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-ws-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  gitc(repo, 'init', '-q', '-b', 'main');
  write(repo, 'f.txt', 'func() {\n  body\n}\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  gitc(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'f.txt', 'func() {\n    body\n}\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'reindent');
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'f.txt', 'func() {\n  body\n}\nEXTRA\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'mainadd');
  try {
    gitc(repo, 'merge', '--no-edit', 'feature');
  } catch {}
  write(repo, 'f.txt', 'func() {\n  body\n}\nEXTRA\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'merge', '--amend', '--no-edit');

  const d = JSON.parse(casualty(repo, `${base}..HEAD`, '--json'));
  assert.equal(d.totalCasualties, 0);
});

test('octopus merges are reported but not analyzed', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-octo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  gitc(repo, 'init', '-q', '-b', 'main');
  write(repo, 'f.txt', 'base\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();
  for (const b of ['b1', 'b2']) {
    gitc(repo, 'checkout', '-q', '-b', b, base);
    write(repo, `${b}.txt`, `${b}\n`);
    gitc(repo, 'add', '-A');
    gitc(repo, 'commit', '-q', '-m', b);
  }
  // Advance main with its own commit so the octopus merge cannot fast-forward
  // and collapse into a two-parent merge.
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'main.txt', 'main\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'main work');
  gitc(repo, 'merge', '-q', '--no-edit', 'b1', 'b2');

  const d = JSON.parse(casualty(repo, `${base}..HEAD`, '--json'));
  assert.equal(d.octopusSkipped, 1);
  const octo = d.merges.find((m) => m.kind === 'octopus');
  assert.ok(octo);
  assert.equal(octo.analyzed, false);
});

test('non-git directory and bad range exit 2', (t) => {
  const notRepo = mkdtempSync(join(tmpdir(), 'casualty-norepo-'));
  t.after(() => rmSync(notRepo, { recursive: true, force: true }));
  let code = 0;
  try {
    casualty(notRepo, 'HEAD~1..HEAD');
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2);
});
