<div align="center">

# casualty

**A clean merge can still lose your code.**

Git forensics that audits merges for hunks that went in on a branch and silently
never came out: code dropped during conflict resolution that no test caught and
no one noticed.

[![npm](https://img.shields.io/npm/v/casualty?color=cb3837&label=npm)](https://www.npmjs.com/package/casualty)
[![CI](https://github.com/BenMalaga/casualty/actions/workflows/test.yml/badge.svg)](https://github.com/BenMalaga/casualty/actions)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933)
![deps](https://img.shields.io/badge/dependencies-0-success)
![mode](https://img.shields.io/badge/mode-read--only-blue)
![license](https://img.shields.io/badge/license-MIT-yellow)

<!-- DEMO GIF: replace this comment with the cast once recorded.
     ![casualty catching a clear drop](assets/demo.gif)
     Recording script is in the "Recording the demo" section below. -->

</div>

---

When two branches merge, git resolves what it can and a human (or a merge queue)
resolves the rest. Sometimes the resolution quietly drops a hunk: a function, a
guard clause, a bug fix that one side added and the recorded merge simply does
not contain. The diff against either parent looks reasonable. The build passes.
The code is just gone, and it stays gone until someone notices the feature it
implemented stopped working.

`casualty` finds these. For each merge in a range it re-runs the merge
mechanically using git's own remerge primitive, then compares what that re-merge
preserved against what the recorded merge actually committed. Anything a parent
contributed that survived the re-merge but is absent from the commit, and was
never reintroduced later, is a **casualty**: reported with the merge, the
file and line range, the lost content, and which side it came from.

## The bug it catches

Two engineers, one file. One adds a fraud check inside `charge()`. The other,
on `main`, changes `refund()`. The regions do not overlap, so git merges them
cleanly, no conflict. But the merge was committed from a tree that has the
`refund` change and is missing the fraud check. No conflict markers, no failed
build, nothing to notice. Charges stop being screened.

```console
$ casualty 09dba28..HEAD

casualty · 09dba28..HEAD
3 commit(s) scanned · 1 merge(s) re-merged

9a69c6d  Merge fraud-check into main
  parents 915e8c6 + 7c56ad1
  CLEAR DROP  payments.py:4-5  from second parent (the branch you merged in)
    |     if fraud.is_suspicious(customer, amount):
    |         raise FraudError("charge blocked by fraud check")

Summary: 1 casualty across 1 merge(s) (1 clear drop(s), 0 ambiguous).
```

The merge had no conflict at all (that is exactly why it slipped through), yet
the fraud check that one branch added is nowhere in the committed result. A
plain `git diff` against either parent never shows it, because against `main`
the merge looks like a clean refund change, and against the feature branch it
looks like a clean refund change too. Only re-merging the two parents and
comparing surfaces the hole.

If casualty finds a hole in your history, star the repo so the next person hears about it before they ship the bug.

## Real-world run

Here is `casualty` running cold on [Flask](https://github.com/pallets/flask),
across its last 50 merges. Verbatim output (trimmed for length):

```console
$ casualty a5f9742..HEAD

casualty · a5f9742..HEAD
115 commit(s) scanned · 49 merge(s) re-merged

3301232  Merge branch 'stable'
  parents ed1c9e9 + 85793d6 · conflicted: CHANGES.rst, docs/templating.rst, pyproject.toml, uv.lock
  AMBIGUOUS  docs/templating.rst:143  from second parent (the branch you merged in)
    | If you want to register your own filters in Jinja you have two ways to do
  AMBIGUOUS  pyproject.toml:3  from second parent (the branch you merged in)
    | version = "3.1.2"

daca74d  Merge branch 'stable'
  parents d98eb69 + f00ad42 · conflicted: CHANGES.rst, pyproject.toml, src/flask/ctx.py, ...
  AMBIGUOUS  src/flask/ctx.py:367-376  from second parent (the branch you merged in)
    |     @property
    |     def session(self) -> SessionMixin:
    |         """The session data associated with this request. Not available until
    | ... and 6 more line(s)

Summary: 21 casualties across 6 merge(s) (0 clear drop(s), 21 ambiguous).
```

Every finding here is **AMBIGUOUS**, and that is the correct, honest verdict:
all six merges had real conflicts (version bumps in `pyproject.toml`, the
`stable` backport churn), and content discarded during a genuine conflict
resolution may well have been discarded on purpose. `casualty` refuses to call
any of them a definite bug. **Zero clear drops** in 49 merges is the healthy
result you want from a mature project. The whole 50-merge scan finishes in about
27 seconds on a laptop.

## Install

```console
npx casualty main~50..main      # nothing to install
```

Or globally:

```console
npm install -g casualty
```

Zero dependencies, Node 18 or newer, and `git` on your PATH. That is the entire
supply chain. It is structurally read-only: it shells out to git plumbing
(`rev-list`, `merge-tree`, `diff`, `cat-file`) and never writes to your index,
working tree, or object store.

## Usage

Run it inside any git repo, with any rev-list range:

```console
casualty main~50..main            # the last 50 merges into main
casualty v1.0..v2.0               # everything between two releases
casualty HEAD~200..HEAD --json    # machine-readable, for CI
casualty release..main -C ~/src/x # any range, any repo
```

Options:

| Flag | Effect |
| --- | --- |
| `--json` | structured output for scripts and CI |
| `-C <dir>` | run against a repo in another directory |
| `--tip <ref>` | ref used for the "reintroduced later?" check (default: the range end) |
| `--fail-on-clear` | exit 1 if any CLEAR DROP is found, for gating a pipeline |
| `--include-generated` | also scan lock files and vendored/generated trees (off by default) |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |

Exit code 0 on success, 1 with `--fail-on-clear` when a clear drop is found,
2 on usage or repository errors.

## How it works

For every two-parent merge `M` in the range, with parents `P1` and `P2` and
merge base `B`:

1. **Re-merge.** `git merge-tree --write-tree P1 P2` re-runs the merge the way
   git itself would today: it finds the base, detects renames, does three-way
   content merges. This is the same remerge primitive `git log --remerge-diff`
   is built on. `casualty` uses it to learn which files conflicted, which sets
   the confidence of every finding in that file.
2. **Recover each parent's contribution.** `git diff -w -U0 B P` gives the exact
   lines each parent added relative to the base. Those, and only those, are the
   candidate lines. Diffing against the base (not against the conflict-marked
   re-merge tree) is the key correctness choice: superseded base content (a
   bumped `VERSION` constant) is excluded by construction, whitespace is ignored,
   and line numbers stay honest.
3. **Find what is missing.** A candidate line is a casualty if it did not survive
   into the committed merge tree and was not reintroduced by a later commit up to
   the range tip.
4. **Grade it.** A clean (non-conflicted) merge that nonetheless dropped a
   parent's contribution is a **CLEAR DROP**: there was no conflict, so there was
   no decision to discard anything, so the absence is almost certainly an
   accident. A dropped line in a file that *did* conflict is **AMBIGUOUS**:
   conflict resolution legitimately discards one side sometimes, so this is a
   lead to review, not a verdict.

## Not crying wolf

A merge auditor that fires on every reformatted line is noise nobody reads. The
false-positive guards, each with a test that proves it:

- **Whitespace and reindentation are ignored** (`-w`). Reformatting is never a
  casualty.
- **Modified-not-lost lines survive.** A line the merge kept but trimmed a
  trailing comment from, or reindented, matches by normalized form. Without this,
  `return name  # type: ignore` vs `return name` would be a false positive (and
  was, on Flask, until this guard).
- **Superseded base content is excluded.** Because candidates come from the
  base-to-parent diff, a value the other side legitimately changed is never a
  candidate in the first place.
- **Later reintroduction is checked.** Content dropped at the merge but added
  back by a subsequent commit is not reported. Point `--tip` at the merge itself
  to see it as it was on the day.
- **Trivial lines do not drive findings.** A lone `}` or blank line is never a
  casualty on its own.
- **Conflicted files are downgraded to AMBIGUOUS,** never reported as clear
  drops, because discarding one side of a conflict is a normal, intentional act.
- **Lock files and vendored/generated trees are skipped by default,** where a
  "lost line" is regeneration churn, not human code. `--include-generated` opts
  back in.

## Scope, honestly

- **Two-parent merges only.** Octopus (3+ parent) merges are reported in the
  summary but not analyzed: `merge-tree` re-merges exactly two commits, and
  `casualty` will not guess at an N-way merge it cannot faithfully reconstruct.
- **Line-level, not semantic.** It finds lost *text*, not lost *meaning*. A hunk
  that was reworded as it was kept is correctly treated as survived.
- **Partial clones degrade gracefully.** A merge whose objects git cannot read
  (a missing blob in a `--filter` clone) is counted as skipped, not fatal; the
  rest of the range is still audited.

## How it compares

| Tool | What it does | What it misses |
| --- | --- | --- |
| **casualty** | re-merges each merge's parents and reports parent content absent from the recorded merge | semantic loss; octopus merges (by design) |
| `git log --remerge-diff` | shows what conflict resolution changed, per merge, for a human to read | no audit, no verdict, no range rollup, no clear-vs-ambiguous grading; you read every merge by hand |
| `git diff M^1 M` / `M^2 M` | the merge against one parent | the *other* parent's lost content is invisible against either single parent (that is the whole trap) |
| code review | catches it if a reviewer reads the full merge diff carefully | merges are the diffs people rubber-stamp; that is why this class of bug exists |

The niche is specific: turning git's remerge primitive into a forensic audit
that names lost code, grades its confidence, and scales to a range. As of
mid-2026, no maintained tool does this.

## Contributing

The detection core is small and the false-positive bar is the whole game. See
[CONTRIBUTING.md](CONTRIBUTING.md). New detection behavior ships with a fixture
that proves both a true positive and the guard that suppresses its matching
false positive.

## Recording the demo

The GIF at the top is the highest-leverage thing in this README. Here is the
exact cast that produces it: a two-file clean merge that drops a fraud check,
then casualty catching it. Run it from an empty scratch directory. It builds a
throwaway repo, runs the tool, and leaves nothing behind but a terminal you can
record.

```bash
set -e
tmp="$(mktemp -d)"; cd "$tmp"
git init -q -b main && git config user.email d@e.f && git config user.name demo

# base commit: a payments file with both functions
cat > payments.py <<'PY'
def charge(customer, amount):
    gateway.charge(customer, amount)

def refund(customer, amount):
    gateway.refund(customer, amount)
PY
git add payments.py && git commit -qm "base: charge + refund"
BASE=$(git rev-parse --short HEAD)

# feature branch adds a fraud check inside charge()
git checkout -q -b fraud-check
cat > payments.py <<'PY'
def charge(customer, amount):
    if fraud.is_suspicious(customer, amount):
        raise FraudError("charge blocked by fraud check")
    gateway.charge(customer, amount)

def refund(customer, amount):
    gateway.refund(customer, amount)
PY
git commit -qam "add fraud check to charge()"

# main changes refund() in a non-overlapping region
git checkout -q main
cat > payments.py <<'PY'
def charge(customer, amount):
    gateway.charge(customer, amount)

def refund(customer, amount):
    log.info("refund issued")
    gateway.refund(customer, amount)
PY
git commit -qam "log refunds"

# merge without committing, then drop the fraud check from the merge tree
# itself: git auto-merged it cleanly, a human resolution silently removed it
git merge --no-commit --no-ff fraud-check || true
cat > payments.py <<'PY'
def charge(customer, amount):
    gateway.charge(customer, amount)

def refund(customer, amount):
    log.info("refund issued")
    gateway.refund(customer, amount)
PY
git add payments.py && git commit -qm "Merge fraud-check into main"

# the reveal: casualty catches the fraud check that never made it in
npx -y casualty "$BASE..HEAD"
```

Record it with [asciinema](https://asciinema.org) (`asciinema rec demo.cast`)
or [charmbracelet/vhs](https://github.com/charmbracelet/vhs) for a GIF, keep it
under 30 seconds, no audio, then save it to `assets/demo.gif` and swap in the
image tag left as a comment near the top of this file.

## Repo topics

For discovery, set these under the About sidebar (Settings gear next to About):

`git` `git-forensics` `merge` `merge-conflict` `cli` `developer-tools` `code-review` `merge-queue` `lost-code` `zero-dependencies`

## License

[MIT](LICENSE), Ben Malaga.
