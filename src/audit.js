// The forensic core. For each merge commit in a range:
//
//   1. Take its two parents P1 and P2 and their merge base B.
//   2. Run git's remerge primitive (merge-tree --write-tree) on P1, P2. This is
//      how git itself would re-merge them today: it finds the base, detects
//      renames, does three-way content merges. We use it for one thing only:
//      to learn which files conflicted (so we can grade confidence).
//   3. For each parent, compute the lines that parent ADDED relative to the
//      merge base (git diff -w -U0 B parent). Those are the only lines that
//      parent contributed; base lines that were merely superseded never enter
//      the candidate set, so a bumped VERSION constant is not "lost".
//   4. A contributed line is a CASUALTY if it is absent from the committed merge
//      tree and was not reintroduced by a later commit on the range tip.
//
// Diffing against the merge base (rather than against the conflict-marked
// remerge tree) is what keeps the tool from crying wolf: line numbers are real
// parent-side positions, conflict-marker residue never leaks in, and superseded
// base content is excluded by construction.

import {
  parentsOf,
  subjectOf,
  shortSha,
  remerge,
  mergeBase,
  diffWholeTree,
  changedPathSet,
  lineInFileAtRef,
  lineSurvivesAtRef,
} from './gitio.js';
import { parseFileDiffs, isTrivialLine } from './hunks.js';
import { isGenerated } from './ignore.js';

/**
 * Audit a single commit. Non-merge and octopus commits return early with their
 * kind so the caller can account for them honestly.
 */
export function auditMerge(sha, cwd, opts = {}) {
  const parents = parentsOf(sha, cwd);

  if (parents.length < 2) {
    return { sha, kind: 'non-merge', parents, casualties: [] };
  }
  if (parents.length > 2) {
    // Octopus merge. merge-tree re-merges exactly two commits, so an N-way merge
    // cannot be faithfully reconstructed. Report it, do not guess.
    return { sha, kind: 'octopus', parents, casualties: [] };
  }

  const [p1, p2] = parents;

  // Use git's remerge only to discover which files conflicted. The tree it
  // writes is not diffed directly (it can contain conflict markers).
  const rm = remerge(p1, p2, cwd);
  if (rm.error) {
    return { sha, kind: 'unmergeable', parents, reason: rm.error, casualties: [] };
  }
  const conflictSet = new Set(rm.conflictFiles || []);

  const base = mergeBase(p1, p2, cwd);
  const committedTree = `${sha}^{tree}`;
  const tip = opts.tip || sha;

  const casualties = [];
  // Examine each parent's contributions independently.
  for (const [parent, sideLabel] of [
    [p1, 'p1'],
    [p2, 'p2'],
  ]) {
    if (!base) continue; // unrelated histories: no shared base to diff from

    // Fast path: a file that is byte-identical between this parent and the
    // committed merge cannot have lost any of this parent's lines. Restrict the
    // (expensive) per-line survival checks to files the merge actually touched
    // relative to the parent. If git cannot answer, fall back to checking all.
    const touched = changedPathSet(parent, committedTree, cwd);

    const contributed = contributedHunks(base, parent, cwd, opts);
    for (const { path, oldPathInBase, blocks } of contributed) {
      if (touched && !touched.has(path) && !(oldPathInBase && touched.has(oldPathInBase))) {
        continue;
      }
      for (const block of blocks) {
        // The substantive lines this parent contributed (drop blanks and lone
        // braces: those are too ubiquitous to track reliably and losing one
        // alone is noise, not a forensic event).
        const substantive = block.lines.filter((l) => !isTrivialLine(l));
        if (substantive.length === 0) continue;

        // Casualty test: a substantive line is "lost" if it did not survive
        // into the committed merge tree. Survival is exact-or-normalized so a
        // line the merge kept but reindented or whose trailing comment it
        // trimmed is NOT misreported as lost.
        const lost = substantive.filter((l) => !lineSurvivesAtRef(committedTree, path, l, cwd));
        if (lost.length === 0) continue;

        // Guard: "no later reintroduction". Keep only lines still gone at the
        // tip. If a later commit restored them all, nothing was lost for good.
        const stillGone = lost.filter((l) => !lineSurvivesAtRef(tip, path, l, cwd));
        if (stillGone.length === 0) continue;

        // Attribution: if the OTHER parent contributed these same lines too,
        // both sides independently added the content; attribute to "both".
        const otherParent = parent === p1 ? p2 : p1;
        const fromOther = stillGone.every((l) => lineInFileAtRef(otherParent, path, l, cwd));
        const side = fromOther ? 'both' : sideLabel;

        const fileConflicted = conflictSet.has(path);
        casualties.push({
          path,
          oldPath: oldPathInBase && oldPathInBase !== path ? oldPathInBase : undefined,
          startLine: block.startLine,
          endLine: block.endLine,
          // Display the full contiguous parent block for context (trimmed of
          // leading/trailing blanks), so the reader sees the lost code intact.
          lines: trimEdges(block.lines),
          lostLines: stillGone,
          side,
          // A clean (non-conflicted) merge that nonetheless dropped a parent's
          // contribution is a CLEAR drop. A conflicted file is AMBIGUOUS:
          // conflict resolution legitimately discards one side sometimes.
          confidence: fileConflicted ? 'ambiguous' : 'clear',
          fileConflicted,
        });
      }
    }
  }

  // De-duplicate: the "both" detection can surface the same block from each
  // parent's pass. Keep one entry per (path,startLine,endLine,firstLostLine).
  const deduped = dedupeCasualties(casualties);

  return {
    sha,
    short: shortSha(sha, cwd),
    subject: subjectOf(sha, cwd),
    kind: 'merge',
    parents,
    parentShorts: parents.map((p) => shortSha(p, cwd)),
    conflictFiles: rm.conflictFiles || [],
    casualties: deduped,
  };
}

/**
 * For a parent, the contiguous blocks of lines it added relative to the merge
 * base, per file. Whitespace-insensitive, zero-context, rename-aware.
 *
 * @returns {Array<{ path: string, oldPathInBase?: string,
 *                   blocks: Array<{startLine, endLine, lines: string[]}> }>}
 */
function contributedHunks(base, parent, cwd, opts = {}) {
  // One whole-tree diff for the entire commit, parsed into per-file sections.
  // This is a single git process regardless of how many files changed, which is
  // what keeps a 50-merge range fast even when parents diverged heavily.
  const diffText = diffWholeTree(base, parent, cwd, { context: 0 });
  const fileDiffs = parseFileDiffs(diffText);
  const out = [];
  for (const fd of fileDiffs) {
    // Skip generated / vendored / lock files unless asked to include them.
    // These are the largest files and the richest source of false positives
    // (a churned lock entry is not lost human code).
    if (!opts.includeGenerated && isGenerated(fd.path)) continue;
    const blocks = [];
    for (const h of fd.hunks) {
      // Zero context => each hunk is a contiguous added region on the parent
      // side; collapse its added lines into one block.
      if (h.addedLines.length === 0) continue;
      blocks.push({
        startLine: h.addedLines[0].lineNo,
        endLine: h.addedLines[h.addedLines.length - 1].lineNo,
        lines: h.addedLines.map((a) => a.line),
      });
    }
    if (blocks.length) {
      out.push({ path: fd.path, oldPathInBase: fd.oldPath, blocks });
    }
  }
  return out;
}

/** Trim leading and trailing blank lines from a block for display. */
function trimEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

function dedupeCasualties(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = `${c.path}:${c.startLine}-${c.endLine}:${c.lostLines[0] || ''}`;
    if (seen.has(key)) {
      // Prefer the "both" attribution if we have it.
      const prev = out.find(
        (x) => `${x.path}:${x.startLine}-${x.endLine}:${x.lostLines[0] || ''}` === key,
      );
      if (prev && c.side === 'both') prev.side = 'both';
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Audit a whole range of commits.
 */
export function auditRange(commits, cwd, tip, opts = {}) {
  const results = [];
  let merges = 0;
  let octopus = 0;
  let scanned = 0;
  let skipped = 0;
  for (const sha of commits) {
    scanned++;
    let r;
    try {
      r = auditMerge(sha, cwd, { tip, includeGenerated: opts.includeGenerated });
    } catch (e) {
      // A single merge that git cannot process (e.g. a partial clone missing an
      // object) is skipped, not fatal. The rest of the range still gets audited.
      skipped++;
      results.push({ sha, kind: 'skipped', reason: String(e.message || e).split('\n')[0], casualties: [] });
      continue;
    }
    if (r.kind === 'merge') {
      merges++;
      results.push(r);
    } else if (r.kind === 'octopus') {
      octopus++;
      results.push(r);
    }
  }
  return { results, stats: { scanned, merges, octopus, skipped } };
}
