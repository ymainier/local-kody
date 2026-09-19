import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLogFile, logsDir } from "./paths.ts";

// node src/launchd.ts install | uninstall | logs
// launchd is what makes the daemon outlive Claude Desktop: RunAtLoad starts it
// at login, KeepAlive restarts it after a crash.
const label = "dev.local-kody.daemon";
const plistFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), "daemon.ts");
const domain = `gui/${userInfo().uid}`;

function plist() {
  // process.execPath: launchd starts with a bare environment and no shell, so
  // every path has to be absolute.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${process.execPath}</string>
		<string>${daemonEntry}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${daemonLogFile}</string>
	<key>StandardErrorPath</key>
	<string>${daemonLogFile}</string>
</dict>
</plist>
`;
}

function launchctl(args: Array<string>) {
  try {
    execFileSync("launchctl", args, { stdio: "pipe" });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr}`);
  }
}

const [command] = process.argv.slice(2);

switch (command) {
  case "install": {
    mkdirSync(dirname(plistFile), { recursive: true });
    writeFileSync(plistFile, plist());
    if (existsSync(plistFile)) {
      try {
        launchctl(["bootout", `${domain}/${label}`]);
      } catch {
        // Not loaded yet, which is the normal first-install case.
      }
    }
    launchctl(["bootstrap", domain, plistFile]);
    console.log(`Installed ${label}. Logs: ${daemonLogFile}`);
    break;
  }
  case "uninstall": {
    launchctl(["bootout", `${domain}/${label}`]);
    console.log(`Removed ${label}. The plist stays at ${plistFile}.`);
    break;
  }
  case "logs": {
    mkdirSync(logsDir, { recursive: true });
    if (!existsSync(daemonLogFile)) {
      console.log(`No log yet at ${daemonLogFile}`);
      break;
    }
    console.log(
      readFileSync(daemonLogFile, "utf8").split("\n").slice(-200).join("\n"),
    );
    break;
  }
  default:
    console.log("Commands: install | uninstall | logs");
}
