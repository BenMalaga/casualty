// Builds a temp git repo with a known, deliberately botched merge: a feature
// branch adds a function, main edits a nearby line, and the recorded merge
// resolves by dropping the feature's function. That dropped function is the
// casualty the audit must find. Used by the integration test.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function sh(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
}

function gitc(cwd, ...args) {
  return sh(
    cwd,
    'git',
    '-c',
    'user.name=casualty-test',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
    ...args,
  );
}

function write(repo, rel, content) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * @returns {{ repo: string, cleanup: () => void, base: string, merge: string }}
 */
export function buildFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'casualty-fix-'));
  gitc(repo, 'init', '-q', '-b', 'main');

  // The file is deliberately long with the editable regions far apart, so the
  // feature change (bottom) and the main change (top) merge cleanly with no
  // textual conflict. That makes the dropped feature an unambiguous CLEAR DROP.
  const head = [
    'export const VERSION = 1;',
    '',
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function subtract(a, b) {',
    '  return a - b;',
    '}',
    '',
    'export function divide(a, b) {',
    '  return a / b;',
    '}',
    '',
  ];

  // --- base ---
  write(repo, 'app.js', head.join('\n'));
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'base');
  const base = gitc(repo, 'rev-parse', 'HEAD').trim();

  // --- feature branch: append a new function at the very end ---
  gitc(repo, 'checkout', '-q', '-b', 'feature');
  write(
    repo,
    'app.js',
    [...head, 'export function multiply(a, b) {', '  return a * b;', '}', ''].join('\n'),
  );
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'feat: add multiply');

  // --- main: bump VERSION on the first line (a region far from the feature) ---
  gitc(repo, 'checkout', '-q', 'main');
  write(repo, 'app.js', ['export const VERSION = 2;', ...head.slice(1)].join('\n'));
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'bump version');

  // --- the botched merge: resolve by dropping the multiply function entirely ---
  // The two changes do not textually overlap, so a clean merge would keep both.
  // We deliberately commit a tree that omits multiply, simulating a careless
  // conflict resolution / merge-queue squash that ate the feature.
  try {
    gitc(repo, 'merge', '--no-commit', '--no-ff', 'feature');
  } catch {
    // a real merge may or may not conflict depending on git version; ignore
  }
  // Commit a tree that has main's VERSION bump but omits the feature's multiply:
  // a careless resolution / merge-queue squash that quietly ate the feature.
  write(repo, 'app.js', ['export const VERSION = 2;', ...head.slice(1)].join('\n'));
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'Merge feature (dropped multiply)');
  const merge = gitc(repo, 'rev-parse', 'HEAD').trim();

  return {
    repo,
    base,
    merge,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}
