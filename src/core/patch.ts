import { createHash } from "node:crypto";

import { minimatch } from "minimatch";

import { CliError } from "./errors.js";
import type { ChangeStatus, DiffStats, FileChange, Hunk } from "./types.js";

export const DEFAULT_PROTECT_PATTERNS = [
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/*test.*",
  "**/*spec.*",
  "**/__snapshots__/**",
  "**/fixtures/**",
  "**/migrations/**",
  "**/.patchslim.yml",
  "**/.gitignore",
  "**/.gitattributes",
  "**/.gitmodules",
  "docs/**",
  ".github/**",
  "**/*.md",
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/uv.lock",
  "**/go.mod",
  "**/go.sum",
  "**/Cargo.toml",
  "**/Cargo.lock",
];

interface NameStatusEntry {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
}

export function parseChanges(
  diff: string,
  nameStatus: string,
  protectPatterns: string[],
): FileChange[] {
  const blocks = splitDiffBlocks(diff);
  const entries = parseNameStatus(nameStatus);

  if (blocks.length !== entries.length) {
    throw new CliError(
      "DIFF_PARSE_FAILED",
      `Git returned ${blocks.length} patch blocks and ${entries.length} name-status entries.`,
    );
  }

  return blocks.map((raw, order) => {
    const entry = entries[order];
    if (!entry) {
      throw new CliError("DIFF_PARSE_FAILED", "Missing name-status entry.");
    }

    const { header, hunks } = parseHunks(raw, entry.path);
    const binary = /(?:^|\n)(?:GIT binary patch|Binary files )/.test(raw);
    const specialHeader =
      /(?:^|\n)(?:old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Submodule )/.test(
        header,
      );
    const atomic =
      entry.status !== "modified" ||
      binary ||
      specialHeader ||
      hunks.length === 0;
    const protectedPath = [entry.path, entry.oldPath]
      .filter((candidate): candidate is string => candidate !== undefined)
      .map((candidate) => ({
        path: candidate,
        pattern: protectPatterns.find((pattern) =>
          minimatch(candidate, pattern, {
            dot: true,
            matchBase: pattern.includes("/") === false,
          }),
        ),
      }))
      .find((match) => match.pattern !== undefined);
    const protectedChange = protectedPath !== undefined;
    const stats = statsFromPatch(raw);

    return {
      id: `file:${order}:${entry.path}`,
      order,
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      raw,
      header,
      hunks,
      binary,
      atomic,
      protected: protectedChange,
      ...(protectedPath?.pattern
        ? {
            protectReason: `matched protect pattern "${protectedPath.pattern}"${protectedPath.path === entry.path ? "" : ` on original path "${protectedPath.path}"`}`,
          }
        : {}),
      additions: stats.additions,
      deletions: stats.deletions,
    };
  });
}

export function buildFileCandidate(
  changes: FileChange[],
  selectedFileIds: ReadonlySet<string>,
): string {
  return changes
    .filter((change) => change.protected || selectedFileIds.has(change.id))
    .map((change) => ensureTrailingNewline(change.raw))
    .join("");
}

export function atomIdsForFiles(
  changes: FileChange[],
  selectedFileIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];

  for (const change of changes) {
    if (change.protected || !selectedFileIds.has(change.id)) {
      continue;
    }

    if (change.atomic || change.hunks.length <= 1) {
      ids.push(change.id);
    } else {
      ids.push(...change.hunks.map((hunk) => hunk.id));
    }
  }

  return ids;
}

export function buildAtomCandidate(
  changes: FileChange[],
  selectedAtomIds: ReadonlySet<string>,
): string {
  const parts: string[] = [];

  for (const change of changes) {
    if (change.protected) {
      parts.push(ensureTrailingNewline(change.raw));
      continue;
    }

    if (change.atomic || change.hunks.length <= 1) {
      if (selectedAtomIds.has(change.id)) {
        parts.push(ensureTrailingNewline(change.raw));
      }
      continue;
    }

    const selectedHunks = change.hunks.filter((hunk) =>
      selectedAtomIds.has(hunk.id),
    );
    if (selectedHunks.length > 0) {
      parts.push(
        ensureTrailingNewline(
          `${change.header}${selectedHunks.map((hunk) => hunk.raw).join("")}`,
        ),
      );
    }
  }

  return parts.join("");
}

export function statsFromPatch(patch: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { files, additions, deletions };
}

export function hashCandidate(patch: string, commandsKey: string): string {
  return createHash("sha256")
    .update(patch)
    .update("\0")
    .update(commandsKey)
    .digest("hex");
}

function splitDiffBlocks(diff: string): string[] {
  if (diff.trim().length === 0) {
    return [];
  }

  const starts = [...diff.matchAll(/^diff --git /gm)].map(
    (match) => match.index,
  );
  if (starts.length === 0 || starts[0] !== 0) {
    throw new CliError(
      "DIFF_PARSE_FAILED",
      "Unified diff does not start with a Git file header.",
    );
  }

  return starts.map((start, index) =>
    diff.slice(start, starts[index + 1] ?? diff.length),
  );
}

function parseNameStatus(raw: string): NameStatusEntry[] {
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }

  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    let statusToken = tokens[index++] ?? "";
    let pathToken: string | undefined;

    const tabIndex = statusToken.indexOf("\t");
    if (tabIndex >= 0) {
      pathToken = statusToken.slice(tabIndex + 1);
      statusToken = statusToken.slice(0, tabIndex);
    }

    const code = statusToken[0] ?? "?";
    const status = mapStatus(code);
    if (code === "R" || code === "C") {
      const oldPath = pathToken ?? tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        throw new CliError(
          "DIFF_PARSE_FAILED",
          "Malformed rename/copy entry in git name-status output.",
        );
      }
      entries.push({ status, path: newPath, oldPath });
    } else {
      const path = pathToken ?? tokens[index++];
      if (!path) {
        throw new CliError(
          "DIFF_PARSE_FAILED",
          "Malformed entry in git name-status output.",
        );
      }
      entries.push({ status, path });
    }
  }

  return entries;
}

function parseHunks(
  raw: string,
  filePath: string,
): { header: string; hunks: Hunk[] } {
  const starts = [...raw.matchAll(/^@@ .*@@.*$/gm)].map((match) => match.index);
  if (starts.length === 0) {
    return { header: raw, hunks: [] };
  }

  const header = raw.slice(0, starts[0]);
  const hunks = starts.map((start, index) => {
    const hunkRaw = raw.slice(start, starts[index + 1] ?? raw.length);
    const firstNewline = hunkRaw.indexOf("\n");
    const hunkHeader =
      firstNewline >= 0 ? hunkRaw.slice(0, firstNewline) : hunkRaw;
    return {
      id: `hunk:${filePath}:${index}`,
      raw: hunkRaw,
      header: hunkHeader,
    };
  });
  return { header, hunks };
}

function mapStatus(code: string): ChangeStatus {
  switch (code) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
