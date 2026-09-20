import { request as httpRequest } from "node:http";
import { socketFile } from "./paths.ts";

// The daemon is the only writer, so the CLI asks it rather than opening the
// database (or the Keychain) itself. The value travels over a 0600 socket that
// only this user can open.
const usage = `Commands:
  npm run secret -- set <name> <value> --host <host> [--host <host>]
  npm run secret -- allow <name> <host>
  npm run secret -- remove <name>
  npm run secret -- list
  npm run secret -- migrate      import secrets.json into the Keychain, then delete it`;

const notRunning = `The local-kody daemon is not running, so there is nowhere to put the secret.
Start it with \`npm run daemon:install\` (launchd) or \`npm run daemon\` (foreground), then try again.`;

function callDaemon(path: string, body: unknown) {
  return new Promise<{ result?: unknown; error?: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        { socketPath: socketFile, path, method: "POST" },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
                result?: unknown;
                error?: string;
              },
            ),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(body ?? {}));
    },
  );
}

async function ask(path: string, body: unknown) {
  try {
    const envelope = await callDaemon(path, body);
    if (envelope.error) throw new Error(envelope.error);
    return envelope.result;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ECONNREFUSED")
      throw new Error(notRunning);
    throw error;
  }
}

function readHosts(args: Array<string>) {
  const hosts: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host" && args[index + 1]) {
      hosts.push(args[index + 1] ?? "");
    }
  }
  return hosts;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "set": {
    const [name, value] = rest;
    if (!name || !value) throw new Error(usage);
    const hosts = readHosts(rest);
    await ask("/secrets/set", { name, value, allowedHosts: hosts });
    console.log(
      `Saved "${name}" to the Keychain for ${hosts.join(", ") || "no hosts yet"}`,
    );
    break;
  }
  case "allow": {
    const [name, host] = rest;
    if (!name || !host) throw new Error(usage);
    await ask("/secrets/allow", { name, host });
    console.log(`"${name}" may now be sent to ${host}`);
    break;
  }
  case "remove": {
    const [name] = rest;
    if (!name) throw new Error(usage);
    await ask("/secrets/remove", { name });
    console.log(`Removed "${name}"`);
    break;
  }
  case "list":
    console.table(await ask("/secrets/list", {}));
    break;
  case "migrate": {
    const outcome = (await ask("/secrets/migrate", {})) as {
      migrated: Array<string>;
      removed: boolean;
    };
    console.log(
      outcome.removed
        ? `Moved ${outcome.migrated.join(", ")} into the Keychain and deleted secrets.json`
        : "No secrets.json to migrate.",
    );
    break;
  }
  default:
    console.log(usage);
}
