import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliError } from "./errors.js";
import type { RunReport } from "./types.js";

export async function writeRunReport(report: RunReport): Promise<void> {
  await writeFile(
    report.artifacts.reportJson,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  if (report.artifacts.reportMarkdown) {
    await writeFile(
      report.artifacts.reportMarkdown,
      renderMarkdownReport(report),
      "utf8",
    );
  }
}

export async function readRunReport(reportPath: string): Promise<RunReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new CliError("REPORT_READ_FAILED", `Cannot read ${reportPath}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isRunReport(parsed)) {
    throw new CliError(
      "REPORT_INVALID",
      `${reportPath} is not a supported PatchSlim report.`,
    );
  }

  return parsed as RunReport;
}

function isRunReport(value: unknown): value is RunReport {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  if (
    value.schemaVersion !== 1 ||
    (status !== "completed" && status !== "failed") ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.startedAt) ||
    !isNonEmptyString(value.completedAt) ||
    !isRepository(value.repository) ||
    !isDiffStats(value.before) ||
    !Array.isArray(value.protected) ||
    !value.protected.every(
      (entry) =>
        isRecord(entry) &&
        isNonEmptyString(entry.path) &&
        isNonEmptyString(entry.reason),
    ) ||
    !isPreflight(value.preflight) ||
    !isArtifacts(value.artifacts)
  ) {
    return false;
  }

  if (status === "completed") {
    return (
      isDiffStats(value.after) &&
      isRecord(value.reduction) &&
      isRecord(value.validation)
    );
  }

  return (
    isRecord(value.error) &&
    isNonEmptyString(value.error.code) &&
    isNonEmptyString(value.error.message)
  );
}

function isRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["root", "commonGitDir", "baseRef", "baseSha", "headRef", "headSha"].every(
      (key) => isNonEmptyString(value[key]),
    )
  );
}

function isDiffStats(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["files", "additions", "deletions"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isInteger(value[key]) &&
        Number(value[key]) >= 0,
    )
  );
}

function isPreflight(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.headRuns) &&
    Array.isArray(value.headGateRuns) &&
    (value.baseRuns === undefined || Array.isArray(value.baseRuns)) &&
    typeof value.passed === "boolean"
  );
}

function isArtifacts(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.directory) &&
    isNonEmptyString(value.reportJson) &&
    ["patch", "applyPatch", "reportMarkdown"].every(
      (key) => value[key] === undefined || isNonEmptyString(value[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function renderHumanSummary(report: RunReport): string {
  if (report.status === "failed") {
    return [
      "PatchSlim stopped without producing a candidate.",
      "",
      `${report.error?.code ?? "FAILED"}: ${report.error?.message ?? "Unknown error"}`,
      `Report: ${report.artifacts.reportJson}`,
    ].join("\n");
  }

  const after = report.after;
  const reduction = report.reduction;
  const changedLinesBefore = report.before.additions + report.before.deletions;
  const changedLinesAfter = after ? after.additions + after.deletions : 0;
  return [
    "PatchSlim completed",
    "",
    `Original:  ${formatStats(report.before)}`,
    `Candidate: ${after ? formatStats(after) : "n/a"}`,
    `Smaller by: ${Math.max(0, report.before.files - (after?.files ?? 0))} files, ${Math.max(0, changedLinesBefore - changedLinesAfter)} changed lines`,
    "",
    `Oracle evaluations: ${(reduction?.fileEvaluations ?? 0) + (reduction?.hunkEvaluations ?? 0)}`,
    `Cache hits:         ${reduction?.cacheHits ?? 0}`,
    "",
    `Apply to HEAD:   ${report.artifacts.applyPatch ?? "n/a"}`,
    `Candidate patch: ${report.artifacts.patch ?? "n/a"}`,
    `Report:          ${report.artifacts.reportMarkdown ?? report.artifacts.reportJson}`,
  ].join("\n");
}

export function renderMarkdownReport(report: RunReport): string {
  const lines = [
    "# PatchSlim report",
    "",
    `Status: **${report.status}**`,
    "",
    "## Scope",
    "",
    `- Base: \`${report.repository.baseRef}\` (\`${report.repository.baseSha.slice(0, 12)}\`)`,
    `- Head: \`${report.repository.headRef}\` (\`${report.repository.headSha.slice(0, 12)}\`)`,
    `- Original: ${formatStats(report.before)}`,
  ];

  if (report.after) {
    lines.push(`- Candidate: ${formatStats(report.after)}`);
  }

  if (report.protected.length > 0) {
    lines.push("", "## Protected changes", "");
    for (const item of report.protected) {
      lines.push(`- \`${item.path}\`: ${item.reason}`);
    }
  }

  if (report.reduction) {
    lines.push(
      "",
      "## Reduction",
      "",
      `- File evaluations: ${report.reduction.fileEvaluations}`,
      `- Hunk evaluations: ${report.reduction.hunkEvaluations}`,
      `- Cache hits: ${report.reduction.cacheHits}`,
      `- Removed files: ${report.reduction.removedFiles.length}`,
      `- Removed hunks: ${report.reduction.removedHunks.length}`,
    );
  }

  if (report.status === "completed") {
    lines.push(
      "",
      "## Artifacts",
      "",
      `- Apply to the original head: \`${report.artifacts.applyPatch ?? "n/a"}\``,
      `- Recreate the candidate from the base: \`${report.artifacts.patch ?? "n/a"}\``,
    );
  }

  if (report.error) {
    lines.push(
      "",
      "## Failure",
      "",
      `**${report.error.code}**: ${report.error.message}`,
    );
  }

  lines.push(
    "",
    "## Interpretation",
    "",
    report.status === "completed"
      ? "The candidate passed the configured oracle and gates. This is evidence relative to those checks, not a proof of complete behavioral equivalence."
      : "PatchSlim stopped before producing a validated candidate. Review the failure above before trying another run.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

export function reportPaths(directory: string): {
  patch: string;
  applyPatch: string;
  reportJson: string;
  reportMarkdown: string;
} {
  return {
    patch: path.join(directory, "candidate.patch"),
    applyPatch: path.join(directory, "apply.patch"),
    reportJson: path.join(directory, "report.json"),
    reportMarkdown: path.join(directory, "report.md"),
  };
}

function formatStats(stats: {
  files: number;
  additions: number;
  deletions: number;
}): string {
  return `${stats.files} files, +${stats.additions}/-${stats.deletions}`;
}
