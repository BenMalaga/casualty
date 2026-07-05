// Paths that casualty skips by default. These are files where a "lost line" is
// almost always noise, not a forensic event:
//
//   - Lock files and generated manifests: their lines churn on every merge and a
//     dropped lock entry is a regeneration artifact, not lost human code.
//   - Vendored and build-output trees: not authored in this repo.
//   - Minified bundles and maps: not human-readable, huge, and meaningless to
//     diff line by line.
//
// Skipping them is both a correctness win (far fewer false positives) and a
// speed win (lock files are the largest, slowest things to scan). Use
// --include-generated to scan them anyway.

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
  'flake.lock',
]);

const SKIP_DIR_SEGMENTS = [
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '.next/',
  'out/',
  'target/',
  'coverage/',
  '.yarn/',
  'third_party/',
  'Pods/',
];

const SKIP_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.map',
  '.snap', // jest snapshots: generated
];

/**
 * Should this path be skipped by default?
 */
export function isGenerated(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILE_BASENAMES.has(base)) return true;
  for (const seg of SKIP_DIR_SEGMENTS) {
    if (path === seg.slice(0, -1) || path.startsWith(seg) || path.includes('/' + seg)) return true;
  }
  for (const suf of SKIP_SUFFIXES) {
    if (path.endsWith(suf)) return true;
  }
  return false;
}
