# Contributing

Thanks for taking the time to improve PatchSlim.

## Development setup

PatchSlim requires Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm check
```

Keep pull requests focused. Include tests for behavior changes and explain any
change to candidate construction, protection rules, or command execution.

## Safety invariants

Changes to the reducer must preserve these guarantees:

- the user's current checkout is never reset or cleaned;
- candidate evaluation happens in a temporary worktree;
- protected changes remain in every candidate;
- minimization stops when the full branch fails or the protected-only baseline
  passes;
- a candidate is never applied automatically;
- command output remains bounded and machine-readable output remains stable.

Use temporary repositories in tests for Git behavior. Tests must not rely on a
developer's global Git configuration or modify repositories outside their own
temporary directory.

## Commit and pull request style

Write short, imperative commit subjects. In the pull request, describe the
observable behavior, the checks you ran, and any known limitation.
