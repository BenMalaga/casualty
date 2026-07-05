// Thin git plumbing layer. Reads commits, trees, and blobs at arbitrary refs
// and drives git's own remerge primitive (merge-tree --write-tree). Never
// touches the working copy: no checkout, no stash, no index writes.

import { execFileSync, spawnSync } from 'node:child_process';

const MAX_BUFFER = 1024 * 1024 * 1024; // 1 GiB

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

function gitRaw(args, cwd, input) {
  return spawnSync('git', args, { cwd, input, maxBuffer: MAX_BUFFER });
}

/** True if cwd is inside a git repository. */
export function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a ref to a commit sha, or null if it does not exist. */
export function resolveRef(ref, cwd) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], cwd).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Best common ancestor of two commits, or null if they share no history.
 * When there are multiple bases git returns the first; that is sufficient for
 * computing which lines a parent introduced.
 */
export function mergeBase(a, b, cwd) {
  try {
    return git(['merge-base', a, b], cwd).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/**
 * List the commits in a range, oldest first. Accepts the same range syntax git
 * does (`a..b`, a single ref meaning everything reachable, etc.).
 * @returns {string[]} commit shas
 */
export function listCommits(range, cwd) {
  const out = git(['rev-list', '--reverse', ...range.split(' ').filter(Boolean)], cwd);
  return out.split('\n').filter(Boolean);
}

/**
 * Parent shas of a commit, in order (first parent first).
 * @returns {string[]}
 */
export function parentsOf(sha, cwd) {
  const out = git(['rev-list', '--parents', '-n', '1', sha], cwd).trim();
  const parts = out.split(/\s+/);
  return parts.slice(1); // drop the commit's own sha
}

/** One-line subject of a commit, trimmed. */
export function subjectOf(sha, cwd) {
  return git(['show', '-s', '--format=%s', sha], cwd).trim();
}

/** Short sha (git's default abbreviation). */
export function shortSha(sha, cwd) {
  return git(['rev-parse', '--short', sha], cwd).trim();
}

/**
 * Run git's remerge primitive on two commits. This recomputes the merge the way
 * git itself would, finding the merge base(s) automatically, doing rename
 * detection and three-way content merges, without writing to the index or
 * working tree.
 *
 * @returns {{ tree: string, conflicted: boolean, conflictFiles: string[] }}
 *   tree: sha of the resulting (possibly conflict-marked) tree
 *   conflicted: true if any path failed to merge cleanly
 *   conflictFiles: paths that conflicted
 */
export function remerge(p1, p2, cwd) {
  // -z keeps filenames NUL-terminated so paths with spaces survive intact.
  const res = gitRaw(['merge-tree', '--write-tree', '-z', '--name-only', p1, p2], cwd);
  // Exit 0: clean merge. Exit 1: merge with conflicts (still produces a tree).
  // Anything else is a real error (e.g. unrelated histories with no base).
  if (res.status !== 0 && res.status !== 1) {
    const err = res.stderr ? res.stderr.toString().trim() : 'unknown error';
    return { tree: null, conflicted: false, conflictFiles: [], error: err };
  }
  const stdout = res.stdout.toString('utf8');
  // Output format (with -z): <OID of toplevel tree>NUL then, on conflict,
  // a NUL-separated list of conflicted file info, an empty field, then messages.
  const nul = stdout.indexOf('\0');
  const tree = (nul === -1 ? stdout : stdout.slice(0, nul)).trim();
  const conflicted = res.status === 1;
  let conflictFiles = [];
  if (conflicted && nul !== -1) {
    const rest = stdout.slice(nul + 1);
    // With --name-only the conflicted-info section is just NUL-separated paths
    // up to the first empty field that separates it from the messages block.
    const fields = rest.split('\0');
    for (const f of fields) {
      if (f === '') break; // separator before the informational messages
      conflictFiles.push(f);
    }
    conflictFiles = [...new Set(conflictFiles)];
  }
  return { tree, conflicted, conflictFiles };
}

/**
 * The set of paths that differ between two trees, names only. Cheap (no content
 * is read) and used to skip files that are byte-identical between a parent and
 * the committed merge: if a file did not change at all relative to a parent,
 * none of that parent's lines in it were lost.
 * @returns {Set<string>}
 */
export function changedPathSet(a, b, cwd) {
  const res = gitRaw(['diff', '--name-only', '-z', a, b], cwd);
  if (res.status !== 0) return null; // signal "unknown": caller should not skip
  const out = res.stdout.toString('utf8');
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * One whole-tree unified diff (all files) between two trees, as raw text. A
 * single git process for the entire diff instead of one per file. Whitespace
 * is ignored (`-w`) so reindentation never masquerades as lost content, and
 * rename detection (`-M`) is on so a moved file diffs against its old location.
 * Returns '' on failure so a partial clone degrades gracefully rather than
 * aborting the whole audit.
 */
export function diffWholeTree(a, b, cwd, { context = 0 } = {}) {
  const res = gitRaw(['diff', '--no-color', '-M', '-w', `-U${context}`, a, b], cwd);
  if (res.status !== 0) return '';
  return res.stdout.toString('utf8');
}

/**
 * Read a single blob at `tree:path`, or null if it does not exist there.
 */
export function readBlob(tree, path, cwd) {
  const res = gitRaw(['cat-file', '-p', `${tree}:${path}`], cwd);
  if (res.status !== 0) return null;
  return res.stdout.toString('utf8');
}

/**
 * Normalize a source line for "did this survive" comparisons: strip leading and
 * trailing whitespace and a trailing line-comment. This is what keeps the audit
 * from crying wolf when a merge kept a line but trimmed its trailing comment,
 * e.g. parent `return name  # type: ignore[x]` vs merge `return name`. Both
 * normalize to `return name`, so the line is counted as survived, not lost.
 */
export function normalizeLine(line) {
  let s = line.trim();
  // Strip a trailing line comment (best-effort, language-agnostic). Only when
  // the comment marker is preceded by whitespace so we do not chop string
  // literals that merely contain // or #.
  s = s.replace(/\s+(\/\/|#).*$/, '');
  return s.replace(/\s+$/, '');
}

// Per-process caches keyed by `ref\0path`. The audit asks "is this line present
// at this ref" many times for the same files (each lost block, against the
// committed tree, the tip, and the other parent), so we read each blob once and
// cache both an exact line set and a normalized line set.
const _exactSetCache = new Map();
const _normSetCache = new Map();

function sets(ref, path, cwd) {
  const key = `${ref}\0${path}`;
  let exact = _exactSetCache.get(key);
  if (exact === undefined) {
    const content = readBlob(ref, path, cwd);
    if (content == null) {
      exact = null;
      _exactSetCache.set(key, null);
      _normSetCache.set(key, null);
    } else {
      const lines = content.split('\n');
      exact = new Set(lines);
      _exactSetCache.set(key, exact);
      _normSetCache.set(key, new Set(lines.map(normalizeLine)));
    }
  }
  return { exact, norm: _normSetCache.get(key) };
}

/**
 * Does the given line appear (exactly) anywhere in the file at `ref:path`? Used
 * for parent attribution where an exact match is what we want.
 */
export function lineInFileAtRef(ref, path, line, cwd) {
  const { exact } = sets(ref, path, cwd);
  if (exact == null) return false;
  return exact.has(line);
}

/**
 * Did this parent line "survive" into the file at `ref:path`? True if an exact
 * or normalized-equal line exists there. Normalized matching absorbs the common
 * "kept the line, trimmed a trailing comment / reindented" case so it is not
 * misreported as lost content.
 */
export function lineSurvivesAtRef(ref, path, line, cwd) {
  const { exact, norm } = sets(ref, path, cwd);
  if (exact == null) return false;
  if (exact.has(line)) return true;
  return norm.has(normalizeLine(line));
}
