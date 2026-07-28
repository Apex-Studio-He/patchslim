import type { JsonValue } from "./types.js";

export interface OutputOptions {
  json: boolean;
}

export function writeSuccess(
  command: string,
  data: JsonValue,
  options: OutputOptions,
  human: () => string,
): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, command, data }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write(`${human()}\n`);
}

export function writeError(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  options: OutputOptions,
): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code,
            message,
            ...(details ? { details } : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stderr.write(`patchslim: ${message}\n`);
}
