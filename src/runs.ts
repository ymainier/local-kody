import { randomUUID } from "node:crypto";
import {
  defaultExecuteTimeoutMs,
  execute,
  type ExecuteOutcome,
  type PackageScope,
} from "./executor.ts";
import {
  finishRun,
  findRunByIdempotencyKey,
  reconcileStrandedRuns,
  startRun,
  type RunRecord,
} from "./store.ts";
import type { ExecuteInput } from "./tools.ts";

// Every job run is recorded. An `execute` is recorded when it fails (so a
// failure is still there after the client forgot it) or when the caller passes
// an idempotency key (so a client that timed out can ask for the same answer
// instead of running the code twice).
export type RecordedOutcome = ExecuteOutcome & {
  runId?: string;
  replayed?: boolean;
  inProgress?: boolean;
};

// A margin over the execute timeout: below it a `running` row may still be a
// live sandbox, above it nothing can still be running.
const strandedMarginMs = 30_000;

export function reconcileOnStartup() {
  const staleBefore = new Date(
    Date.now() - defaultExecuteTimeoutMs - strandedMarginMs,
  ).toISOString();
  return reconcileStrandedRuns(staleBefore);
}

function replayOf(run: RunRecord): RecordedOutcome {
  if (run.status === "running") {
    return {
      runId: run.id,
      inProgress: true,
      logs: [],
      durationMs: 0,
      error: `Run ${run.id} with this idempotencyKey is still going. Ask again with the same key.`,
    };
  }
  return {
    runId: run.id,
    replayed: true,
    result: run.result,
    error: run.error ?? undefined,
    logs: run.logs,
    durationMs: run.durationMs ?? 0,
  };
}

export async function executeRecorded(
  input: ExecuteInput & { idempotencyKey?: string },
): Promise<RecordedOutcome> {
  const key = input.idempotencyKey;
  if (!key) {
    const outcome = await execute(input);
    if (outcome.error) {
      const id = randomUUID();
      startRun({ id, surface: "execute" });
      finishRun(id, outcome);
      return { ...outcome, runId: id };
    }
    return outcome;
  }
  const existing = findRunByIdempotencyKey(key);
  if (existing) return replayOf(existing);
  const id = randomUUID();
  try {
    startRun({ id, surface: "execute", idempotencyKey: key });
  } catch {
    // The unique index on idempotency_key decides who runs when two calls with
    // the same key arrive together; the loser replays the winner.
    const raced = findRunByIdempotencyKey(key);
    if (raced) return replayOf(raced);
    throw new Error(`Could not record a run for idempotencyKey "${key}"`);
  }
  const outcome = await execute(input);
  finishRun(id, outcome);
  return { ...outcome, runId: id };
}

export async function runJob(job: {
  packageName: string;
  jobName: string;
  code: string;
  timeoutMs?: number;
  extraImports?: Record<string, string>;
  extraScopes?: Array<PackageScope>;
}) {
  const id = randomUUID();
  startRun({
    id,
    surface: "job",
    packageName: job.packageName,
    jobName: job.jobName,
  });
  const outcome = await execute({
    code: job.code,
    timeoutMs: job.timeoutMs,
    extraImports: job.extraImports,
    extraScopes: job.extraScopes,
  });
  finishRun(id, outcome);
  return { ...outcome, runId: id };
}
