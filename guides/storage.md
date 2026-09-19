# Package storage

Every saved package gets its own small key/value bucket. It is bound to the package the calling module came from, not to an argument, so two packages can both keep a key called `cursor` without meeting.

```ts
import { packageStorage } from "kody:runtime";

export default async function poll({ baseUrl }) {
  const storage = packageStorage();
  const since = await storage.get("cursor");
  // ...
  await storage.set("cursor", newest.id);
  return { since };
}
```

`packageStorage()` returns `get(key)`, `set(key, value)`, `list()` and `delete(key)`. Values are JSON; `get` returns `null` for a key that was never set.

## It only works inside a package

Ad hoc `execute` code has no package, so `packageStorage()` throws and tells you to save one. Two ways to get a bucket:

- save the code as a package and call `packageStorage()` from the saved module, or
- import an export of a saved package (`import fn from "kody:@me/leaf/fn"`) and let that module keep the state.

Either way the bucket follows the module's folder, so the same state is there whether the code runs from `execute` or from a scheduled job.
