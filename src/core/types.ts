export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export interface CommandSpec {
  command: string | string[];
  timeoutMs: number;
}

export interface ProcessResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type ChangeStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface Hunk {
  id: string;
  raw: string;
  header: string;
}

export interface FileChange {
  id: string;
  order: number;
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  raw: string;
  header: string;
  hunks: Hunk[];
  binary: boolean;
  atomic: boolean;
  protected: boolean;
  protectReason?: string;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface Evaluation {
  candidateHash: string;
  materialized: boolean;
  passed: boolean;
  cached: boolean;
  durationMs: number;
  failedStage?: string;
  results: ProcessResult[];
  error?: string;
}

export interface RepositoryInfo {
  root: string;
  commonGitDir: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

export interface MinimizeSettings {
  cwd: string;
  baseRef?: string;
  headRef: string;
  oracle: CommandSpec;
  setup?: CommandSpec;
  quickGates: CommandSpec[];
  fullGates: CommandSpec[];
  protectPatterns: string[];
  runs: number;
  budgetMs: number;
  outputDir?: string;
  expectedBaseFailure?: RegExp;
}

export interface PreflightReport {
  headRuns: ProcessResult[];
  baseRun?: ProcessResult;
  passed: boolean;
  code?: string;
  message?: string;
}

export interface ReductionReport {
  fileEvaluations: number;
  hunkEvaluations: number;
  cacheHits: number;
  keptFiles: string[];
  removedFiles: string[];
  keptHunks: string[];
  removedHunks: string[];
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  repository: RepositoryInfo;
  before: DiffStats;
  after?: DiffStats;
  protected: Array<{ path: string; reason: string }>;
  preflight: PreflightReport;
  reduction?: ReductionReport;
  validation?: Evaluation;
  artifacts: {
    directory: string;
    patch?: string;
    reportJson: string;
    reportMarkdown?: string;
  };
  error?: {
    code: string;
    message: string;
  };
}
