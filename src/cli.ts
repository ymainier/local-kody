import { ask, readFlags } from "./daemon-client.ts";

// The daemon is the only writer, so the CLI asks it rather than opening the
// database (or the Keychain) itself. The value travels over a 0600 socket that
// only this user can open.
const usage = `Commands:
  npm run secret -- set <name> <value> --host <host> [--host <host>]
  npm run secret -- allow <name> <host>
  npm run secret -- remove <name>
  npm run secret -- list
  npm run secret -- migrate      import secrets.json into the Keychain, then delete it`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "set": {
    const [name, value] = rest;
    if (!name || !value) throw new Error(usage);
    const hosts = readFlags(rest, "--host");
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
