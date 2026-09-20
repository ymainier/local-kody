import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { keychainFile } from "./paths.ts";

const execFileAsync = promisify(execFile);

// Where a secret's value lives. Metadata (name, approved hosts) stays in
// SQLite; only the value goes here, so listing secrets never needs the
// Keychain and never risks a prompt.
export type Keychain = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
};

const service = "local-kody";

// `security` takes the password as an argument, which would put it in argv for
// any `ps` to read. Its interactive mode takes the same command on stdin
// instead. Values are base64 so the line is one shell-safe token whatever the
// secret contains, and so read-back is ASCII rather than security's hex form
// for anything non-UTF8.
function securityInteractive(command: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("security", ["-i"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`security exited ${String(code)}: ${stderr.trim()}`));
    });
    child.stdin.end(`${command}\n`);
  });
}

const macKeychain: Keychain = {
  async get(name) {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        service,
        "-a",
        name,
        "-w",
      ]);
      return Buffer.from(stdout.trim(), "base64").toString("utf8");
    } catch {
      return null;
    }
  },
  async set(name, value) {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    await securityInteractive(
      `add-generic-password -U -s ${service} -a ${name} -w ${encoded}`,
    );
  },
  async remove(name) {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s",
        service,
        "-a",
        name,
      ]);
    } catch {
      // Already gone is the state the caller wanted.
    }
  },
};

// A test double, and what runs where there is no Keychain. It is a plaintext
// 0600 file: the point is to keep `npm test` off your real Keychain, not to
// protect anything.
type KeychainFile = Record<string, string>;

function readKeychainFile(): KeychainFile {
  if (!existsSync(keychainFile)) return {};
  return JSON.parse(readFileSync(keychainFile, "utf8")) as KeychainFile;
}

function writeKeychainFile(contents: KeychainFile) {
  writeFileSync(keychainFile, JSON.stringify(contents, null, 2), {
    mode: 0o600,
  });
}

const fileKeychain: Keychain = {
  async get(name) {
    return readKeychainFile()[name] ?? null;
  },
  async set(name, value) {
    writeKeychainFile({ ...readKeychainFile(), [name]: value });
  },
  async remove(name) {
    const contents = readKeychainFile();
    delete contents[name];
    writeKeychainFile(contents);
  },
};

export function keychain(): Keychain {
  if (process.env.KODY_KEYCHAIN === "file" || process.platform !== "darwin") {
    return fileKeychain;
  }
  return macKeychain;
}
