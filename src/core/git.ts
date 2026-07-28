import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CliError } from "./errors.js";
import type { RepositoryInfo } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface RepositorySnapshot {
  info: RepositoryInfo;
  diff: string;
  nameStatus: string;
  originalStatus: string;
}

export interface TemporaryWorktree {
  parent: string;
  path: string;
}

export async function inspectRepository(
  cwd: string,
  baseRef: string | undefined,
  headRef: string,
): Promise<RepositorySnapshot> {
  const root = await gitText(["rev-parse", "--show-toplevel"], cwd);
  const resolvedBase = baseRef ?? (await detectDefaultBase(root));
  const baseSha = await gitText(
    ["merge-base", resolvedBase, headRef],
    root,
  ).catch(() => {
    throw new CliError(
      "INVALID_BASE",
      `Cannot find a merge base between "${resolvedBase}" and "${headRef}".`,
    );
  });
  const headSha = await gitText(["rev-parse", `${headRef}^{commit}`], root);
  const commonGitDirRaw = await gitText(
    ["rev-parse", "--git-common-dir"],
    root,
  );
  const commonGitDir = path.resolve(root, commonGitDirRaw);

  const [diff, nameStatus, originalStatus] = await Promise.all([
    gitRaw(
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        baseSha,
        headSha,
        "--",
      ],
      root,
    ),
    gitRaw(["diff", "--name-status", "-z", baseSha, headSha, "--"], root),
    gitRaw(["status", "--porcelain=v1", "-z"], root),
  ]);

  return {
    info: {
      root,
      commonGitDir,
      baseRef: resolvedBase,
      baseSha,
      headRef,
      headSha,
    },
    diff,
    nameStatus,
    originalStatus,
  };
}

export async function createTemporaryWorktree(
  repository: RepositoryInfo,
): Promise<TemporaryWorktree> {
  const parent = await mkdtemp(path.join(tmpdir(), "patchslim-"));
  const worktreePath = path.join(parent, "candidate");
  try {
    await gitText(
      ["worktree", "add", "--detach", worktreePath, repository.baseSha],
      repository.root,
    );
    return { parent, path: worktreePath };
  } catch (error) {
    validateTemporaryParent(parent);
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

export async function removeTemporaryWorktree(
  repositoryRoot: string,
  worktree: TemporaryWorktree,
): Promise<void> {
  validateTemporaryParent(worktree.parent);
  await gitRaw(
    ["worktree", "remove", "--force", worktree.path],
    repositoryRoot,
  ).catch(() => "");
  await rm(worktree.parent, { recursive: true, force: true });
}

export async function materializePatch(
  repository: RepositoryInfo,
  worktree: TemporaryWorktree,
  patch: string,
): Promise<void> {
  await gitText(["reset", "--hard", repository.baseSha], worktree.path);
  await gitText(["clean", "-ffd"], worktree.path);

  if (patch.length === 0) {
    return;
  }

  const patchPath = path.join(worktree.parent, "candidate.patch");
  await writeFile(patchPath, patch, "utf8");
  try {
    await gitText(
      ["apply", "--index", "--recount", "--whitespace=nowarn", patchPath],
      worktree.path,
    );
  } catch (error) {
    throw new CliError(
      "PATCH_APPLY_FAILED",
      "A candidate patch could not be applied to the merge base.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function stagedPatch(
  repository: RepositoryInfo,
  worktreePath: string,
): Promise<string> {
  return await gitRaw(
    ["diff", "--cached", "--binary", "--full-index", repository.baseSha, "--"],
    worktreePath,
  );
}

export async function createRunDirectory(
  repository: RepositoryInfo,
  runId: string,
  requested?: string,
): Promise<string> {
  const directory = requested
    ? path.resolve(repository.root, requested)
    : path.join(repository.commonGitDir, "patchslim", "runs", runId);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function gitVersion(): Promise<string | undefined> {
  try {
    return await gitText(["--version"], process.cwd());
  } catch {
    return undefined;
  }
}

export async function findRepositoryRoot(
  cwd: string,
): Promise<string | undefined> {
  try {
    return await gitText(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return undefined;
  }
}

async function detectDefaultBase(root: string): Promise<string> {
  const candidates: string[] = [];

  try {
    const remoteHead = await gitText(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      root,
    );
    candidates.push(remoteHead);
  } catch {
    // A repository does not need a configured remote.
  }

  candidates.push("main", "master", "HEAD^");
  for (const candidate of candidates) {
    try {
      await gitText(["rev-parse", "--verify", `${candidate}^{commit}`], root);
      return candidate;
    } catch {
      // Try the next conventional base.
    }
  }

  throw new CliError(
    "BASE_REQUIRED",
    "PatchSlim could not detect a base revision. Pass --base <ref>.",
  );
}

async function gitText(args: string[], cwd: string): Promise<string> {
  return (await gitRaw(args, cwd)).trim();
}

async function gitRaw(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return stdout;
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error
        ? String((error as Error & { stderr?: string }).stderr ?? error.message)
        : String(error);
    throw new CliError("GIT_ERROR", message.trim() || "Git command failed.", {
      args,
      cwd,
    });
  }
}

function validateTemporaryParent(parent: string): void {
  const resolved = path.resolve(parent);
  const expectedRoot = `${path.resolve(tmpdir())}${path.sep}`;
  if (
    !resolved.startsWith(expectedRoot) ||
    !path.basename(resolved).startsWith("patchslim-")
  ) {
    throw new CliError(
      "UNSAFE_TEMP_PATH",
      `Refusing to remove unexpected temporary path: ${resolved}`,
    );
  }
}
