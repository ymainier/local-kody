import { allowSecretHost, listSecretNames, setSecret } from "./secrets.ts";

// npm run secret -- set <name> <value> --host <host> [--host <host>]
// npm run secret -- allow <name> <host>
// npm run secret -- list
const [command, ...rest] = process.argv.slice(2);

function readHosts(args: Array<string>) {
  const hosts: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host" && args[index + 1])
      hosts.push(args[index + 1] ?? "");
  }
  return hosts;
}

switch (command) {
  case "set": {
    const [name, value] = rest;
    if (!name || !value)
      throw new Error("Usage: set <name> <value> --host <host>");
    setSecret(name, value, readHosts(rest));
    console.log(
      `Saved secret "${name}" for ${readHosts(rest).join(", ") || "no hosts yet"}`,
    );
    break;
  }
  case "allow": {
    const [name, host] = rest;
    if (!name || !host) throw new Error("Usage: allow <name> <host>");
    allowSecretHost(name, host);
    console.log(`"${name}" may now be sent to ${host}`);
    break;
  }
  case "list":
    console.table(listSecretNames());
    break;
  default:
    console.log(
      "Commands: set <name> <value> --host <host> | allow <name> <host> | list",
    );
}
