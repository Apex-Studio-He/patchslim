import { describe, expect, it } from "vitest";

import { ddmin } from "../src/core/reducer.js";

describe("ddmin", () => {
  it("finds a one-minimal satisfying subset", async () => {
    const result = await ddmin(
      ["required", "noise-a", "noise-b", "noise-c"],
      async (candidate) => candidate.includes("required"),
      Date.now() + 5_000,
    );

    expect(result.kept).toEqual(["required"]);
    expect(result.evaluations).toBeGreaterThan(0);
  });

  it("honors an exhausted deadline", async () => {
    const result = await ddmin(["a", "b"], async () => true, Date.now() - 1);

    expect(result.kept).toEqual(["a", "b"]);
    expect(result.evaluations).toBe(0);
  });
});
