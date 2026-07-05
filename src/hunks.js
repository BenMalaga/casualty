// Pure functions for turning unified-diff text into structured hunks. No git,
// no I/O: diff string in, hunk records out. Kept separate so the parsing logic
// is unit-testable in isolation.

/**
 * Split a whole-tree unified diff (many files) into per-file sections, parsing
 * the new-side path, rename origin, and hunks for each. This lets the audit run
 * a single `git diff` for an entire tree instead of one process per file.
 *
 * @param {string} diffText output of `git diff -M -w -U0 A B`
 * @returns {Array<{ path: string, oldPath: string|null,
 *                   hunks: ReturnType<typeof parseHunks> }>}
 */
export function parseFileDiffs(diffText) {
  const files = [];
  if (!diffText) return files;
  const lines = diffText.split('\n');
  let cur = null;
  let body = [];

  const flush = () => {
    if (cur) {
      cur.hunks = parseHunks(body.join('\n'));
      files.push(cur);
    }
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { path: null, oldPath: null, hunks: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
    } else if (line.startsWith('+++ ')) {
      // "+++ b/path" (or "+++ /dev/null" for deletions). Prefer this for the
      // new-side path; it is unambiguous even with odd filenames.
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = stripPrefix(p);
      body.push(line);
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && !cur.oldPath) cur.oldPath = stripPrefix(p);
      body.push(line);
    } else {
      body.push(line);
    }
  }
  flush();
  // Drop files with no recoverable new-side path (pure deletions) and no hunks.
  return files.filter((f) => f.path);
}

function stripPrefix(p) {
  // git prefixes paths with a/ or b/ in diff headers.
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/**
 * Parse a unified diff (single file) into hunks of added/removed lines.
 *
 * We care about one direction at a time. When diffing the committed merge tree
 * against the mechanical remerge tree, a line that is "+" (present in remerge,
 * absent in commit) is a candidate casualty. The hunk header gives us the line
 * range in the remerge side.
 *
 * @param {string} diffText unified diff for exactly one file
 * @returns {Array<{ addedLines: Array<{line: string, lineNo: number}>,
 *                   removedLines: string[], newStart: number }>}
 */
export function parseHunks(diffText) {
  const hunks = [];
  if (!diffText) return hunks;
  const lines = diffText.split('\n');
  let current = null;
  let newLineNo = 0;
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) continue;
      newLineNo = parseInt(m[1], 10);
      current = { addedLines: [], removedLines: [], newStart: newLineNo };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      current.addedLines.push({ line: raw.slice(1), lineNo: newLineNo });
      newLineNo++;
    } else if (raw.startsWith('-')) {
      current.removedLines.push(raw.slice(1));
    } else if (raw.startsWith(' ')) {
      newLineNo++;
    }
    // '\' (no-newline marker) and blank lines: ignore for counting.
  }
  return hunks;
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})/;

/** True if a line is a git conflict marker (<<<<<<<, =======, >>>>>>>, |||||||). */
export function isConflictMarker(line) {
  return CONFLICT_MARKER.test(line);
}

/**
 * A line is "trivial" if losing it almost certainly is not a forensic event:
 * blank lines, lone braces/brackets/parens, and conflict markers. Dropping a
 * lone "}" during conflict resolution is noise, not a casualty.
 */
export function isTrivialLine(line) {
  const t = line.trim();
  if (t === '') return true;
  if (isConflictMarker(line)) return true;
  if (/^[}\]);,{[(]+$/.test(t)) return true;
  return false;
}
