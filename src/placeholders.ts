import { accessTokenFor } from "./integrations.ts";
import { secretValueFor } from "./secrets.ts";

// Two kinds of credential, one substitution pass. Doing them in one pass means
// a value that happens to contain a placeholder is never expanded again.
const placeholderPattern = /\{\{(secret|integration):([a-zA-Z0-9_-]+)\}\}/g;

export function hostOf(url: string) {
  return new URL(url.replace(placeholderPattern, "placeholder")).hostname;
}

export async function substitutePlaceholders(text: string, host: string) {
  const found = [...text.matchAll(placeholderPattern)];
  if (found.length === 0) return text;
  const values = new Map<string, string>();
  for (const [whole, kind, name] of found) {
    if (values.has(whole)) continue;
    values.set(
      whole,
      kind === "secret"
        ? await secretValueFor(String(name), host)
        : await accessTokenFor(String(name), host),
    );
  }
  return text.replace(placeholderPattern, (whole) => String(values.get(whole)));
}
