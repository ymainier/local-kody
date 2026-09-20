import { request as httpRequest } from "node:http";
import { socketFile } from "./paths.ts";

// Everything that is not the daemon asks it over this socket: the MCP proxy
// and both CLIs. Nothing else opens the store.
export const daemonNotRunning = `The local-kody daemon is not running.
Start it with \`npm run daemon:install\` (launchd) or \`npm run daemon\` (foreground), then try again.
Logs: \`npm run daemon:logs\`.`;

export type DaemonEnvelope = { result?: unknown; error?: string };

export function callDaemon(path: string, body: unknown) {
  return new Promise<DaemonEnvelope>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        socketPath: socketFile,
        path,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(
              JSON.parse(
                Buffer.concat(chunks).toString("utf8") || "{}",
              ) as DaemonEnvelope,
            );
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(body ?? {}));
  });
}

export function isDaemonMissing(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

// For the CLIs: unwrap the envelope, and turn "no socket" into instructions.
export async function ask(path: string, body: unknown) {
  try {
    const envelope = await callDaemon(path, body);
    if (envelope.error) throw new Error(envelope.error);
    return envelope.result;
  } catch (error) {
    if (isDaemonMissing(error)) throw new Error(daemonNotRunning);
    throw error;
  }
}

// --flag value, repeated flags collected in order.
export function readFlags(args: Array<string>, flag: string) {
  const values: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1])
      values.push(args[index + 1] ?? "");
  }
  return values;
}
