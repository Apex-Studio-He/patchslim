import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFixtureRepository, git } from "./helpers.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(projectRoot, "src", "cli.ts");

describe("PatchSlim CLI", () => {
  it("emits stable JSON for init dry runs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-cli-"));
    const result = runCli(["--json", "-C", root, "init", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "init",
      data: {
        path: path.join(root, ".patchslim.yml"),
        written: false,
      },
    });
  });

  it("returns a structured error for malformed reports", () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-cli-"));
    writeFileSync(
      path.join(root, "broken.json"),
      JSON.stringify({ schemaVersion: 1, status: "completed" }),
      "utf8",
    );
    const result = runCli(["--json", "-C", root, "report", "broken.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "REPORT_INVALID",
      },
    });
  });

  it("inspects committed paths containing spaces and Unicode", () => {
    const fixture = createFixtureRepository();
    const relativePath = "src/with space ü.mjs";
    writeFileSync(
      path.join(fixture.root, relativePath),
      "export const value = 1;\n",
      "utf8",
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "add unicode path"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);

    const result = runCli([
      "--json",
      "-C",
      fixture.root,
      "inspect",
      "--base",
      fixture.headSha,
      "--head",
      head,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "inspect",
      data: {
        stats: { files: 1, additions: 1, deletions: 0 },
        changes: [
          {
            path: relativePath,
            status: "added",
            protected: false,
          },
        ],
      },
    });
  });
});

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}
