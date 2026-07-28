import { describe, expect, it } from "vitest";

import { commandSpec } from "../src/core/commands.js";
import { runCommand } from "../src/core/process.js";

describe("runCommand", () => {
  it("captures successful output", async () => {
    const result = await runCommand(
      commandSpec(
        [process.execPath, "-e", 'process.stdout.write("ok")'],
        5_000,
      ),
      { cwd: process.cwd() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
  });

  it("terminates commands that exceed their timeout", async () => {
    const result = await runCommand(
      commandSpec([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], 50),
      { cwd: process.cwd() },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("terminates commands when the caller aborts", async () => {
    const controller = new AbortController();
    const result = runCommand(
      commandSpec(
        [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
        5_000,
      ),
      { cwd: process.cwd(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(result).rejects.toMatchObject({
      code: "INTERRUPTED",
    });
  });

  it("does not forward secret-like environment variables", async () => {
    process.env.PATCHSLIM_TEST_TOKEN = "do-not-forward";
    try {
      const result = await runCommand(
        commandSpec(
          [
            process.execPath,
            "-e",
            "process.stdout.write(String(process.env.PATCHSLIM_TEST_TOKEN))",
          ],
          5_000,
        ),
        { cwd: process.cwd() },
      );

      expect(result.stdout).toBe("undefined");
    } finally {
      delete process.env.PATCHSLIM_TEST_TOKEN;
    }
  });
});
