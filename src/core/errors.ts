export class CliError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error) {
    return new CliError("UNEXPECTED_ERROR", error.message);
  }

  return new CliError("UNEXPECTED_ERROR", String(error));
}
