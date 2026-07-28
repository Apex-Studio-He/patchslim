# Security

## Trust model

PatchSlim is a local developer tool. It executes the setup, oracle, quick-check,
and gate commands configured by a repository. It also checks out repository
content into a temporary Git worktree.

Run PatchSlim only against repositories and revisions you trust. Reviewing a
branch with PatchSlim has similar code-execution risk to installing its
dependencies and running its test suite.

PatchSlim filters common secret-like environment variable names before spawning
commands, but this is defense in depth rather than a sandbox. Commands still
run with the current user's filesystem and network permissions.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
security advisory page. Include a minimal reproduction, affected version, and
the impact you observed. Avoid opening a public issue before a fix is available.
