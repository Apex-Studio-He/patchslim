import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { commandSpec } from "../src/core/commands.js";
import { minimize } from "../src/core/engine.js";
import { DEFAULT_PROTECT_PATTERNS } from "../src/core/patch.js";
import { createFixtureRepository, git } from "./helpers.js";

describe("minimize", () => {
  it("removes a redundant file and redundant hunk while preserving tests", async () => {
    const fixture = createFixtureRepository();
    writeFileSync(path.join(fixture.root, "notes.local"), "keep me\n", "utf8");
    const statusBefore = git(fixture.root, ["status", "--porcelain=v1", "-z"]);
    const report = await minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec("node tests/feature.test.mjs", 10_000),
      quickGates: [],
      fullGates: [commandSpec("node tests/feature.test.mjs", 10_000)],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
    });

    expect(report.status).toBe("completed");
    expect(report.reduction?.removedFiles).toContain("src/redundant.mjs");
    expect(report.reduction?.removedHunks).toContain("hunk:src/math.mjs:1");
    expect(report.reduction?.keptHunks).toContain("hunk:src/math.mjs:0");
    expect(report.validation?.results).toHaveLength(3);
    expect(report.protected.map((item) => item.path)).toContain(
      "tests/feature.test.mjs",
    );

    const patch = readFileSync(report.artifacts.patch!, "utf8");
    expect(patch).toContain("return value * 3");
    expect(patch).not.toContain("src/redundant.mjs");
    expect(patch).not.toContain("return String(value)");
    expect(git(fixture.root, ["status", "--porcelain=v1", "-z"])).toBe(
      statusBefore,
    );
    expect(readFileSync(path.join(fixture.root, "notes.local"), "utf8")).toBe(
      "keep me\n",
    );
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });

  it("fails closed when the oracle also passes without production changes", async () => {
    const fixture = createFixtureRepository();

    await expect(
      minimize({
        cwd: fixture.root,
        baseRef: fixture.baseSha,
        headRef: fixture.headSha,
        oracle: commandSpec('node -e "process.exit(0)"', 10_000),
        quickGates: [],
        fullGates: [],
        protectPatterns: DEFAULT_PROTECT_PATTERNS,
        runs: 2,
        budgetMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "WEAK_ORACLE",
    });
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });

  it("fails closed when repeated head runs are unstable", async () => {
    const fixture = createFixtureRepository();
    const stateFile = path.join(
      mkdtempSync(path.join(tmpdir(), "patchslim-oracle-")),
      "runs",
    );
    const script = `const fs=require("node:fs");const p=${JSON.stringify(stateFile)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));process.exit(n===0?0:1)`;

    await expect(
      minimize({
        cwd: fixture.root,
        baseRef: fixture.baseSha,
        headRef: fixture.headSha,
        oracle: commandSpec([process.execPath, "-e", script], 10_000),
        quickGates: [],
        fullGates: [],
        protectPatterns: DEFAULT_PROTECT_PATTERNS,
        runs: 2,
        budgetMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "HEAD_ORACLE_UNSTABLE",
    });
    expect(readFileSync(stateFile, "utf8")).toBe("2");
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });
});
