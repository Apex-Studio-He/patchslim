#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command, Option } from "commander";

import { parseDuration } from "./core/commands.js";
import { findConfigPath, resolveSettings } from "./core/config.js";
import { asCliError, CliError } from "./core/errors.js";
import { minimize } from "./core/engine.js";
import {
  findRepositoryRoot,
  gitVersion,
  inspectRepository,
} from "./core/git.js";
import { writeError, writeSuccess } from "./core/output.js";
import {
  DEFAULT_PROTECT_PATTERNS,
  parseChanges,
  statsFromPatch,
} from "./core/patch.js";
import { readRunReport, renderHumanSummary } from "./core/report.js";
import type { JsonValue } from "./core/types.js";

const VERSION = "0.1.0";
const shutdown = new AbortController();

process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

interface GlobalOptions {
  json?: boolean;
  cwd?: string;
}

const program = new Command();
program
  .name("patchslim")
  .description("Test-guided minimization for Git diffs.")
  .version(VERSION)
  .option("--json", "emit stable JSON to stdout")
  .option("-C, --cwd <path>", "run as if PatchSlim started in this directory");

program
  .command("doctor")
  .description("Check Git, repository, configuration, and runtime readiness.")
  .action(async () => {
    const globals = globalOptions();
    const cwd = resolveCwd(globals.cwd);
    const [git, repositoryRoot, configPath] = await Promise.all([
      gitVersion(),
      findRepositoryRoot(cwd),
      findConfigPath(cwd),
    ]);
    const data = {
      version: VERSION,
      node: process.version,
      git: git ?? null,
      cwd,
      repositoryRoot: repositoryRoot ?? null,
      configPath: configPath ?? null,
      ready: git !== undefined && repositoryRoot !== undefined,
      missing: [
        ...(git ? [] : ["git"]),
        ...(repositoryRoot ? [] : ["repository"]),
      ],
    };

    writeSuccess("doctor", toJson(data), outputOptions(), () => {
      const lines = [
        `PatchSlim ${VERSION}`,
        `Node: ${process.version}`,
        `Git: ${git ?? "not found"}`,
        `Repository: ${repositoryRoot ?? "not found"}`,
        `Config: ${configPath ?? "not found"}`,
      ];
      if (!data.ready) {
        lines.push("", `Needs setup: ${data.missing.join(", ")}`);
      }
      return lines.join("\n");
    });
  });

program
  .command("init")
  .description("Create a conservative .patchslim.yml configuration.")
  .option("--dry-run", "print the configuration without writing it")
  .option("--force", "replace an existing configuration")
  .action(async (options: { dryRun?: boolean; force?: boolean }) => {
    const cwd = resolveCwd(globalOptions().cwd);
    const destination = path.join(cwd, ".patchslim.yml");
    const content = defaultConfiguration();

    if (!options.dryRun && !options.force && (await exists(destination))) {
      throw new CliError(
        "CONFIG_EXISTS",
        `${destination} already exists. Pass --force to replace it.`,
      );
    }

    if (!options.dryRun) {
      await writeFile(destination, content, "utf8");
    }

    writeSuccess(
      "init",
      toJson({
        path: destination,
        written: !options.dryRun,
        content,
      }),
      outputOptions(),
      () =>
        options.dryRun
          ? content
          : `Created ${destination}\nReview the oracle and protect patterns before running minimize.`,
    );
  });

program
  .command("inspect")
  .description("Inspect the committed diff and its protection classification.")
  .option("--base <ref>", "base branch or revision")
  .option("--head <ref>", "head branch or revision", "HEAD")
  .option("--protect <glob>", "additional protected path pattern", collect, [])
  .action(
    async (options: { base?: string; head: string; protect: string[] }) => {
      const cwd = resolveCwd(globalOptions().cwd);
      const snapshot = await inspectRepository(cwd, options.base, options.head);
      const changes = parseChanges(snapshot.diff, snapshot.nameStatus, [
        ...DEFAULT_PROTECT_PATTERNS,
        ...options.protect,
      ]);
      const data = {
        repository: snapshot.info,
        stats: statsFromPatch(snapshot.diff),
        dirtyWorkingTree: snapshot.originalStatus.length > 0,
        changes: changes.map((change) => ({
          path: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          hunks: change.hunks.length,
          atomic: change.atomic,
          protected: change.protected,
          protectReason: change.protectReason ?? null,
        })),
      };

      writeSuccess("inspect", toJson(data), outputOptions(), () => {
        const stats = data.stats;
        const rows = data.changes.map(
          (change) =>
            `${change.protected ? "P" : "R"} ${change.status.padEnd(12)} ${String(change.hunks).padStart(3)} hunks  ${change.path}`,
        );
        return [
          `${stats.files} files, +${stats.additions}/-${stats.deletions}`,
          data.dirtyWorkingTree
            ? "Note: uncommitted working-tree changes are not included."
            : "",
          "",
          "P = protected, R = reducible",
          ...rows,
        ]
          .filter(Boolean)
          .join("\n");
      });
    },
  );

program
  .command("minimize")
  .description(
    "Find a smaller committed diff that passes the configured checks.",
  )
  .option("--config <path>", "configuration file")
  .option("--base <ref>", "base branch or revision")
  .option("--head <ref>", "head branch or revision")
  .option("--oracle <command>", "feature-preserving oracle command")
  .option("--setup <command>", "one-time dependency setup command")
  .option("--quick <command>", "quick gate run for each candidate", collect, [])
  .option("--gate <command>", "full final-validation gate", collect, [])
  .option("--protect <glob>", "additional protected path pattern", collect, [])
  .option("--no-default-protect", "disable built-in protection patterns")
  .addOption(
    new Option("--runs <count>", "stable head-oracle run count").argParser(
      positiveInteger,
    ),
  )
  .option("--budget <duration>", "reduction time budget")
  .option("--timeout <duration>", "default command timeout")
  .option("--out <path>", "artifact output directory")
  .option(
    "--expect-base-failure <regex>",
    "required pattern in the protected-base oracle failure",
  )
  .action(
    async (options: {
      config?: string;
      base?: string;
      head?: string;
      oracle?: string;
      setup?: string;
      quick: string[];
      gate: string[];
      protect: string[];
      defaultProtect: boolean;
      runs?: number;
      budget?: string;
      timeout?: string;
      out?: string;
      expectBaseFailure?: string;
    }) => {
      const cwd = resolveCwd(globalOptions().cwd);
      const settings = await resolveSettings({
        cwd,
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.base ? { baseRef: options.base } : {}),
        ...(options.head ? { headRef: options.head } : {}),
        ...(options.oracle ? { oracle: options.oracle } : {}),
        ...(options.setup ? { setup: options.setup } : {}),
        quickGates: options.quick,
        fullGates: options.gate,
        protectPatterns: options.protect,
        includeDefaultProtect: options.defaultProtect,
        ...(options.runs ? { runs: options.runs } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
        ...(options.out ? { outputDir: options.out } : {}),
        ...(options.expectBaseFailure
          ? { expectedBaseFailure: options.expectBaseFailure }
          : {}),
        signal: shutdown.signal,
      });
      const report = await minimize(settings);
      writeSuccess("minimize", toJson(report), outputOptions(), () =>
        renderHumanSummary(report),
      );
    },
  );

program
  .command("report")
  .description("Read a PatchSlim JSON report.")
  .argument("<path>", "path to report.json")
  .action(async (reportPath: string) => {
    const cwd = resolveCwd(globalOptions().cwd);
    const report = await readRunReport(path.resolve(cwd, reportPath));
    writeSuccess("report", toJson(report), outputOptions(), () =>
      renderHumanSummary(report),
    );
  });

program
  .showHelpAfterError()
  .configureHelp({ sortOptions: true, sortSubcommands: true });

main().catch((error: unknown) => {
  const cliError = asCliError(error);
  writeError(
    cliError.code,
    cliError.message,
    cliError.details,
    outputOptions(),
  );
  process.exitCode = cliError.code === "INTERRUPTED" ? 130 : 1;
});

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function outputOptions(): { json: boolean } {
  return { json: globalOptions().json === true };
}

function resolveCwd(value: string | undefined): string {
  const cwd = path.resolve(value ?? process.cwd());
  return cwd;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(
      "INVALID_NUMBER",
      `"${value}" is not a positive integer.`,
    );
  }
  return parsed;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function defaultConfiguration(): string {
  return `version: 1

# The oracle must pass on HEAD and fail when reducible production changes
# are removed while protected tests remain.
oracle:
  command: [pnpm, test]
  timeout: 5m

# setup:
#   command: [pnpm, install, --frozen-lockfile]
#   timeout: 15m

# Optional checks:
# quickGates:
#   - command: [pnpm, typecheck]
#     timeout: 5m
#
# fullGates:
#   - command: [pnpm, lint]
#     timeout: 5m

protect:
  - "tests/**"
  - "migrations/**"

runs: 2
budget: 30m
`;
}

// Validate duration parsing during startup so malformed implementation defaults
// cannot silently reach the runner.
parseDuration("5m");
