# Saving packages

Save code as a package when the user will ask the same thing again, or wants it to run on a schedule. A package is saved code with named exports that any later execute call can import.

## Shape

- Name: `@me/<leaf>`, lowercase with dashes.
- Each export is one file whose default export is an async function taking one object argument.
- Keep state (cursors, last-seen ids) in `packageStorage()` from `kody:runtime`; the bucket belongs to the package. See guide:storage.
- Credentials: use `{{secret:name}}` inside fetch. Never put a secret value in code.

## Save it

```ts
import { kody } from "kody:runtime";

export default async function main(params) {
  return await kody.packageSave(params);
}
```

with params like:

```json
{
  "name": "@me/what-shipped",
  "description": "Releases and new repos a GitHub user shipped since last check",
  "files": {
    "what-shipped.ts": "export default async function whatShipped(input) { ... }",
    "daily-digest.ts": "export default async function dailyDigest() { ... }"
  },
  "exports": { "./whatShipped": "./what-shipped.ts" },
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

`kody.jobs` is optional and declares schedules the daemon runs without a model. Read guide:jobs before adding one. `dependencies` is optional too: pass exact npm versions to pin, and anything you leave out is resolved to the latest at save time.

## Use it

```ts
import whatShipped from "kody:@me/what-shipped/whatShipped";

export default async function main(params) {
  return await whatShipped(params);
}
```

Test the module with execute before saving, then invoke the saved export once to prove it works. Reading a saved package back is `kody.packageList()`, or `search` with `{ "entity": "package:@me/<leaf>" }`.

## What a save checks

`files` is the whole package: what you send replaces what was there. Before anything is swapped into place, the save

- confirms every `exports` entry and every job entry points at a file you sent, and that `kody.jobs` parses,
- pins each bare npm import to an exact version in `package.json#dependencies`, keeping versions already pinned,
- runs `deno check` over every export and job entry, and
- imports each of them in the sandbox without calling it, so a module that throws while loading is caught here instead of at 8am.

If any check fails nothing is written, the previous version keeps running, and the error lists every failure at once.
