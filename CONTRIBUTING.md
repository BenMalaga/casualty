# Contributing to casualty

Thanks for considering a contribution. The project is intentionally small and
should stay that way: zero runtime dependencies, deterministic output, no
network access, no LLMs. It shells out to `git` and nothing else.

## Setup

```console
git clone https://github.com/BenMalaga/casualty
cd casualty
node --test
```

That is everything. There is no build step and nothing to install.

## Project layout

```
bin/casualty.js     executable entry point
src/cli.js          argument parsing and orchestration
src/gitio.js        git plumbing: rev-list, merge-tree, diff, cat-file (no checkout)
src/hunks.js        pure functions: unified-diff text in, structured hunks out
src/audit.js        the forensic core: re-merge, base-aware diff, casualty grading
src/report.js       text and JSON rendering
test/               node:test suites, including end-to-end fixture repos
test/fixtures/      programmatic git-repo builders for the integration tests
```

## How detection works (so you can extend it safely)

For each two-parent merge in the range:

1. `git merge-tree --write-tree P1 P2` re-merges the parents the way git would
   today. We use it only to learn which files conflicted (for confidence grading).
2. For each parent, `git diff -w -U0 <merge-base> <parent>` gives the exact lines
   that parent added relative to the base. Those are the only candidate lines.
3. A candidate line is a casualty if it is absent from the committed merge tree
   and was not reintroduced by a later commit on the range tip.

Diffing against the merge base (not the conflict-marked re-merge tree) is the
core correctness choice: it excludes superseded base content, ignores whitespace,
and keeps line numbers honest. Preserve that property in any change.

## The false-positive bar

False positives are worse than misses here: a developer who gets a phantom
"lost code" alert stops trusting the tool. Before opening a PR, run casualty
against a real repository with real merges (Flask, Django, and git itself all
work) and sanity-check the output by hand. New detection behavior ships with a
fixture test that proves both a true positive and the guard that suppresses the
matching false positive.

## Ground rules

- Zero runtime dependencies.
- Output must be deterministic: same repo, same range, same bytes.
- Node 18 or newer, ESM only.
- Handle merge commits only. Octopus (3+ parent) merges are reported but not
  analyzed; never guess an N-way merge from a 2-way primitive.
- New behavior ships with tests. `node --test` must pass.
- No em-dashes anywhere in code, comments, or copy.

## Reporting bugs

Open an issue with the repository (if public), the range, and the incorrect or
missing line of output. A failing test case built with the `test/fixtures`
helpers is even better.
