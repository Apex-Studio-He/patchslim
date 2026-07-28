import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_PROTECT_PATTERNS, parseChanges } from "../src/core/patch.js";
import { git } from "./helpers.js";

describe("parseChanges", () => {
  it("keeps renames, binaries, modes, and protected paths atomic", () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-special-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "PatchSlim Tests"]);
    git(root, ["config", "user.email", "patchslim@example.invalid"]);
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "src", "old name.txt"), "hello\n", "utf8");
    writeFileSync(path.join(root, "src", "binary.dat"), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(root, "src", "script.sh"), "#!/bin/sh\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    renameSync(
      path.join(root, "src", "old name.txt"),
      path.join(root, "src", "new name.txt"),
    );
    writeFileSync(
      path.join(root, "src", "binary.dat"),
      Buffer.from([0, 9, 8, 7]),
    );
    chmodSync(path.join(root, "src", "script.sh"), 0o755);
    writeFileSync(path.join(root, "docs", "notes.md"), "keep this\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "special changes"]);
    const head = git(root, ["rev-parse", "HEAD"]);

    const diff = gitOutput(root, [
      "diff",
      "--binary",
      "--full-index",
      base,
      head,
      "--",
    ]);
    const nameStatus = gitOutput(root, [
      "diff",
      "--name-status",
      "-z",
      base,
      head,
      "--",
    ]);
    const changes = parseChanges(diff, nameStatus, DEFAULT_PROTECT_PATTERNS);

    expect(
      changes.find((change) => change.path === "src/new name.txt"),
    ).toMatchObject({
      oldPath: "src/old name.txt",
      status: "renamed",
      atomic: true,
    });
    expect(
      changes.find((change) => change.path === "src/binary.dat"),
    ).toMatchObject({
      binary: true,
      atomic: true,
    });
    expect(
      changes.find((change) => change.path === "src/script.sh"),
    ).toMatchObject({
      atomic: true,
    });
    expect(
      changes.find((change) => change.path === "docs/notes.md"),
    ).toMatchObject({
      protected: true,
      atomic: true,
    });
  });

  it("keeps a rename protected when its original path is protected", () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-rename-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "PatchSlim Tests"]);
    git(root, ["config", "user.email", "patchslim@example.invalid"]);
    mkdirSync(path.join(root, "tests"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "tests", "feature.test.mjs"),
      "test\n",
      "utf8",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    renameSync(
      path.join(root, "tests", "feature.test.mjs"),
      path.join(root, "src", "feature.mjs"),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "move test"]);
    const head = git(root, ["rev-parse", "HEAD"]);

    const diff = gitOutput(root, [
      "diff",
      "--binary",
      "--full-index",
      base,
      head,
      "--",
    ]);
    const nameStatus = gitOutput(root, [
      "diff",
      "--name-status",
      "-z",
      base,
      head,
      "--",
    ]);
    const changes = parseChanges(diff, nameStatus, DEFAULT_PROTECT_PATTERNS);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "src/feature.mjs",
      oldPath: "tests/feature.test.mjs",
      status: "renamed",
      atomic: true,
      protected: true,
    });
  });

  it("protects PatchSlim and Git control files by default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchslim-control-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "PatchSlim Tests"]);
    git(root, ["config", "user.email", "patchslim@example.invalid"]);
    writeFileSync(path.join(root, "source.txt"), "base\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    const controlFiles: Array<[string, string]> = [
      [".patchslim.yml", "oracle: node test.mjs\n"],
      [".gitignore", ".cache/\n"],
      [".gitattributes", "*.bin binary\n"],
      [".gitmodules", '[submodule "example"]\n'],
    ];
    for (const [file, content] of controlFiles) {
      writeFileSync(path.join(root, file), content, "utf8");
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add control files"]);
    const head = git(root, ["rev-parse", "HEAD"]);

    const changes = parseChanges(
      gitOutput(root, ["diff", "--binary", "--full-index", base, head, "--"]),
      gitOutput(root, ["diff", "--name-status", "-z", base, head, "--"]),
      DEFAULT_PROTECT_PATTERNS,
    );

    expect(changes.map((change) => change.path)).toEqual([
      ".gitattributes",
      ".gitignore",
      ".gitmodules",
      ".patchslim.yml",
    ]);
    expect(changes.every((change) => change.protected)).toBe(true);
  });
});

function gitOutput(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
