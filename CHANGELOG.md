# Changelog

All notable changes to PatchSlim are documented here.

## 0.1.0 — 2026-07-29

Initial preview release.

### Added

- File-level and hunk-level delta debugging for committed Git branch diffs.
- `doctor`, `init`, `inspect`, `minimize`, and `report` commands with stable
  JSON output.
- Merge-base discovery, isolated temporary worktrees, candidate caching, and
  bounded command execution.
- Conservative protection for tests, fixtures, snapshots, migrations,
  documentation, CI, manifests, lockfiles, PatchSlim configuration, and Git
  control files.
- Head-pass/protected-base-fail preflight with repeated instability checks.
- Quick candidate gates, repeated final oracles, and full validation gates.
- `apply.patch`, `candidate.patch`, JSON reports, and Markdown reports.

### Safety

- Rejects weak or unstable oracles, red head gates, dirty setup output,
  candidate materialization failures, timeouts, and interruptions.
- Reconstructs every command stage from the merge base and clears ignored
  side effects between stages.
- Never applies a candidate to the current checkout automatically.

### Verified

- JavaScript and Python fixtures.
- Text hunks, added files, binary diffs, renames, mode changes, paths with
  spaces, and Unicode paths.
- Exact application of `apply.patch` to the original head.
- Node.js 20, 22, and 24, package linting, clean production dependency audit,
  and GitHub Actions.
