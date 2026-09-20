# Jobs

A job is saved code that runs on a schedule with no model in the loop. It belongs to the package that declares it: the package says what the job is, and the daemon decides when it runs.

## Declare it

Jobs live in the manifest, alongside `exports`, and go in with `kody.packageSave`:

```json
{
  "kody": {
    "jobs": {
      "daily-digest": {
        "entry": "./daily-digest.ts",
        "schedule": { "type": "cron", "expression": "0 8 * * *" },
        "timezone": "Europe/London"
      }
    }
  }
}
```

The entry is a package-local module whose default export takes no arguments. It does not have to be one of the exports. The usual shape is a thin wrapper around a callable export that stays quiet unless there is something to say:

```ts
import { kody } from "kody:runtime";
import whatShipped from "./what-shipped.ts";

export default async function dailyDigest() {
  const found = await whatShipped({ login: "kody-bot" });
  if (found.shipped.length === 0) return { notified: false };
  await kody.notifySelf({ title: "Shipped overnight", message: found.message });
  return { notified: true };
}
```

Anything the job needs to remember between runs goes in `packageStorage()` (guide:storage), which is how "since last time" keeps working when nothing else is watching.

## Turn it on

Jobs arrive disabled, and a job that has never run cannot be enabled: a schedule debugged at 8am is a schedule debugged badly.

1. `kody.jobRunNow({ packageName, jobName })` runs it once and records the run.
2. `kody.jobUpdate({ packageName, jobName, enabled: true })` starts the schedule. The same call overrides `expression` or `timezone` without touching the package.
3. `kody.jobList()` shows every job with its next run and how the last one went, and `kody.runList({ jobName })` / `kody.runGet({ id })` open the history.

## What the schedule promises

Every 30 seconds the daemon looks at each enabled job and runs it if an occurrence has passed. Occurrences missed because the Mac slept or the daemon was down coalesce into a single run. Three missed mornings are one catch-up, not three. A run that fails sends a notification naming the job and the first line of the error.
