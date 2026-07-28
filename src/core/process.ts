import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { formatCommand } from "./commands.js";
import { CliError } from "./errors.js";
import type { CommandSpec, ProcessResult } from "./types.js";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const REDACTED_ENV_RE =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE|CREDENTIAL)/i;
const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
]);

export interface RunOptions {
  cwd: string;
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function runCommand(
  spec: CommandSpec,
  options: RunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw interruptedError();
  }

  const startedAt = performance.now();
  const command = Array.isArray(spec.command) ? spec.command[0] : spec.command;
  const args = Array.isArray(spec.command) ? spec.command.slice(1) : [];
  const shell = !Array.isArray(spec.command);

  if (!command) {
    throw new Error("Cannot execute an empty command.");
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildSafeEnvironment(options.extraEnv),
      shell,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child.pid);
    }, spec.timeoutMs);
    const abortHandler = (): void => {
      if (!settled) {
        aborted = true;
        terminateProcess(child.pid);
      }
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      reject(aborted ? interruptedError() : error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      if (aborted) {
        reject(interruptedError());
        return;
      }
      resolve({
        command: formatCommand(spec.command),
        exitCode,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
        stdout,
        stderr,
      });
    });
  });
}

function interruptedError(): CliError {
  return new CliError(
    "INTERRUPTED",
    "PatchSlim was interrupted while a command was running.",
  );
}

function buildSafeEnvironment(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", PATCHSLIM: "1" };

  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (SAFE_ENV_NAMES.has(name) || !REDACTED_ENV_RE.test(name))
    ) {
      env[name] = value;
    }
  }

  return { ...env, ...extraEnv };
}

function appendBounded(current: string, next: string): string {
  if (current.length >= MAX_CAPTURE_BYTES) {
    return current;
  }

  const combined = current + next;
  if (combined.length <= MAX_CAPTURE_BYTES) {
    return combined;
  }

  return `${combined.slice(0, MAX_CAPTURE_BYTES)}\n[output truncated]\n`;
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.unref();
    } else {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      }, 1_000).unref();
    }
  } catch {
    // The process may have exited between timeout and termination.
  }
}
