import { writeFile } from "node:fs/promises";

import { formatCommand } from "./commands.js";
import { CliError, asCliError } from "./errors.js";
import {
  createRunDirectory,
  createTemporaryWorktree,
  inspectRepository,
  materializePatch,
  removeTemporaryWorktree,
  stagedPatch,
} from "./git.js";
import {
  atomIdsForFiles,
  buildAtomCandidate,
  buildFileCandidate,
  hashCandidate,
  parseChanges,
  statsFromPatch,
} from "./patch.js";
import { runCommand } from "./process.js";
import { ddmin } from "./reducer.js";
import { reportPaths, writeRunReport } from "./report.js";
import type {
  Evaluation,
  FileChange,
  MinimizeSettings,
  PreflightReport,
  ProcessResult,
  RunReport,
} from "./types.js";

interface EvaluationContext {
  settings: MinimizeSettings;
  repository: Awaited<ReturnType<typeof inspectRepository>>["info"];
  worktree: Awaited<ReturnType<typeof createTemporaryWorktree>>;
  cache: Map<string, Evaluation>;
  cacheHits: number;
  commandsKey: string;
}

export async function minimize(settings: MinimizeSettings): Promise<RunReport> {
  const startedAt = new Date();
  const snapshot = await inspectRepository(
    settings.cwd,
    settings.baseRef,
    settings.headRef,
  );
  if (snapshot.diff.length === 0) {
    throw new CliError(
      "EMPTY_DIFF",
      `There are no committed changes between ${snapshot.info.baseRef} and ${snapshot.info.headRef}.`,
    );
  }

  const changes = parseChanges(
    snapshot.diff,
    snapshot.nameStatus,
    settings.protectPatterns,
  );
  const runId = createRunId(startedAt, snapshot.info.headSha);
  const directory = await createRunDirectory(
    snapshot.info,
    runId,
    settings.outputDir,
  );
  const paths = reportPaths(directory);
  let preflight: PreflightReport = { headRuns: [], passed: false };
  let worktree: Awaited<ReturnType<typeof createTemporaryWorktree>> | undefined;

  const baseReport = {
    schemaVersion: 1 as const,
    runId,
    startedAt: startedAt.toISOString(),
    repository: snapshot.info,
    before: statsFromPatch(snapshot.diff),
    protected: changes
      .filter((change) => change.protected)
      .map((change) => ({
        path: change.path,
        reason: change.protectReason ?? "protected by policy",
      })),
    artifacts: {
      directory,
      reportJson: paths.reportJson,
      reportMarkdown: paths.reportMarkdown,
    },
  };

  try {
    worktree = await createTemporaryWorktree(snapshot.info);
    const context: EvaluationContext = {
      settings,
      repository: snapshot.info,
      worktree,
      cache: new Map(),
      cacheHits: 0,
      commandsKey: commandsKey(settings),
    };
    const reducibleFileIds = changes
      .filter((change) => !change.protected)
      .map((change) => change.id);
    const fullPatch = buildFileCandidate(changes, new Set(reducibleFileIds));

    await materializePatch(snapshot.info, worktree, fullPatch);
    if (settings.setup) {
      const setupResult = await runCommand(settings.setup, {
        cwd: worktree.path,
      });
      if (!passed(setupResult)) {
        throw new CliError(
          "SETUP_FAILED",
          `Setup command failed: ${setupResult.command}`,
          { result: setupResult },
        );
      }
    }

    preflight = await runPreflight(context, changes, fullPatch);
    if (!preflight.passed) {
      throw new CliError(
        preflight.code ?? "PREFLIGHT_FAILED",
        preflight.message ?? "Preflight checks failed.",
      );
    }

    const deadline = Date.now() + settings.budgetMs;
    const fileResult = await ddmin(
      reducibleFileIds,
      async (ids) =>
        (
          await evaluateCandidate(
            context,
            buildFileCandidate(changes, new Set(ids)),
            false,
            true,
          )
        ).passed,
      deadline,
    );
    const keptFileIds = new Set(fileResult.kept);
    const initialAtomIds = atomIdsForFiles(changes, keptFileIds);
    const hunkResult = await ddmin(
      initialAtomIds,
      async (ids) =>
        (
          await evaluateCandidate(
            context,
            buildAtomCandidate(changes, new Set(ids)),
            false,
            true,
          )
        ).passed,
      deadline,
    );
    const keptAtomIds = new Set(hunkResult.kept);
    const finalPatchInput = buildAtomCandidate(changes, keptAtomIds);
    const validation = await evaluateCandidate(
      context,
      finalPatchInput,
      true,
      false,
    );
    if (!validation.passed) {
      throw new CliError(
        "FINAL_VALIDATION_FAILED",
        `The best candidate failed final validation at ${validation.failedStage ?? "an unknown stage"}.`,
      );
    }

    const finalPatch = await stagedPatch(snapshot.info, worktree.path);
    await writeFile(paths.patch, finalPatch, "utf8");

    const keptFiles = changes
      .filter(
        (change) => change.protected || candidateIncludes(change, keptAtomIds),
      )
      .map((change) => change.path);
    const removedFiles = changes
      .filter(
        (change) =>
          !change.protected && !candidateIncludes(change, keptAtomIds),
      )
      .map((change) => change.path);
    const allHunkIds = changes.flatMap((change) =>
      change.atomic || change.hunks.length <= 1
        ? [change.id]
        : change.hunks.map((hunk) => hunk.id),
    );

    const report: RunReport = {
      ...baseReport,
      status: "completed",
      completedAt: new Date().toISOString(),
      after: statsFromPatch(finalPatch),
      preflight,
      artifacts: {
        ...baseReport.artifacts,
        patch: paths.patch,
      },
      reduction: {
        fileEvaluations: fileResult.evaluations,
        hunkEvaluations: hunkResult.evaluations,
        cacheHits: context.cacheHits,
        keptFiles,
        removedFiles,
        keptHunks: hunkResult.kept,
        removedHunks: allHunkIds.filter(
          (id) => !keptAtomIds.has(id) && !isProtectedAtom(changes, id),
        ),
      },
      validation,
    };
    await writeRunReport(report);
    return report;
  } catch (error) {
    const cliError = asCliError(error);
    const report: RunReport = {
      ...baseReport,
      status: "failed",
      completedAt: new Date().toISOString(),
      preflight,
      error: {
        code: cliError.code,
        message: cliError.message,
      },
    };
    await writeRunReport(report);
    throw new CliError(cliError.code, cliError.message, {
      ...cliError.details,
      report: paths.reportJson,
    });
  } finally {
    if (worktree) {
      await removeTemporaryWorktree(snapshot.info.root, worktree);
    }
  }
}

async function runPreflight(
  context: EvaluationContext,
  changes: FileChange[],
  fullPatch: string,
): Promise<PreflightReport> {
  const headRuns: ProcessResult[] = [];

  for (let index = 0; index < context.settings.runs; index += 1) {
    await materializePatch(context.repository, context.worktree, fullPatch);
    const result = await runCommand(context.settings.oracle, {
      cwd: context.worktree.path,
    });
    headRuns.push(result);
    if (!passed(result)) {
      return {
        headRuns,
        passed: false,
        code: "HEAD_ORACLE_UNSTABLE",
        message: `The oracle did not pass consistently on ${context.repository.headRef}.`,
      };
    }
  }

  const protectedOnlyPatch = buildFileCandidate(changes, new Set());
  await materializePatch(
    context.repository,
    context.worktree,
    protectedOnlyPatch,
  );
  const baseRun = await runCommand(context.settings.oracle, {
    cwd: context.worktree.path,
  });
  if (passed(baseRun)) {
    return {
      headRuns,
      baseRun,
      passed: false,
      code: "WEAK_ORACLE",
      message:
        "The oracle also passes with all reducible production changes removed.",
    };
  }

  if (
    context.settings.expectedBaseFailure &&
    !context.settings.expectedBaseFailure.test(
      `${baseRun.stdout}\n${baseRun.stderr}`,
    )
  ) {
    return {
      headRuns,
      baseRun,
      passed: false,
      code: "UNEXPECTED_BASE_FAILURE",
      message:
        "The base candidate failed, but its output did not match the expected failure pattern.",
    };
  }

  return { headRuns, baseRun, passed: true };
}

async function evaluateCandidate(
  context: EvaluationContext,
  patch: string,
  includeFullGates: boolean,
  useCache: boolean,
): Promise<Evaluation> {
  const candidateHash = hashCandidate(patch, context.commandsKey);
  const cached = useCache ? context.cache.get(candidateHash) : undefined;
  if (cached) {
    context.cacheHits += 1;
    return { ...cached, cached: true };
  }

  const startedAt = Date.now();
  const results: ProcessResult[] = [];
  try {
    await materializePatch(context.repository, context.worktree, patch);
  } catch (error) {
    const evaluation: Evaluation = {
      candidateHash,
      materialized: false,
      passed: false,
      cached: false,
      durationMs: Date.now() - startedAt,
      failedStage: "materialize",
      results,
      error: error instanceof Error ? error.message : String(error),
    };
    if (useCache) {
      context.cache.set(candidateHash, evaluation);
    }
    return evaluation;
  }

  const stages = [
    ...context.settings.quickGates.map((spec, index) => ({
      name: `quick-gate-${index + 1}`,
      spec,
    })),
    ...Array.from(
      { length: includeFullGates ? context.settings.runs : 1 },
      (_, index) => ({
        name:
          includeFullGates && context.settings.runs > 1
            ? `oracle-${index + 1}`
            : "oracle",
        spec: context.settings.oracle,
      }),
    ),
    ...(includeFullGates
      ? context.settings.fullGates.map((spec, index) => ({
          name: `full-gate-${index + 1}`,
          spec,
        }))
      : []),
  ];

  for (const stage of stages) {
    let result: ProcessResult;
    try {
      result = await runCommand(stage.spec, { cwd: context.worktree.path });
    } catch (error) {
      const evaluation: Evaluation = {
        candidateHash,
        materialized: true,
        passed: false,
        cached: false,
        durationMs: Date.now() - startedAt,
        failedStage: stage.name,
        results,
        error: error instanceof Error ? error.message : String(error),
      };
      if (useCache) {
        context.cache.set(candidateHash, evaluation);
      }
      return evaluation;
    }

    results.push(result);
    if (!passed(result)) {
      const evaluation: Evaluation = {
        candidateHash,
        materialized: true,
        passed: false,
        cached: false,
        durationMs: Date.now() - startedAt,
        failedStage: stage.name,
        results,
      };
      if (useCache) {
        context.cache.set(candidateHash, evaluation);
      }
      return evaluation;
    }
  }

  const evaluation: Evaluation = {
    candidateHash,
    materialized: true,
    passed: true,
    cached: false,
    durationMs: Date.now() - startedAt,
    results,
  };
  if (useCache) {
    context.cache.set(candidateHash, evaluation);
  }
  return evaluation;
}

function passed(result: ProcessResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

function candidateIncludes(
  change: FileChange,
  selectedAtomIds: ReadonlySet<string>,
): boolean {
  if (change.protected) {
    return true;
  }
  if (change.atomic || change.hunks.length <= 1) {
    return selectedAtomIds.has(change.id);
  }
  return change.hunks.some((hunk) => selectedAtomIds.has(hunk.id));
}

function isProtectedAtom(changes: FileChange[], id: string): boolean {
  return changes.some(
    (change) =>
      change.protected &&
      (change.id === id || change.hunks.some((hunk) => hunk.id === id)),
  );
}

function commandsKey(settings: MinimizeSettings): string {
  return JSON.stringify({
    oracle: formatCommand(settings.oracle.command),
    quick: settings.quickGates.map((gate) => formatCommand(gate.command)),
    full: settings.fullGates.map((gate) => formatCommand(gate.command)),
  });
}

function createRunId(date: Date, headSha: string): string {
  const timestamp = date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${headSha.slice(0, 8)}`;
}
