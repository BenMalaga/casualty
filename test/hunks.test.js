// Unit tests for the pure diff-parsing layer. No git, no I/O.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHunks, parseFileDiffs, isConflictMarker, isTrivialLine } from '../src/hunks.js';
import { normalizeLine } from '../src/gitio.js';

test('parseHunks reads added lines with correct new-side line numbers', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -3,0 +4,1 @@',
    '+IMPORTANT_FEATURE_LINE',
  ].join('\n');
  const hunks = parseHunks(diff);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].addedLines, [{ line: 'IMPORTANT_FEATURE_LINE', lineNo: 4 }]);
  assert.equal(hunks[0].newStart, 4);
});

test('parseHunks tracks line numbers across context and multiple additions', () => {
  const diff = [
    '@@ -1,3 +1,5 @@',
    ' keep1',
    '+added2',
    '+added3',
    ' keep4',
    '+added5',
  ].join('\n');
  const hunks = parseHunks(diff);
  assert.deepEqual(
    hunks[0].addedLines.map((a) => [a.line, a.lineNo]),
    [
      ['added2', 2],
      ['added3', 3],
      ['added5', 5],
    ],
  );
});

test('parseHunks returns nothing for empty input', () => {
  assert.deepEqual(parseHunks(''), []);
  assert.deepEqual(parseHunks(undefined), []);
});

test('parseFileDiffs splits a multi-file diff and recovers paths', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -0,0 +1,1 @@',
    '+const a = 1;',
    'diff --git a/src/b.js b/src/b.js',
    '--- a/src/b.js',
    '+++ b/src/b.js',
    '@@ -5,0 +6,2 @@',
    '+function two() {}',
    '+function three() {}',
  ].join('\n');
  const files = parseFileDiffs(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.js');
  assert.deepEqual(files[0].hunks[0].addedLines.map((a) => a.line), ['const a = 1;']);
  assert.equal(files[1].path, 'src/b.js');
  assert.deepEqual(
    files[1].hunks[0].addedLines.map((a) => [a.line, a.lineNo]),
    [
      ['function two() {}', 6],
      ['function three() {}', 7],
    ],
  );
});

test('parseFileDiffs recovers the rename origin', () => {
  const diff = [
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 90%',
    'rename from old/name.js',
    'rename to new/name.js',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -3,0 +4,1 @@',
    '+added line',
  ].join('\n');
  const files = parseFileDiffs(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'new/name.js');
  assert.equal(files[0].oldPath, 'old/name.js');
});

test('parseFileDiffs ignores pure deletions (no new-side path)', () => {
  const diff = [
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-was here',
    '-and here',
  ].join('\n');
  assert.deepEqual(parseFileDiffs(diff), []);
});

test('parseFileDiffs returns nothing for empty input', () => {
  assert.deepEqual(parseFileDiffs(''), []);
});

test('normalizeLine strips indentation and trailing comments', () => {
  // The classic false positive: merge kept the line but trimmed its comment.
  assert.equal(
    normalizeLine('            return name  # type: ignore[return-value]'),
    normalizeLine('        return name'),
  );
  assert.equal(normalizeLine('  const x = 1; // set x'), 'const x = 1;');
  // A # or // inside a string preceded by no space is not stripped as a comment.
  assert.equal(normalizeLine('url = "http://example.com"'), 'url = "http://example.com"');
});

test('isConflictMarker recognizes all four marker kinds', () => {
  assert.ok(isConflictMarker('<<<<<<< HEAD'));
  assert.ok(isConflictMarker('======='));
  assert.ok(isConflictMarker('>>>>>>> feature'));
  assert.ok(isConflictMarker('||||||| base'));
  assert.ok(!isConflictMarker('const x = 1;'));
  assert.ok(!isConflictMarker('<< not a marker'));
});

test('isTrivialLine flags blanks, lone braces, and markers', () => {
  assert.ok(isTrivialLine(''));
  assert.ok(isTrivialLine('   '));
  assert.ok(isTrivialLine('}'));
  assert.ok(isTrivialLine('  });'));
  assert.ok(isTrivialLine('<<<<<<< HEAD'));
  assert.ok(!isTrivialLine('return value;'));
  assert.ok(!isTrivialLine('const handler = () => {'));
});
