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

  it("removes all irrelevant atoms across varied monotonic predicates", async () => {
    for (let size = 1; size <= 32; size += 1) {
      const values = Array.from(
        { length: size },
        (_, index) => `atom-${index}`,
      );
      const required = values.filter(
        (_, index) => (index * 17 + size * 11) % 7 === 0,
      );
      if (required.length === 0) {
        required.push(values[size % values.length]!);
      }

      const result = await ddmin(
        values,
        async (candidate) => required.every((atom) => candidate.includes(atom)),
        Date.now() + 5_000,
      );

      expect(result.kept).toEqual(required);
    }
  });
});
