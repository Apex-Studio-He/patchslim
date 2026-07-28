import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureRepository {
  root: string;
  baseSha: string;
  headSha: string;
}

export function createFixtureRepository(): FixtureRepository {
  const root = mkdtempSync(path.join(tmpdir(), "patchslim-fixture-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "PatchSlim Tests"]);
  git(root, ["config", "user.email", "patchslim@example.invalid"]);

  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  write(root, ".gitignore", ".deps/\n.oracle-cache/\n");
  write(root, "src/math.mjs", baseMathSource());
  writeFileSync(path.join(root, "src", "data.bin"), Buffer.from([0, 1, 2]));
  write(root, "tests/feature.test.mjs", baseTestSource());
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial fixture"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);

  write(root, "src/math.mjs", headMathSource());
  writeFileSync(path.join(root, "src", "data.bin"), Buffer.from([0, 9, 8, 7]));
  write(root, "src/redundant.mjs", "export const noise = true;\n");
  write(root, "tests/feature.test.mjs", headTestSource());
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "add triple"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);

  return { root, baseSha, headSha };
}

export function createPythonFixtureRepository(): FixtureRepository {
  const root = mkdtempSync(path.join(tmpdir(), "patchslim-python-fixture-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "PatchSlim Tests"]);
  git(root, ["config", "user.email", "patchslim@example.invalid"]);

  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  write(
    root,
    "src/message.py",
    `def greet(name):
    return f"Hello, {name}"


padding01 = 1
padding02 = 2
padding03 = 3
padding04 = 4
padding05 = 5
padding06 = 6
padding07 = 7
padding08 = 8


def label(value):
    return value
`,
  );
  write(
    root,
    "tests/feature_test.py",
    `import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from src.message import greet

assert greet("Ada") == "Hello, Ada"
`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial fixture"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);

  write(
    root,
    "src/message.py",
    `def greet(name):
    return f"Hello, {name}!"


padding01 = 1
padding02 = 2
padding03 = 3
padding04 = 4
padding05 = 5
padding06 = 6
padding07 = 7
padding08 = 8


def label(value):
    return str(value)
`,
  );
  write(root, "src/redundant.py", "noise = True\n");
  write(
    root,
    "tests/feature_test.py",
    `import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from src.message import greet

assert greet("Ada") == "Hello, Ada!"
`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "add punctuation"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);

  return { root, baseSha, headSha };
}

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, relativePath: string, content: string): void {
  writeFileSync(path.join(root, relativePath), content, "utf8");
}

function baseMathSource(): string {
  return `export function double(value) {
  return value * 2;
}

export function triple(value) {
  return value * 2;
}

export const padding01 = 1;
export const padding02 = 2;
export const padding03 = 3;
export const padding04 = 4;
export const padding05 = 5;
export const padding06 = 6;
export const padding07 = 7;
export const padding08 = 8;

export function label(value) {
  return value;
}
`;
}

function headMathSource(): string {
  return `export function double(value) {
  return value * 2;
}

export function triple(value) {
  return value * 3;
}

export const padding01 = 1;
export const padding02 = 2;
export const padding03 = 3;
export const padding04 = 4;
export const padding05 = 5;
export const padding06 = 6;
export const padding07 = 7;
export const padding08 = 8;

export function label(value) {
  return String(value);
}
`;
}

function baseTestSource(): string {
  return `import { double } from "../src/math.mjs";

if (double(3) !== 6) {
  throw new Error("double should multiply by two");
}
`;
}

function headTestSource(): string {
  return `import { double, triple } from "../src/math.mjs";

if (double(3) !== 6) {
  throw new Error("double should multiply by two");
}

if (triple(3) !== 9) {
  throw new Error("triple should multiply by three");
}
`;
}
