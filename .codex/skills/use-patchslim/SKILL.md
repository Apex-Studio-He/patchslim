---
name: use-patchslim
description: Inspect and minimize committed Git branch diffs with the PatchSlim CLI while preserving protected tests and configured checks. Use when a user asks to shrink a large pull request, remove unnecessary branch changes, test whether diff hunks are required, or review a PatchSlim report.
---

# Use PatchSlim

Verify the installation and repository before minimizing:

```bash
command -v patchslim
patchslim --json doctor
patchslim --json inspect --base main
```

Do not start minimization until the user has identified a feature-specific
oracle. Prefer a targeted check that fails at the base revision and passes at
the branch head.

Run the reducer with layered checks:

```bash
patchslim --json minimize \
  --base main \
  --oracle "pnpm vitest run path/to/regression.test.ts" \
  --quick "pnpm typecheck" \
  --gate "pnpm test"
```

After completion:

1. Read the generated JSON report.
2. Inspect the candidate patch.
3. Run `git apply --check <apply.patch>` against the original head.
4. Explain that the result is oracle-backed evidence, not proof of equivalence.

Follow these rules:

- Prefer `--json` for stable output.
- Keep tests, fixtures, migrations, lockfiles, and CI configuration protected
  unless the user explicitly changes that boundary.
- Do not apply, commit, push, or open a pull request unless the user asks.
- Do not run PatchSlim against untrusted repository content.
- Stop when the oracle is weak, unstable, or produces an unexpected baseline
  result.
