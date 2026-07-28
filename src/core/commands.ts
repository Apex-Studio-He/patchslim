import { CliError } from "./errors.js";
import type { CommandSpec } from "./types.js";

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new CliError(
      "INVALID_DURATION",
      `Invalid duration "${value}". Use values such as 500ms, 30s, 5m, or 1h.`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : 3_600_000;
  return amount * multiplier;
}

export function commandSpec(
  command: string | string[],
  timeoutMs: number,
): CommandSpec {
  if (Array.isArray(command)) {
    if (command.length === 0 || command.some((part) => part.length === 0)) {
      throw new CliError("INVALID_COMMAND", "Command arrays cannot be empty.");
    }
  } else if (command.trim().length === 0) {
    throw new CliError("INVALID_COMMAND", "Commands cannot be empty.");
  }

  return { command, timeoutMs };
}

export function formatCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.map(shellQuote).join(" ") : command;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
