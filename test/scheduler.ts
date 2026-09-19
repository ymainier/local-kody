// The scheduler rule, driven by a fake clock: occurrences missed while the Mac
// slept or the daemon was down have to coalesce into exactly one run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kodyHome = mkdtempSync(join(tmpdir(), "local-kody-sched-"));
process.env.KODY_HOME = kodyHome;
process.env.KODY_NOTIFY = "stderr";

const packageDir = join(kodyHome, "packages", "@me", "ticker");
mkdirSync(packageDir, { recursive: true });
writeFileSync(
  join(packageDir, "package.json"),
  JSON.stringify({
    name: "@me/ticker",
    description: "Counts how many times it has run",
    exports: { "./count": "./tick.ts" },
    kody: {
      jobs: {
        hourly: {
          entry: "./tick.ts",
          schedule: { type: "cron", expression: "0 * * * *" },
          timezone: "UTC",
        },
      },
    },
  }),
);
writeFileSync(
  join(packageDir, "tick.ts"),
  `import { packageStorage } from 'kody:runtime'
export default async function tick() {
  const storage = packageStorage()
  const runs = ((await storage.get('runs')) ?? 0) + 1
  await storage.set('runs', runs)
  return runs
}`,
);

const breakerDir = join(kodyHome, "packages", "@me", "breaker");
mkdirSync(breakerDir, { recursive: true });
writeFileSync(
  join(breakerDir, "package.json"),
  JSON.stringify({
    name: "@me/breaker",
    description: "A job that always throws",
    exports: { "./break": "./break.ts" },
    kody: {
      jobs: {
        nightly: {
          entry: "./break.ts",
          schedule: { type: "cron", expression: "0 3 * * *" },
          timezone: "UTC",
        },
      },
    },
  }),
);
writeFileSync(
  join(breakerDir, "break.ts"),
  `export default async function fail() {
  throw new Error('the API went away')
}`,
);

await import("../src/capabilities.ts");
const { listJobs, runJobOnce, tickScheduler, updateJob } =
  await import("../src/jobs.ts");
const { listRuns } = await import("../src/store.ts");

const report: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, check: () => Promise<string>) {
  try {
    report.push({ step: name, ok: true, detail: await check() });
  } catch (error) {
    report.push({
      step: name,
      ok: false,
      detail: (error as Error).message.slice(0, 200),
    });
  }
}

const enabledAt = new Date("2026-01-01T00:05:00Z");
const threeMissed = new Date("2026-01-01T03:10:00Z");

function jobRuns() {
  return listRuns({ packageName: "@me/ticker", jobName: "hourly", limit: 100 });
}

await step("a job cannot be enabled before it has run once", async () => {
  assert.throws(
    () =>
      updateJob({
        packageName: "@me/ticker",
        jobName: "hourly",
        enabled: true,
        now: enabledAt,
      }),
    /never run successfully/,
  );
  return "refused with the jobRunNow hint";
});

await step("jobRunNow runs the entry and records it", async () => {
  const outcome = await runJobOnce("@me/ticker", "hourly");
  assert.equal(outcome.error, undefined, outcome.error ?? "");
  assert.equal(outcome.result, 1);
  assert.equal(jobRuns().length, 1);
  return `run ${String(outcome.runId).slice(0, 8)} returned ${String(outcome.result)}`;
});

await step("enabling a job that has run is allowed", async () => {
  const view = updateJob({
    packageName: "@me/ticker",
    jobName: "hourly",
    enabled: true,
    now: enabledAt,
  });
  assert.equal(view.enabled, true);
  assert.equal(view.nextRun, "2026-01-01T01:00:00.000Z");
  return `next run ${String(view.nextRun)}`;
});

await step("three missed occurrences coalesce into one run", async () => {
  const { ran } = await tickScheduler(threeMissed);
  assert.equal(ran.length, 1, `ran ${ran.length} times`);
  assert.equal(ran[0]?.scheduledFor, "2026-01-01T03:00:00.000Z");
  assert.equal(jobRuns().length, 2);
  const job = listJobs().find((candidate) => candidate.jobName === "hourly");
  assert.equal(job?.lastScheduledFor, "2026-01-01T03:00:00.000Z");
  return `one run, caught up to ${String(ran[0]?.scheduledFor)}`;
});

await step("a tick with nothing due runs nothing", async () => {
  const { ran } = await tickScheduler(threeMissed);
  assert.equal(ran.length, 0);
  assert.equal(jobRuns().length, 2);
  return "quiet";
});

await step("a disabled job is skipped even when due", async () => {
  updateJob({
    packageName: "@me/ticker",
    jobName: "hourly",
    enabled: false,
    now: threeMissed,
  });
  const { ran } = await tickScheduler(new Date("2026-01-02T09:00:00Z"));
  assert.equal(ran.length, 0);
  assert.equal(jobRuns().length, 2);
  return "skipped";
});

await step("a failing job notifies with its name and first line", async () => {
  const written: Array<string> = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const outcome = await runJobOnce("@me/breaker", "nightly");
    assert.match(outcome.error ?? "", /the API went away/);
  } finally {
    process.stderr.write = realWrite;
  }
  const notification = written.find((line) => line.includes("[notifySelf]"));
  assert.ok(notification, `no notification in ${written.join("")}`);
  assert.match(notification, /Job nightly failed/);
  assert.match(notification, /the API went away/);
  return notification.trim().slice(0, 70);
});

console.table(report);
process.exitCode = report.every((entry) => entry.ok) ? 0 : 1;
