import { describe, expect, it } from "vitest";

import { parseDuration } from "../src/core/commands.js";
import { CliError } from "../src/core/errors.js";

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("rejects ambiguous durations", () => {
    expect(() => parseDuration("5")).toThrowError(CliError);
  });
});
