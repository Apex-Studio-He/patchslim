import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findConfigPath, resolveSettings } from "../src/core/config.js";

describe("resolveSettings", () => {
  it("loads structured commands and lets command-line values take precedence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-config-"));
    writeFileSync(
      path.join(root, ".patchslim.yml"),
      `base: develop
head: feature
oracle:
  command: [node, test.mjs]
  timeout: 12s
quickGates:
  - command: [node, quick.mjs]
    timeout: 3s
fullGates:
  - node full.mjs
protect:
  - generated/**
runs: 3
budget: 8m
expectedBaseFailure: missing feature
`,
      "utf8",
    );

    const settings = await resolveSettings({
      cwd: root,
      oracle: "node override.mjs",
      quickGates: [],
      fullGates: [],
      protectPatterns: ["vendor/**"],
      includeDefaultProtect: false,
      runs: 4,
      timeout: "20s",
    });

    expect(settings.baseRef).toBe("develop");
    expect(settings.headRef).toBe("feature");
    expect(settings.oracle).toEqual({
      command: "node override.mjs",
      timeoutMs: 20_000,
    });
    expect(settings.quickGates).toEqual([
      { command: ["node", "quick.mjs"], timeoutMs: 3_000 },
    ]);
    expect(settings.fullGates).toEqual([
      { command: "node full.mjs", timeoutMs: 20_000 },
    ]);
    expect(settings.protectPatterns).toEqual(["generated/**", "vendor/**"]);
    expect(settings.runs).toBe(4);
    expect(settings.budgetMs).toBe(480_000);
    expect(settings.expectedBaseFailure?.test("missing feature")).toBe(true);
  });

  it("rejects an invalid expected failure expression", async () => {
    await expect(
      resolveSettings({
        cwd: process.cwd(),
        oracle: "node test.mjs",
        quickGates: [],
        fullGates: [],
        protectPatterns: [],
        includeDefaultProtect: false,
        expectedBaseFailure: "[",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_FAILURE_PATTERN",
    });
  });

  it("discovers the nearest configuration from a nested directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-config-"));
    const nested = path.join(root, "packages", "example");
    mkdirSync(nested, { recursive: true });
    const configPath = path.join(root, ".patchslim.yml");
    writeFileSync(configPath, "oracle: node test.mjs\n", "utf8");

    await expect(findConfigPath(nested)).resolves.toBe(configPath);
  });

  it("reports an explicitly requested missing configuration", async () => {
    await expect(
      resolveSettings({
        cwd: process.cwd(),
        configPath: "missing.patchslim.yml",
        quickGates: [],
        fullGates: [],
        protectPatterns: [],
        includeDefaultProtect: false,
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_READ_FAILED",
    });
  });

  it("uses the CLI timeout as the default for setup commands", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-config-"));
    writeFileSync(
      path.join(root, ".patchslim.yml"),
      `oracle: node test.mjs
setup:
  command: [pnpm, install]
`,
      "utf8",
    );

    const settings = await resolveSettings({
      cwd: root,
      quickGates: [],
      fullGates: [],
      protectPatterns: [],
      includeDefaultProtect: false,
      timeout: "20s",
    });

    expect(settings.setup?.timeoutMs).toBe(20_000);
  });

  it.each([
    ["an unsupported version", "version: 2\noracle: node test.mjs\n"],
    [
      "an unknown field",
      "version: 1\noracle: node test.mjs\nquickGate: node quick.mjs\n",
    ],
  ])("rejects %s", async (_label, content) => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-config-"));
    writeFileSync(path.join(root, ".patchslim.yml"), content, "utf8");

    await expect(
      resolveSettings({
        cwd: root,
        quickGates: [],
        fullGates: [],
        protectPatterns: [],
        includeDefaultProtect: false,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});
