import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getPackage, listPackages, type PackageManifest } from "./packages.ts";
import { guidesDir } from "./paths.ts";
import {
  describeInput,
  getCapability,
  listCapabilities,
  type Capability,
} from "./registry.ts";
import { listSecretNames } from "./secrets.ts";
import type { SearchInput } from "./tools.ts";

type SearchEntry = {
  ref: string;
  domain: string;
  title: string;
  summary: string;
  nameText: string;
  keywordText: string;
  bodyText: string;
  callShape?: string;
};

const stopwords = new Set([
  "a",
  "an",
  "the",
  "to",
  "me",
  "my",
  "i",
  "for",
  "of",
  "and",
  "or",
  "on",
  "in",
  "it",
  "with",
  "is",
  "when",
  "what",
  "how",
  "do",
  "can",
  "you",
]);

function tokenize(text: string) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !stopwords.has(token));
}

function readGuides() {
  return readdirSync(guidesDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const markdown = readFileSync(join(guidesDir, file), "utf8");
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? file;
      const summary =
        markdown
          .split("\n\n")
          .find((block) => block.trim() && !block.startsWith("#")) ?? "";
      return {
        id: file.replace(/\.md$/, ""),
        title,
        summary: summary.trim(),
        markdown,
      };
    });
}

function callShape(capability: Capability) {
  const keys = Object.keys(
    (z.toJSONSchema(capability.inputSchema) as { properties?: object })
      .properties ?? {},
  );
  return `kody.${capability.name}(${keys.length ? `{ ${keys.join(", ")} }` : ""})`;
}

function buildEntries(): Array<SearchEntry> {
  const capabilityEntries = listCapabilities().map((capability) => ({
    ref: `capability:${capability.name}`,
    domain: capability.domain,
    title: capability.name,
    summary: capability.description,
    nameText: capability.name,
    keywordText: capability.keywords.join(" "),
    bodyText: `${capability.domain} ${capability.description}`,
    callShape: callShape(capability),
  }));
  const packageEntries = listPackages().map((manifest) => ({
    ref: `package:${manifest.name}`,
    domain: "saved-packages",
    title: manifest.name,
    summary: manifest.description,
    nameText: manifest.name,
    keywordText: Object.keys(manifest.exports).join(" "),
    bodyText: manifest.description,
  }));
  const guideEntries = readGuides().map((guide) => ({
    ref: `guide:${guide.id}`,
    domain: "guides",
    title: guide.title,
    summary: guide.summary.split("\n")[0] ?? "",
    nameText: guide.id,
    keywordText: guide.title,
    bodyText: guide.markdown,
  }));
  const secretEntries = listSecretNames().map((secret) => ({
    ref: `secret:${secret.name}`,
    domain: "secrets",
    title: secret.name,
    summary: `Saved secret. Use {{secret:${secret.name}}} in fetch to ${secret.allowedHosts.join(", ") || "no approved hosts yet"}.`,
    nameText: secret.name,
    keywordText: secret.allowedHosts.join(" "),
    bodyText: "secret token credential api key",
  }));
  return [
    ...capabilityEntries,
    ...packageEntries,
    ...guideEntries,
    ...secretEntries,
  ];
}

// Cheap stemming: "ship" matches "shipped", "notify" matches "notification".
function matches(documentTokens: Array<string>, queryToken: string) {
  return documentTokens.some(
    (documentToken) =>
      documentToken === queryToken ||
      (queryToken.length >= 4 && documentToken.startsWith(queryToken)) ||
      (documentToken.length >= 4 && queryToken.startsWith(documentToken)),
  );
}

function score(entry: SearchEntry, queryTokens: Array<string>) {
  const name = tokenize(entry.nameText);
  const keywords = tokenize(entry.keywordText);
  const body = tokenize(entry.bodyText);
  let total = 0;
  for (const token of queryTokens) {
    if (matches(name, token)) total += 3;
    if (matches(keywords, token)) total += 2;
    if (matches(body, token)) total += 1;
  }
  // Saved packages are the point of the system: prefer reuse over rebuilding.
  if (entry.ref.startsWith("package:") && total > 0) total += 1;
  return total / Math.max(1, queryTokens.length);
}

function packageDetail(manifest: PackageManifest) {
  const exportLines = Object.entries(manifest.exports).map(
    ([exportName, file]) => {
      const leaf = exportName.slice(2);
      return `- \`${exportName}\` (${file}): \`import ${leaf.replace(/[^a-zA-Z0-9]/g, "")} from 'kody:${manifest.name}/${leaf}'\``;
    },
  );
  return [
    `## package:${manifest.name}`,
    manifest.description,
    "",
    "Exports:",
    ...exportLines,
  ].join("\n");
}

function capabilityDetail(capability: Capability) {
  return [
    `## capability:${capability.name}`,
    `Domain: ${capability.domain}${capability.destructive ? " (changes state)" : ""}`,
    capability.description,
    "",
    "Input:",
    "```ts",
    describeInput(capability),
    "```",
    "Ready to run with execute (put values in params):",
    "```ts",
    `import { kody } from 'kody:runtime'`,
    "",
    "export default async function main(params) {",
    `\treturn await kody.${capability.name}(params)`,
    "}",
    "```",
  ].join("\n");
}

function entityDetail(ref: string) {
  const [type, ...rest] = ref.split(":");
  const id = rest.join(":");
  if (type === "capability") {
    const capability = getCapability(id);
    return capability ? capabilityDetail(capability) : `No capability "${id}".`;
  }
  if (type === "package") {
    const manifest = getPackage(id);
    return manifest ? packageDetail(manifest) : `No saved package "${id}".`;
  }
  if (type === "guide") {
    const guide = readGuides().find((candidate) => candidate.id === id);
    return guide ? guide.markdown : `No guide "${id}".`;
  }
  if (type === "secret") {
    const secret = listSecretNames().find((candidate) => candidate.name === id);
    return secret
      ? `## secret:${id}\nAllowed hosts: ${secret.allowedHosts.join(", ") || "none"}\nUse \`{{secret:${id}}}\` inside a fetch URL, header or body. The value is substituted outside the sandbox.`
      : `No secret "${id}".`;
  }
  return `Unknown ref "${ref}". Types: capability, package, guide, secret.`;
}

function domainIndex(entries: Array<SearchEntry>) {
  const domains = new Map<string, Array<string>>();
  for (const entry of entries) {
    domains.set(entry.domain, [
      ...(domains.get(entry.domain) ?? []),
      entry.title,
    ]);
  }
  const rows = [...domains].map(
    ([domain, titles]) =>
      `- **${domain}** (${titles.length}): ${titles.slice(0, 4).join(", ")}`,
  );
  return [
    "# Domains",
    ...rows,
    "",
    'Follow up with { "domain": "<id>" }, { "query": "..." } or { "entity": "<type>:<id>" }.',
  ].join("\n");
}

export function search(input: SearchInput) {
  if (input.entity) {
    const refs = Array.isArray(input.entity) ? input.entity : [input.entity];
    return refs.map(entityDetail).join("\n\n");
  }
  const entries = buildEntries().filter(
    (entry) => !input.domain || entry.domain === input.domain,
  );
  if (!input.query) {
    if (!input.domain) return domainIndex(entries);
    return [
      `# Domain ${input.domain}`,
      ...entries.map((entry) => `- \`${entry.ref}\`: ${entry.summary}`),
    ].join("\n");
  }
  const queryTokens = tokenize(input.query);
  const ranked = entries
    .map((entry) => ({ entry, score: score(entry, queryTokens) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  if (ranked.length === 0) {
    return `# Search results\nNothing matched "${input.query}".\n\n${domainIndex(entries)}`;
  }
  const lines = ranked.map(({ entry }, index) => {
    const shape =
      entry.callShape && index < 3 ? ` Call: \`${entry.callShape}\`` : "";
    return `- \`${entry.ref}\`: ${entry.summary}${shape}`;
  });
  return [
    "# Search results",
    ...lines,
    "",
    'Open one with { "entity": "<ref>" } for types and a ready-to-run module.',
  ].join("\n");
}
