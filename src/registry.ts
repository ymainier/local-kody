import { z } from "zod";

// A capability is a typed host function the sandbox reaches as `kody.<name>(input)`.
// It is never exposed to the model as its own MCP tool: search surfaces it,
// execute calls it.
export type Capability = {
  name: string;
  domain: string;
  description: string;
  keywords: Array<string>;
  destructive: boolean;
  inputSchema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
};

type CapabilityDefinition<TInput extends z.ZodType> = {
  name: string;
  domain: string;
  description: string;
  keywords?: Array<string>;
  destructive?: boolean;
  inputSchema: TInput;
  handler: (input: z.infer<TInput>) => Promise<unknown>;
};

const capabilities = new Map<string, Capability>();

export function defineCapability<TInput extends z.ZodType>(
  definition: CapabilityDefinition<TInput>,
) {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(definition.name)) {
    throw new Error(
      `Capability name "${definition.name}" must be an identifier`,
    );
  }
  capabilities.set(definition.name, {
    name: definition.name,
    domain: definition.domain,
    description: definition.description,
    keywords: definition.keywords ?? [],
    destructive: definition.destructive ?? false,
    inputSchema: definition.inputSchema,
    handler: async (input) =>
      await definition.handler(definition.inputSchema.parse(input ?? {})),
  });
}

export function listCapabilities() {
  return [...capabilities.values()];
}

export function getCapability(name: string) {
  return capabilities.get(name);
}

export async function callCapability(name: string, input: unknown) {
  const capability = capabilities.get(name);
  if (!capability) {
    throw new Error(
      `Unknown capability "${name}". Use search to find capability names.`,
    );
  }
  return await capability.handler(input);
}

export function describeInput(capability: Capability) {
  return describeJsonSchema(z.toJSONSchema(capability.inputSchema));
}

// Renders a JSON Schema object as a TypeScript-ish shape. Used for capability
// inputs and for the tool schemas other MCP servers report.
export function describeJsonSchema(raw: unknown) {
  const schema = raw as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: Array<string>;
  };
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return "{}";
  const required = new Set(schema.required ?? []);
  const lines = properties.map(([key, property]) => {
    const optional = required.has(key) ? "" : "?";
    const comment = property.description ? ` // ${property.description}` : "";
    return `  ${key}${optional}: ${property.type ?? "unknown"}${comment}`;
  });
  return `{\n${lines.join("\n")}\n}`;
}
