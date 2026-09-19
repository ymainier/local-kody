# Saving packages

Save code as a package when the user will ask the same thing again, or wants it to run on a schedule. A package is saved code with named exports that any later execute call can import.

## Shape

- Name: `@me/<leaf>`, lowercase with dashes.
- Each export is one file whose default export is an async function taking one object argument.
- Keep state (cursors, last-seen ids) in `kody.storageGet` / `kody.storageSet` with `namespace` set to the package leaf.
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
