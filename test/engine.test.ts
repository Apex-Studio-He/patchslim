import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { commandSpec } from "../src/core/commands.js";
import { minimize } from "../src/core/engine.js";
import { DEFAULT_PROTECT_PATTERNS } from "../src/core/patch.js";
import {
  createFixtureRepository,
  createPythonFixtureRepository,
  git,
} from "./helpers.js";

describe("minimize", () => {
  it("removes a redundant file and redundant hunk while preserving tests", async () => {
    const fixture = createFixtureRepository();
    writeFileSync(path.join(fixture.root, "notes.local"), "keep me\n", "utf8");
    const statusBefore = git(fixture.root, ["status", "--porcelain=v1", "-z"]);
    const mutatingGate =
      '(async()=>{const fs=require("node:fs");const {triple}=await import("./src/math.mjs");if(triple(3)!==9)process.exit(1);fs.appendFileSync("src/math.mjs","\\n// gate output\\n")})()';
    const report = await minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec("node tests/feature.test.mjs", 10_000),
      quickGates: [],
      fullGates: [commandSpec([process.execPath, "-e", mutatingGate], 10_000)],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
    });

    expect(report.status).toBe("completed");
    expect(report.before).toEqual({ files: 4, additions: 8, deletions: 3 });
    expect(report.after).toEqual({ files: 2, additions: 6, deletions: 2 });
    expect(report.reduction?.removedFiles).toContain("src/redundant.mjs");
    expect(report.reduction?.removedFiles).toContain("src/data.bin");
    expect(report.reduction?.removedHunks).toContain("hunk:src/math.mjs:1");
    expect(report.reduction?.keptHunks).toContain("hunk:src/math.mjs:0");
    expect(report.validation?.results).toHaveLength(3);
    expect(report.preflight.headGateRuns).toHaveLength(1);
    expect(report.protected.map((item) => item.path)).toContain(
      "tests/feature.test.mjs",
    );

    const patch = readFileSync(report.artifacts.patch!, "utf8");
    expect(patch).toContain("return value * 3");
    expect(patch).not.toContain("src/redundant.mjs");
    expect(patch).not.toContain("return String(value)");
    expect(patch).not.toContain("gate output");
    const applyPatch = readFileSync(report.artifacts.applyPatch!, "utf8");
    expect(applyPatch).toContain("src/redundant.mjs");
    expect(applyPatch).not.toContain("return value * 2");

    const applyParent = mkdtempSync(path.join(tmpdir(), "patchslim-apply-"));
    const applyWorktree = path.join(applyParent, "checkout");
    git(fixture.root, [
      "worktree",
      "add",
      "--detach",
      applyWorktree,
      fixture.headSha,
    ]);
    try {
      git(applyWorktree, ["apply", "--check", report.artifacts.applyPatch!]);
      git(applyWorktree, ["apply", "--index", report.artifacts.applyPatch!]);
      execFileSync(process.execPath, ["tests/feature.test.mjs"], {
        cwd: applyWorktree,
        stdio: "pipe",
      });
      expect(
        git(applyWorktree, [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          fixture.baseSha,
          "--",
        ]),
      ).toBe(patch.trim());
    } finally {
      git(fixture.root, ["worktree", "remove", "--force", applyWorktree]);
    }

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

  it("preserves setup dependencies while clearing ignored oracle output", async () => {
    const fixture = createFixtureRepository();
    const setupScript =
      'const fs=require("node:fs");fs.mkdirSync(".deps",{recursive:true});fs.writeFileSync(".deps/ready","yes")';
    const oracleScript =
      '(async()=>{const fs=require("node:fs");if(!fs.existsSync(".deps/ready"))process.exit(2);const {triple}=await import("./src/math.mjs");if(triple(3)===9){fs.mkdirSync(".oracle-cache",{recursive:true});fs.writeFileSync(".oracle-cache/pass","yes");process.exit(0)}process.exit(fs.existsSync(".oracle-cache/pass")?0:1)})()';

    const report = await minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec([process.execPath, "-e", oracleScript], 10_000),
      setup: commandSpec([process.execPath, "-e", setupScript], 10_000),
      quickGates: [],
      fullGates: [],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
    });

    expect(report.status).toBe("completed");
    expect(report.reduction?.keptHunks).toContain("hunk:src/math.mjs:0");
  });

  it("isolates quick-gate side effects from the oracle", async () => {
    const fixture = createFixtureRepository();
    const quickScript =
      'const fs=require("node:fs");fs.mkdirSync(".oracle-cache",{recursive:true});fs.writeFileSync(".oracle-cache/pass","yes")';
    const oracleScript =
      '(async()=>{const fs=require("node:fs");const {triple}=await import("./src/math.mjs");process.exit(triple(3)===9||fs.existsSync(".oracle-cache/pass")?0:1)})()';
    const report = await minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec([process.execPath, "-e", oracleScript], 10_000),
      quickGates: [commandSpec([process.execPath, "-e", quickScript], 10_000)],
      fullGates: [],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
    });

    expect(report.status).toBe("completed");
    expect(report.reduction?.keptHunks).toContain("hunk:src/math.mjs:0");
  });

  it("minimizes a Python change with the same language-agnostic engine", async () => {
    const fixture = createPythonFixtureRepository();
    const report = await minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec("python3 tests/feature_test.py", 10_000),
      quickGates: [],
      fullGates: [],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
    });

    expect(report.status).toBe("completed");
    expect(report.reduction?.removedFiles).toContain("src/redundant.py");
    expect(readFileSync(report.artifacts.patch!, "utf8")).not.toContain(
      "return str(value)",
    );
  });

  it("rejects setup commands that leave unignored files behind", async () => {
    const fixture = createFixtureRepository();

    await expect(
      minimize({
        cwd: fixture.root,
        baseRef: fixture.baseSha,
        headRef: fixture.headSha,
        oracle: commandSpec("node tests/feature.test.mjs", 10_000),
        setup: commandSpec(
          [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync("setup-output.txt","dirty")',
          ],
          10_000,
        ),
        quickGates: [],
        fullGates: [],
        protectPatterns: DEFAULT_PROTECT_PATTERNS,
        runs: 2,
        budgetMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "SETUP_DIRTY",
    });
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

  it("fails closed when protected-base runs are unstable", async () => {
    const fixture = createFixtureRepository();
    const stateFile = path.join(
      mkdtempSync(path.join(tmpdir(), "patchslim-base-oracle-")),
      "runs",
    );
    const script = `const fs=require("node:fs");const p=${JSON.stringify(stateFile)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));process.exit(n<2?0:n===2?1:0)`;

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
      code: "BASE_ORACLE_UNSTABLE",
    });
    expect(readFileSync(stateFile, "utf8")).toBe("4");
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });

  it("fails before reduction when a configured gate is already red", async () => {
    const fixture = createFixtureRepository();

    await expect(
      minimize({
        cwd: fixture.root,
        baseRef: fixture.baseSha,
        headRef: fixture.headSha,
        oracle: commandSpec("node tests/feature.test.mjs", 10_000),
        quickGates: [],
        fullGates: [commandSpec('node -e "process.exit(1)"', 10_000)],
        protectPatterns: DEFAULT_PROTECT_PATTERNS,
        runs: 2,
        budgetMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "HEAD_GATE_FAILED",
    });
  });

  it("cleans up its worktree when interrupted", async () => {
    const fixture = createFixtureRepository();
    const controller = new AbortController();
    const reduction = minimize({
      cwd: fixture.root,
      baseRef: fixture.baseSha,
      headRef: fixture.headSha,
      oracle: commandSpec(
        [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
        20_000,
      ),
      quickGates: [],
      fullGates: [],
      protectPatterns: DEFAULT_PROTECT_PATTERNS,
      runs: 2,
      budgetMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);

    await expect(reduction).rejects.toMatchObject({
      code: "INTERRUPTED",
    });
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });

  it("stops clearly when every change is protected", async () => {
    const fixture = createFixtureRepository();
    mkdirSync(path.join(fixture.root, "docs"), { recursive: true });
    writeFileSync(
      path.join(fixture.root, "docs", "usage.md"),
      "documentation only\n",
      "utf8",
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "document usage"]);
    const docsHead = git(fixture.root, ["rev-parse", "HEAD"]);

    await expect(
      minimize({
        cwd: fixture.root,
        baseRef: fixture.headSha,
        headRef: docsHead,
        oracle: commandSpec("node tests/feature.test.mjs", 10_000),
        quickGates: [],
        fullGates: [],
        protectPatterns: DEFAULT_PROTECT_PATTERNS,
        runs: 2,
        budgetMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "NO_REDUCIBLE_CHANGES",
    });
  });
});
