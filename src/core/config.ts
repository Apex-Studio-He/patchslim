import { access, readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { commandSpec, parseDuration } from "./commands.js";
import { CliError } from "./errors.js";
import { DEFAULT_PROTECT_PATTERNS } from "./patch.js";
import type { CommandSpec, MinimizeSettings } from "./types.js";

interface RawCommand {
  command?: unknown;
  timeout?: unknown;
}

interface RawConfig {
  base?: unknown;
  head?: unknown;
  oracle?: unknown;
  setup?: unknown;
  quickGates?: unknown;
  fullGates?: unknown;
  protect?: unknown;
  runs?: unknown;
  budget?: unknown;
  output?: unknown;
  expectedBaseFailure?: unknown;
}

export interface CliSettingsInput {
  cwd: string;
  configPath?: string;
  baseRef?: string;
  headRef?: string;
  oracle?: string;
  setup?: string;
  quickGates: string[];
  fullGates: string[];
  protectPatterns: string[];
  includeDefaultProtect: boolean;
  runs?: number;
  budget?: string;
  timeout?: string;
  outputDir?: string;
  expectedBaseFailure?: string;
}

export async function resolveSettings(
  input: CliSettingsInput,
): Promise<MinimizeSettings> {
  const raw = await loadRawConfig(input.cwd, input.configPath);
  const defaultTimeout = parseDuration(input.timeout ?? "5m");
  const rawOracle = input.oracle ?? raw.oracle;
  if (rawOracle === undefined) {
    throw new CliError(
      "ORACLE_REQUIRED",
      "An oracle command is required. Pass --oracle <command> or configure oracle in .patchslim.yml.",
    );
  }

  const oracle = normalizeCommand(rawOracle, defaultTimeout, "oracle");
  const setupValue = input.setup ?? raw.setup;
  const setup =
    setupValue === undefined
      ? undefined
      : normalizeCommand(setupValue, parseDuration("15m"), "setup");
  const quickGates =
    input.quickGates.length > 0
      ? input.quickGates.map((value) => commandSpec(value, defaultTimeout))
      : normalizeCommandList(raw.quickGates, defaultTimeout, "quickGates");
  const fullGates =
    input.fullGates.length > 0
      ? input.fullGates.map((value) => commandSpec(value, defaultTimeout))
      : normalizeCommandList(raw.fullGates, defaultTimeout, "fullGates");
  const configuredProtect = stringList(raw.protect, "protect");
  const protectPatterns = [
    ...(input.includeDefaultProtect ? DEFAULT_PROTECT_PATTERNS : []),
    ...configuredProtect,
    ...input.protectPatterns,
  ];
  const runs = input.runs ?? positiveInteger(raw.runs, "runs") ?? 2;
  const budgetText =
    input.budget ??
    (typeof raw.budget === "string" ? raw.budget : undefined) ??
    "30m";
  const expectedFailureText =
    input.expectedBaseFailure ??
    optionalString(raw.expectedBaseFailure, "expectedBaseFailure");

  return {
    cwd: path.resolve(input.cwd),
    ...((input.baseRef ?? optionalString(raw.base, "base"))
      ? { baseRef: input.baseRef ?? String(raw.base) }
      : {}),
    headRef: input.headRef ?? optionalString(raw.head, "head") ?? "HEAD",
    oracle,
    ...(setup ? { setup } : {}),
    quickGates,
    fullGates,
    protectPatterns: [...new Set(protectPatterns)],
    runs,
    budgetMs: parseDuration(budgetText),
    ...((input.outputDir ?? optionalString(raw.output, "output"))
      ? { outputDir: input.outputDir ?? String(raw.output) }
      : {}),
    ...(expectedFailureText
      ? { expectedBaseFailure: compileRegex(expectedFailureText) }
      : {}),
  };
}

export async function findConfigPath(cwd: string): Promise<string | undefined> {
  let directory = path.resolve(cwd);

  while (true) {
    const candidate = path.join(directory, ".patchslim.yml");
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  }
}

async function loadRawConfig(
  cwd: string,
  requested?: string,
): Promise<RawConfig> {
  const configPath = requested
    ? path.resolve(cwd, requested)
    : await findConfigPath(cwd);
  if (!configPath) {
    return {};
  }

  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    throw new CliError("CONFIG_READ_FAILED", `Cannot read ${configPath}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new CliError("CONFIG_PARSE_FAILED", `Cannot parse ${configPath}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      "CONFIG_PARSE_FAILED",
      `${configPath} must contain a YAML object.`,
    );
  }

  return parsed as RawConfig;
}

function normalizeCommand(
  value: unknown,
  defaultTimeout: number,
  field: string,
): CommandSpec {
  if (typeof value === "string") {
    return commandSpec(value, defaultTimeout);
  }
  if (
    Array.isArray(value) &&
    value.every((part): part is string => typeof part === "string")
  ) {
    return commandSpec(value, defaultTimeout);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as RawCommand;
    const timeout =
      raw.timeout === undefined
        ? defaultTimeout
        : typeof raw.timeout === "string"
          ? parseDuration(raw.timeout)
          : invalid(field, "timeout must be a duration string");
    return normalizeCommand(raw.command, timeout, `${field}.command`);
  }

  return invalid(field, "must be a command string, string array, or object");
}

function normalizeCommandList(
  value: unknown,
  defaultTimeout: number,
  field: string,
): CommandSpec[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalid(field, "must be an array");
  }
  return value.map((entry, index) =>
    normalizeCommand(entry, defaultTimeout, `${field}[${index}]`),
  );
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    return invalid(field, "must be an array of strings");
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(field, "must be a non-empty string");
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) < 1) {
    return invalid(field, "must be a positive integer");
  }
  return Number(value);
}

function compileRegex(value: string): RegExp {
  try {
    return new RegExp(value);
  } catch (error) {
    throw new CliError(
      "INVALID_FAILURE_PATTERN",
      `Invalid expected base failure pattern: ${value}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function invalid(field: string, expectation: string): never {
  throw new CliError(
    "INVALID_CONFIG",
    `Configuration field "${field}" ${expectation}.`,
  );
}
