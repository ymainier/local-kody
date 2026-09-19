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
    "what-shipped.ts": "export default async function whatShipped(input) { ... }"
  },
  "exports": { "./whatShipped": "./what-shipped.ts" }
}
```

## Use it

```ts
import whatShipped from "kody:@me/what-shipped/whatShipped";

export default async function main(params) {
  return await whatShipped(params);
}
```

Test the module with execute before saving, then invoke the saved export once to prove it works.

## What a save checks

`files` is the whole package: what you send replaces what was there. Before anything is swapped into place, the save

- confirms every `exports` entry (and every job entry) points at a file you sent,
- pins each bare npm import to an exact version in `package.json#dependencies`, keeping versions already pinned,
- runs `deno check` over every export, and
- imports every export in the sandbox without calling it, so a module that throws on load is caught here.

If any check fails nothing is written, the previous version keeps running, and the error lists every failure at once.
