// CLI argument parsing and orchestration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isGitRepo, resolveRef, listCommits } from './gitio.js';
import { auditRange } from './audit.js';
import { renderText, renderJson } from './report.js';

const HELP = `casualty: forensic audit for code lost during merge conflict resolution.

Usage:
  casualty <range> [options]

Scans every merge commit in <range>, mechanically re-merges each one's parents
with git's own remerge primitive, and reports any parent content that survived
the re-merge but is missing from the recorded merge: a hunk that went in on a
branch and silently never came out.

Range is any git rev-list range, for example:
  casualty main~50..main
  casualty v1.0..v2.0
  casualty HEAD~200..HEAD

Options:
  --json               machine-readable output
  -C <dir>             run as if started in <dir>
  --tip <ref>          ref to check for later reintroduction (default: range end)
  --fail-on-clear      exit 1 if any CLEAR DROP is found (for CI gating)
  --include-generated  also scan lock files and vendored/generated trees
  --no-color           disable ANSI colors
  -h, --help           show this help
  -v, --version        show version

Exit codes: 0 success, 1 with --fail-on-clear when a clear drop is found,
2 on usage or repository errors.
`;

function version() {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  );
  return pkg.version;
}

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = {
    json: false,
    cwd: process.cwd(),
    color: null,
    tip: null,
    failOnClear: false,
    includeGenerated: false,
    range: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--color') opts.color = true;
    else if (a === '--fail-on-clear') opts.failOnClear = true;
    else if (a === '--include-generated') opts.includeGenerated = true;
    else if (a === '-C') {
      opts.cwd = argv[++i];
      if (!opts.cwd) throw new UsageError('-C requires a directory argument');
    } else if (a === '--tip') {
      opts.tip = argv[++i];
      if (!opts.tip) throw new UsageError('--tip requires a ref argument');
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) {
    throw new UsageError(`expected a single range, got ${positional.length} arguments`);
  }
  opts.range = positional[0] || null;
  return opts;
}

/** Derive the tip ref (for the reintroduction guard) from a range like a..b. */
function tipFromRange(range) {
  const m = /\.{2,3}(.+)$/.exec(range);
  if (m) return m[1].trim();
  // Single-ref range (everything reachable from X): tip is X.
  return range.trim().split(/\s+/).pop();
}

export function run(argv, stdout = process.stdout, stderr = process.stderr) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`casualty: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }

  if (opts.help) {
    stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    stdout.write(version() + '\n');
    return 0;
  }
  if (!opts.range) {
    stderr.write(`casualty: a commit range is required\n\n${HELP}`);
    return 2;
  }
  if (!isGitRepo(opts.cwd)) {
    stderr.write(`casualty: not a git repository: ${opts.cwd}\n`);
    return 2;
  }

  let commits;
  try {
    commits = listCommits(opts.range, opts.cwd);
  } catch (e) {
    stderr.write(`casualty: could not resolve range '${opts.range}' (${String(e.message || e).split('\n')[0]})\n`);
    return 2;
  }

  const tip = opts.tip || tipFromRange(opts.range);
  if (tip && !resolveRef(tip, opts.cwd)) {
    stderr.write(`casualty: cannot resolve tip ref '${tip}'\n`);
    return 2;
  }

  if (commits.length === 0) {
    if (opts.json) {
      stdout.write(renderJson({ results: [], stats: { scanned: 0, merges: 0, octopus: 0 } }, opts.range) + '\n');
    } else {
      stdout.write(`casualty: range '${opts.range}' contains no commits.\n`);
    }
    return 0;
  }

  const audit = auditRange(commits, opts.cwd, tip, { includeGenerated: opts.includeGenerated });

  if (opts.json) {
    stdout.write(renderJson(audit, opts.range) + '\n');
  } else {
    const color =
      opts.color !== null ? opts.color : Boolean(stdout.isTTY) && !process.env.NO_COLOR;
    stdout.write(renderText(audit, opts.range, { color }) + '\n');
  }

  if (opts.failOnClear) {
    const hasClear = audit.results.some(
      (r) => r.casualties && r.casualties.some((c) => c.confidence === 'clear'),
    );
    if (hasClear) return 1;
  }
  return 0;
}
