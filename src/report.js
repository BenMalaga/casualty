// Terminal and JSON rendering of an audit. Deterministic output: same repo,
// same range, same bytes.

function colorize(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

const SIDE_LABEL = {
  p1: 'first parent (the branch you merged into)',
  p2: 'second parent (the branch you merged in)',
  both: 'both parents',
  unknown: 'unknown parent',
};

const MAX_LINES_SHOWN = 8;

/**
 * Human-readable report.
 */
export function renderText(audit, range, opts = {}) {
  const c = colorize(Boolean(opts.color));
  const out = [];
  const push = (s = '') => out.push(s);

  const { results, stats } = audit;
  const withCasualties = results.filter((r) => r.casualties && r.casualties.length);
  const octopus = results.filter((r) => r.kind === 'octopus');
  const totalCasualties = withCasualties.reduce((n, r) => n + r.casualties.length, 0);

  push(c.bold(`casualty · ${range}`));
  push(
    c.dim(
      `${stats.scanned} commit(s) scanned · ${stats.merges} merge(s) re-merged` +
        (stats.octopus ? ` · ${stats.octopus} octopus merge(s) skipped` : '') +
        (stats.skipped ? ` · ${stats.skipped} merge(s) skipped (unreadable)` : ''),
    ),
  );
  push();

  if (totalCasualties === 0) {
    push(c.green('No merge casualties found.'));
    push(c.dim('Every parent hunk that survived the mechanical re-merge is present in the recorded merge.'));
    for (const o of octopus) {
      push(c.yellow(`  note: ${o.kind === 'octopus' ? 'octopus' : o.kind} merge ${shortOrSha(o)} not analyzed (more than two parents).`));
    }
    return out.join('\n');
  }

  for (const r of withCasualties) {
    push(c.bold(`${r.short || r.sha.slice(0, 9)}  ${r.subject || ''}`));
    push(c.dim(`  parents ${r.parentShorts.join(' + ')}` + (r.conflictFiles.length ? ` · conflicted: ${r.conflictFiles.join(', ')}` : '')));
    for (const cas of r.casualties) {
      const tag = cas.confidence === 'clear' ? c.red('CLEAR DROP') : c.yellow('AMBIGUOUS');
      const where = cas.oldPath && cas.oldPath !== cas.path ? `${cas.path} (was ${cas.oldPath})` : cas.path;
      const range_ = cas.startLine === cas.endLine ? `:${cas.startLine}` : `:${cas.startLine}-${cas.endLine}`;
      push(`  ${tag}  ${c.cyan(where + range_)}  ${c.dim('from ' + SIDE_LABEL[cas.side])}`);
      const shown = cas.lines.slice(0, MAX_LINES_SHOWN);
      for (const l of shown) push(c.dim('    | ') + c.green(l));
      if (cas.lines.length > shown.length) {
        push(c.dim(`    | ... and ${cas.lines.length - shown.length} more line(s)`));
      }
    }
    push();
  }

  for (const o of octopus) {
    push(c.yellow(`note: octopus merge ${shortOrSha(o)} (${o.parents.length} parents) was not analyzed; merge-tree re-merges two commits only.`));
  }

  const clear = withCasualties.reduce(
    (n, r) => n + r.casualties.filter((x) => x.confidence === 'clear').length,
    0,
  );
  const ambiguous = totalCasualties - clear;
  push(
    c.bold(
      `Summary: ${totalCasualties} casualt${totalCasualties === 1 ? 'y' : 'ies'} across ${withCasualties.length} merge(s)` +
        ` (${clear} clear drop(s), ${ambiguous} ambiguous).`,
    ),
  );
  return out.join('\n');
}

function shortOrSha(r) {
  return r.short || r.sha.slice(0, 9);
}

/**
 * Machine-readable report.
 */
export function renderJson(audit, range) {
  const results = audit.results.map((r) => {
    if (r.kind === 'octopus') {
      return { commit: r.sha, kind: 'octopus', parents: r.parents, analyzed: false, casualties: [] };
    }
    if (r.kind === 'skipped') {
      return { commit: r.sha, kind: 'skipped', reason: r.reason, analyzed: false, casualties: [] };
    }
    return {
      commit: r.sha,
      short: r.short,
      subject: r.subject,
      kind: 'merge',
      parents: r.parents,
      conflictFiles: r.conflictFiles,
      casualties: r.casualties.map((c) => ({
        path: c.path,
        oldPath: c.oldPath ?? null,
        startLine: c.startLine,
        endLine: c.endLine,
        side: c.side,
        confidence: c.confidence,
        fileConflicted: c.fileConflicted,
        lostContent: c.lines,
      })),
    };
  });
  const withCasualties = audit.results.filter((r) => r.casualties && r.casualties.length);
  const total = withCasualties.reduce((n, r) => n + r.casualties.length, 0);
  return JSON.stringify(
    {
      tool: 'casualty',
      range,
      scanned: audit.stats.scanned,
      mergesAnalyzed: audit.stats.merges,
      octopusSkipped: audit.stats.octopus,
      unreadableSkipped: audit.stats.skipped || 0,
      totalCasualties: total,
      merges: results,
    },
    null,
    2,
  );
}
