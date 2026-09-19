import { join } from "node:path";
import { Cron } from "croner";
import {
  getPackage,
  listPackages,
  packageRoot,
  type JobDefinition,
} from "./packages.ts";
import { callCapability } from "./registry.ts";
import { runJob } from "./runs.ts";
import {
  getJobState,
  hasSuccessfulRun,
  lastRunOf,
  saveJobState,
  setLastScheduledFor,
  type JobState,
} from "./store.ts";

// A job is declared by the package that owns it and scheduled by the daemon.
// The package owns what it is (name, entry); the store owns whether and when it
// runs, so enabling a job never means rewriting the package.
export type JobView = {
  packageName: string;
  jobName: string;
  entry: string;
  expression: string;
  timezone: string | null;
  enabled: boolean;
  enabledAt: string | null;
  lastScheduledFor: string | null;
  nextRun: string | null;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    error: string | null;
  } | null;
};

function emptyState(packageName: string, jobName: string): JobState {
  return {
    packageName,
    jobName,
    enabled: false,
    expression: null,
    timezone: null,
    enabledAt: null,
    lastScheduledFor: null,
  };
}

function cronOf(expression: string, timezone: string | null) {
  // paused: croner is used here purely as a calendar; the daemon's own tick
  // decides when anything runs.
  return new Cron(expression, {
    timezone: timezone ?? undefined,
    paused: true,
  });
}

function viewOf(
  packageName: string,
  jobName: string,
  definition: JobDefinition,
): JobView {
  const state =
    getJobState(packageName, jobName) ?? emptyState(packageName, jobName);
  const expression = state.expression ?? definition.schedule.expression;
  const timezone = state.timezone ?? definition.timezone ?? null;
  const enabled = state.enabled;
  const after = state.lastScheduledFor ?? state.enabledAt;
  const nextRun =
    enabled && after
      ? (cronOf(expression, timezone).nextRun(new Date(after)) ?? null)
      : null;
  const last = lastRunOf(packageName, jobName);
  return {
    packageName,
    jobName,
    entry: definition.entry,
    expression,
    timezone,
    enabled,
    enabledAt: state.enabledAt,
    lastScheduledFor: state.lastScheduledFor,
    nextRun: nextRun ? nextRun.toISOString() : null,
    lastRun: last
      ? {
          id: last.id,
          status: last.status,
          startedAt: last.startedAt,
          error: last.error ? (last.error.split("\n")[0] ?? null) : null,
        }
      : null,
  };
}

export function listJobs() {
  const views: Array<JobView> = [];
  for (const manifest of listPackages()) {
    for (const [jobName, definition] of Object.entries(
      manifest.kody?.jobs ?? {},
    )) {
      views.push(viewOf(manifest.name, jobName, definition));
    }
  }
  return views;
}

function definitionOf(packageName: string, jobName: string) {
  const manifest = getPackage(packageName);
  if (!manifest) throw new Error(`No saved package named ${packageName}`);
  const definition = manifest.kody?.jobs?.[jobName];
  if (!definition) {
    const known = Object.keys(manifest.kody?.jobs ?? {});
    throw new Error(
      `Package ${packageName} declares no job "${jobName}". Jobs: ${known.join(", ") || "none"}`,
    );
  }
  return { manifest, definition };
}

// The entry is a package-local module, not one of the package's exports, so it
// is handed to the sandbox by path with the package's own scope around it.
export async function runJobOnce(packageName: string, jobName: string) {
  const { manifest, definition } = definitionOf(packageName, jobName);
  const outcome = await runJob({
    packageName,
    jobName,
    code: `import job from 'kody:job/entry'
export default async function main() {
  return await job()
}`,
    extraImports: {
      "kody:job/entry": join(packageRoot(packageName), definition.entry),
    },
    extraScopes: [
      {
        folder: packageRoot(packageName),
        packageName,
        dependencies: manifest.dependencies,
      },
    ],
  });
  if (outcome.error) {
    // A job that fails silently is worse than one that never ran: say so.
    await callCapability("notifySelf", {
      title: `Job ${jobName} failed`,
      message: outcome.error.split("\n")[0] ?? "Unknown error",
    });
  }
  return outcome;
}

export function updateJob(input: {
  packageName: string;
  jobName: string;
  enabled?: boolean;
  expression?: string;
  timezone?: string;
  now?: Date;
}) {
  const { definition } = definitionOf(input.packageName, input.jobName);
  const now = input.now ?? new Date();
  const state =
    getJobState(input.packageName, input.jobName) ??
    emptyState(input.packageName, input.jobName);
  if (input.expression !== undefined) {
    // Fail here rather than at the next tick.
    cronOf(input.expression, input.timezone ?? state.timezone).nextRun(now);
    state.expression = input.expression;
  }
  if (input.timezone !== undefined) state.timezone = input.timezone;
  if (input.enabled !== undefined) {
    if (input.enabled && !hasSuccessfulRun(input.packageName, input.jobName)) {
      throw new Error(
        `Job "${input.jobName}" has never run successfully, so there is nothing to trust at 8am. Run it once with kody.jobRunNow({ packageName: "${input.packageName}", jobName: "${input.jobName}" }), then enable it.`,
      );
    }
    if (input.enabled && !state.enabled) {
      state.enabledAt = now.toISOString();
      state.lastScheduledFor = null;
    }
    state.enabled = input.enabled;
  }
  saveJobState(state);
  return viewOf(input.packageName, input.jobName, definition);
}

// Occurrences missed while the Mac slept or the daemon was down coalesce into
// one run: catch up to the latest occurrence at or before now, run once, and
// remember that occurrence.
const maxCatchUpSteps = 10_000;

function latestOccurrenceAtOrBefore(
  expression: string,
  timezone: string | null,
  after: Date,
  now: Date,
) {
  const cron = cronOf(expression, timezone);
  let latest = cron.nextRun(after);
  if (!latest || latest > now) return null;
  for (let step = 0; step < maxCatchUpSteps; step += 1) {
    const following = cron.nextRun(latest);
    if (!following || following > now) break;
    latest = following;
  }
  return latest;
}

export async function tickScheduler(now: Date = new Date()) {
  const ran: Array<{ jobName: string; scheduledFor: string; error?: string }> =
    [];
  for (const job of listJobs()) {
    if (!job.enabled) continue;
    const after = job.lastScheduledFor ?? job.enabledAt;
    if (!after) continue;
    const due = latestOccurrenceAtOrBefore(
      job.expression,
      job.timezone,
      new Date(after),
      now,
    );
    if (!due) continue;
    const outcome = await runJobOnce(job.packageName, job.jobName);
    setLastScheduledFor(job.packageName, job.jobName, due.toISOString());
    ran.push({
      jobName: job.jobName,
      scheduledFor: due.toISOString(),
      error: outcome.error,
    });
  }
  return { ran };
}
