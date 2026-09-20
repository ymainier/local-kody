import { ask, readFlags } from "./daemon-client.ts";
import { readPresets } from "./integrations.ts";

// Configuring a provider means handing over a client id and secret from an app
// you registered, which is a user job. Connecting it is the agent's, through
// kody.integrationStart.
const usage = `Commands:
  npm run integration -- add <id> --client-id <id> --client-secret <secret> [--scope <scope>] [--host <host>] [--auth-url <url>] [--token-url <url>] [--redirect-port <port>]
  npm run integration -- allow <id> <host>
  npm run integration -- remove <id>
  npm run integration -- list
  npm run integration -- presets

Known ids fill in their URLs, scopes and hosts from presets/oauth-providers.json: ${Object.keys(readPresets()).join(", ")}`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "add": {
    const [id] = rest;
    const clientId = readFlags(rest, "--client-id")[0];
    const clientSecret = readFlags(rest, "--client-secret")[0];
    const redirectPort = readFlags(rest, "--redirect-port")[0];
    if (!id || !clientId || !clientSecret) throw new Error(usage);
    const integration = (await ask("/integrations/add", {
      id,
      clientId,
      clientSecret,
      scopes: readFlags(rest, "--scope"),
      allowedHosts: readFlags(rest, "--host"),
      authUrl: readFlags(rest, "--auth-url")[0],
      tokenUrl: readFlags(rest, "--token-url")[0],
      redirectPort: redirectPort ? Number(redirectPort) : undefined,
    })) as { allowedHosts: Array<string>; redirectPort: number | null };
    console.log(
      `Configured "${id}" for ${integration.allowedHosts.join(", ")}.`,
      integration.redirectPort
        ? `Register http://127.0.0.1:${integration.redirectPort}/callback as the redirect URI.`
        : "The redirect port is chosen per connection, so register http://127.0.0.1 as a loopback redirect.",
    );
    console.log(
      `Now ask your agent to connect it: kody.integrationStart({ id: '${id}' })`,
    );
    break;
  }
  case "allow": {
    const [id, host] = rest;
    if (!id || !host) throw new Error(usage);
    await ask("/integrations/allow", { id, host });
    console.log(`"${id}" may now be sent to ${host}`);
    break;
  }
  case "remove": {
    const [id] = rest;
    if (!id) throw new Error(usage);
    await ask("/integrations/remove", { id });
    console.log(`Removed "${id}"`);
    break;
  }
  case "list":
    console.table(await ask("/integrations/list", {}));
    break;
  case "presets":
    for (const [id, preset] of Object.entries(readPresets())) {
      console.log(`${id}: ${preset.note}`);
    }
    break;
  default:
    console.log(usage);
}
