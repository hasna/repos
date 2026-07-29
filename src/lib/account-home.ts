/**
 * The account home directory, resolved from the operating system account
 * database rather than from `$HOME`.
 *
 * Every canonical Hasna path on a station hangs off this value, so whoever
 * controls it controls where a "canonical" path lands. `$HOME` is process
 * environment state: any caller — an agent, a wrapper script, a postinstall
 * hook — can set it before invoking the CLI and move the canonical root
 * somewhere the guards were never meant to allow. On a multi-agent station
 * that is not a hypothetical; it is the cheapest possible escape from a
 * containment check written in terms of the root.
 *
 * So the root is derived from the uid's passwd entry instead. A caller can
 * still lie about a lot of things, but not about which account the process is
 * running as.
 *
 * Returns `null` when the account database cannot answer, so each caller can
 * fail in its own error vocabulary. It never guesses, and it never silently
 * falls back to `$HOME` — a wrong home here is a containment bypass, not an
 * inconvenience.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";

const LOOKUP_TIMEOUT_MS = 5_000;

function fromPasswdFile(uid: number): string | null {
  try {
    const entry = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => Number(fields[2]) === uid);
    const home = entry?.[5];
    if (home && isAbsolute(home)) return resolve(home);
  } catch {
    // macOS commonly keeps directory-service users out of /etc/passwd.
  }
  return null;
}

function fromDirectoryService(uid: number): string | null {
  try {
    const output = execFileSync("dscacheutil", ["-q", "user", "-a", "uid", String(uid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    const home = output.match(/^dir:\s*(\S.+)$/m)?.[1]?.trim();
    if (home && isAbsolute(home)) return resolve(home);
  } catch {
    // Fall through to dscl below.
  }
  try {
    const username = execFileSync("id", ["-nu", String(uid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    }).trim();
    const output = execFileSync("dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    const home = output.match(/^NFSHomeDirectory:\s*(\S.+)$/m)?.[1]?.trim();
    if (home && isAbsolute(home)) return resolve(home);
  } catch {
    // Undecidable — the caller fails closed.
  }
  return null;
}

/**
 * The home directory of the account this process runs as, or `null` when the
 * operating system cannot be asked.
 *
 * On Windows there is no uid to look up and no passwd database, so `userInfo()`
 * is the account database; it is not process environment state the way `$HOME`
 * is on POSIX.
 */
export function resolveTrustedAccountHome(): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null || process.platform === "win32") {
    const home = userInfo().homedir;
    return home && isAbsolute(home) ? resolve(home) : null;
  }
  return fromPasswdFile(uid) ?? (process.platform === "darwin" ? fromDirectoryService(uid) : null);
}
