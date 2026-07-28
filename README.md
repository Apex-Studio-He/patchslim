# PatchSlim

PatchSlim finds a smaller Git diff that still passes the checks you care about.

Large refactors, speculative abstractions, and machine-assisted edits often leave
behind changes that are unrelated to the behavior a pull request is meant to
deliver. PatchSlim treats your test command as an oracle, removes files and hunks
in a temporary worktree, and keeps only candidates that continue to pass.

> PatchSlim is an early preview. Its result is evidence from the checks you
> provide, not proof of behavioral equivalence. Review every candidate patch.

## How it works

PatchSlim builds each candidate from:

```text
merge base + protected changes + selected reducible changes
```

Before minimizing anything, it verifies that the configured oracle:

1. passes on the full branch;
2. fails when only protected changes remain.

That second check catches weak tests before they can produce an empty or
misleading patch. Candidates are evaluated in an isolated Git worktree, so the
original checkout is left alone.

By default, tests, fixtures, snapshots, migrations, CI configuration, package
manifests, and lockfiles are protected. Reports and candidate patches are stored
under `.git/patchslim/runs/`.

## Install from source

PatchSlim requires Node.js 20 or newer and pnpm.

```bash
git clone https://github.com/Apex-Studio-He/patchslim.git
cd patchslim
pnpm install
pnpm build
npm link
```

Confirm the command is available from another directory:

```bash
patchslim --json doctor
```

## Quick start

Inspect the diff and default protection rules:

```bash
patchslim inspect --base main
```

Minimize it with a feature-specific test:

```bash
patchslim minimize \
  --base main \
  --oracle "pnpm vitest run src/auth/login.test.ts" \
  --quick "pnpm typecheck" \
  --gate "pnpm test"
```

PatchSlim writes two patches:

- `apply.patch` transforms the original head into the minimized result;
- `candidate.patch` recreates the minimized result from the merge base.

To slim the current branch, inspect `apply.patch` before applying it:

```bash
git apply --check /path/to/apply.patch
git apply /path/to/apply.patch
```

It never applies the candidate to your current checkout automatically.

## Configuration

Run `patchslim init` to create `.patchslim.yml`:

```yaml
base: main
oracle: pnpm vitest run src/auth/login.test.ts
quick:
  - pnpm typecheck
gates:
  - pnpm test
runs: 2
budget: 30m
timeout: 10m
protect:
  - src/auth/fixtures/**
```

Command-line options override configuration values. Run
`patchslim minimize --help` for the complete option list.

## Choosing an oracle

The oracle defines what “still works” means. Prefer the narrowest deterministic
check that captures the intended behavior:

- a focused regression test;
- a package-level test suite;
- a reproducible script that exits non-zero when behavior is missing.

Avoid broad checks that pass both before and after the feature, unstable tests,
and commands that modify external systems. Use `--runs` to repeat the oracle
when occasional flakiness is a concern.

## Protected files

Protection is a safety boundary, not an optimization hint. Protected changes are
included in every candidate and are never offered to the reducer.

Add repository-specific patterns with repeated `--protect` flags or the
configuration file. Use `--no-default-protect` only when you have reviewed the
consequences.

## JSON output

Every command supports `--json` for scripts and coding agents:

```bash
patchslim --json inspect --base main
patchslim --json minimize --oracle "pnpm test"
patchslim --json report .git/patchslim/runs/<run-id>/report.json
```

Successful responses use `{ "ok": true, "command": "...", "data": ... }`.
Failures use `{ "ok": false, "error": { "code": "...", "message": "..." } }`
and a non-zero exit status.

## Security

PatchSlim executes repository-provided commands and checks out repository
content in a temporary worktree. Run it only in repositories you trust. See
[SECURITY.md](SECURITY.md) for details.

## Current limitations

- Only committed changes between the base and head revisions are minimized.
- Renames, binary files, and protected paths are treated as atomic changes.
- The reducer seeks a locally minimal passing patch; it does not guarantee the
  globally smallest patch.
- Test coverage and oracle quality determine the quality of the result.
- Ignored directories created by `setup` are preserved between candidates.
  Disable mutable caches inside dependency directories when reproducibility is
  critical.

## Development

```bash
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

## License

MIT
