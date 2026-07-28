import { describe, expect, it } from "vitest";

import { renderMarkdownReport } from "../src/core/report.js";
import type { RunReport } from "../src/core/types.js";

describe("renderMarkdownReport", () => {
  it("does not describe a failed run as a passing candidate", () => {
    const report: RunReport = {
      schemaVersion: 1,
      runId: "example",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      repository: {
        root: "/repo",
        commonGitDir: "/repo/.git",
        baseRef: "main",
        baseSha: "a".repeat(40),
        headRef: "HEAD",
        headSha: "b".repeat(40),
      },
      before: { files: 1, additions: 1, deletions: 0 },
      protected: [],
      preflight: { headRuns: [], headGateRuns: [], passed: false },
      artifacts: {
        directory: "/repo/.git/patchslim/runs/example",
        reportJson: "/repo/.git/patchslim/runs/example/report.json",
      },
      error: {
        code: "WEAK_ORACLE",
        message: "The oracle also passed on the base candidate.",
      },
    };

    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain(
      "stopped before producing a validated candidate",
    );
    expect(markdown).not.toContain("candidate passed");
  });
});
