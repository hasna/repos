/**
 * Does the worktree plane work on a station that holds no GitHub credential?
 *
 * This is the property the whole R5 directive turns on. The owner's reason for
 * wanting repository and worktree verbs in `repos` is that "if we run [agents]
 * in different stations, we will not have to give them all the credentials in
 * the world" — so a verb that merely wraps git while the caller still needs a
 * token has delivered nothing.
 *
 * The worktree plane is the half that can satisfy that today: it is pure local
 * git against an existing checkout. This file proves it, and — because a check
 * that cannot fail is not evidence — it proves the check itself works:
 *
 *   - the sanitised child sees no GitHub credential *and* the same probe, run
 *     against a child with a planted token, reports finding one;
 *   - the sanitised child cannot reach the station's `gh` credential store *and*
 *     the same probe, run with the real HOME, reports the store is right there;
 *   - the module references no credential name *and* the same scanner, run over
 *     a file that does reference them, flags every one.
 *
 * No credential value is ever read, printed or asserted on. The probes report
 * booleans, counts and variable *names*.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKTREES_MODULE = join(import.meta.dir, "worktrees.ts");

/** Credential-bearing environment variable names, by name only. */
const CREDENTIAL_ENV_NAMES = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GIT_ASKPASS_TOKEN|GITHUB_.*_TOKEN)$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Repos Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Repos Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

/**
 * A checkout, a registry pointing at it, a scratch worktree root, and a scratch
 * HOME with nothing in it.
 */
function seed() {
  tempDir = mkdtempSync(join(tmpdir(), "repos-credfree-"));
  const scratchHome = join(tempDir, "home");
  mkdirSync(scratchHome, { recursive: true });
  const root = join(tempDir, "worktrees");
  mkdirSync(root, { recursive: true });

  const originPath = join(tempDir, "origin.git");
  const seedPath = join(tempDir, "seed");
  mkdirSync(seedPath, { recursive: true });
  git(tempDir, ["init", "--bare", "--initial-branch=main", originPath]);
  git(seedPath, ["init", "--initial-branch=main"]);
  writeFileSync(join(seedPath, "README.md"), "seed\n");
  git(seedPath, ["add", "README.md"]);
  git(seedPath, ["commit", "-m", "seed"]);
  git(seedPath, ["remote", "add", "origin", originPath]);
  git(seedPath, ["push", "-u", "origin", "main"]);

  const clonePath = join(tempDir, "clone");
  git(tempDir, ["clone", originPath, clonePath]);

  const dbPath = join(tempDir, "repos.db");
  const db = getDb(dbPath);
  db.prepare(
    "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, 'open-credfree', 'hasna', ?, 'main', ?)",
  ).run(clonePath, "github.com/hasna/credfree", "2026-07-01 00:00:00");
  closeDb();

  return { scratchHome, root, clonePath, dbPath };
}

/**
 * An environment built from nothing, rather than the ambient one with a few
 * names deleted.
 *
 * Deleting names is how the fleet has fooled itself before: `bash -lc` re-reads
 * the profile from disk, so a login-shell child restores everything the parent
 * removed (measured: `bash -c` yields 5 variables and 0 `HASNA_*`; `bash -lc`
 * yields 72 and 61). Nothing here goes through a shell, and the child's whole
 * environment is the object below.
 */
function sanitizedEnv(seeded: ReturnType<typeof seed>, extra: Record<string, string> = {}) {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: seeded.scratchHome,
    // A gh config dir under the scratch HOME, so `gh` cannot fall back to the
    // station's real hosts.yml through its own default.
    GH_CONFIG_DIR: join(seeded.scratchHome, ".config", "gh"),
    XDG_CONFIG_HOME: join(seeded.scratchHome, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Repos Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Repos Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    HASNA_REPOS_DB_PATH: seeded.dbPath,
    ...extra,
  };
}

interface DriverReport {
  ok: boolean;
  error?: string;
  credential_env_names: string[];
  gh_hosts_file_reachable: boolean;
  gh_auth_status_rc: number | null;
  git_global_user: string;
  added_path?: string;
  list_issue_count?: number;
  removed?: boolean;
  base_source?: string;
}

/**
 * The child process. It calls the module directly rather than the CLI so the
 * worktree root can be pinned to a scratch directory — the canonical root is
 * deliberately not overridable by an environment variable, which is the point
 * of `trustedAccountHome`, and a test must not write into the live root that
 * other agents are working in.
 */
function writeDriver(seeded: ReturnType<typeof seed>): string {
  const driverPath = join(tempDir, "driver.ts");
  writeFileSync(
    driverPath,
    `
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  setWorktreeRootForTests,
} from ${JSON.stringify(WORKTREES_MODULE)};

const report = {
  ok: false,
  credential_env_names: Object.keys(process.env).filter((name) =>
    ${CREDENTIAL_ENV_NAMES.toString()}.test(name)),
  gh_hosts_file_reachable: existsSync(join(process.env.HOME ?? "", ".config", "gh", "hosts.yml")),
  gh_auth_status_rc: null,
  git_global_user: "",
};

try {
  execFileSync("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  report.gh_auth_status_rc = 0;
} catch (error) {
  const status = (error && typeof error === "object" && "status" in error) ? error.status : null;
  // A missing gh binary and an unauthenticated gh both close the ambient path.
  report.gh_auth_status_rc = typeof status === "number" ? status : -1;
}

try {
  report.git_global_user = execFileSync("git", ["config", "--global", "--get", "user.name"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  }).trim();
} catch {
  report.git_global_user = "";
}

if (process.env.DRIVER_EXERCISE === "1") {
  setWorktreeRootForTests(${JSON.stringify("")} || process.env.DRIVER_ROOT);
  try {
    const added = addWorktree({ repo: "open-credfree", task: "credfree-check" });
    const listed = listWorktrees();
    const removed = removeWorktree({ ref: added.lease.lease_id });
    Object.assign(report, {
      ok: true,
      added_path: added.path,
      base_source: added.base.source,
      list_issue_count: listed.summary.issue_count,
      removed: removed.removed,
    });
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? \`\${(error as any).code ?? "ERROR"}: \${error.message}\` : String(error);
  }
} else {
  report.ok = true;
}

process.stdout.write(JSON.stringify(report));
`,
  );
  return driverPath;
}

function runDriver(
  seeded: ReturnType<typeof seed>,
  env: Record<string, string>,
): { report: DriverReport; code: number | null; stderr: string } {
  const driverPath = writeDriver(seeded);
  const result = Bun.spawnSync({
    cmd: ["bun", "run", driverPath],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  let report: DriverReport;
  try {
    report = JSON.parse(stdout) as DriverReport;
  } catch {
    throw new Error(`driver produced no JSON. stderr: ${stderr.slice(0, 800)}`);
  }
  return { report, code: result.exitCode, stderr };
}

describe("the worktree plane needs no GitHub credential", () => {
  test("add, list and remove all succeed in a child process holding no credential", () => {
    const seeded = seed();
    const { report, code } = runDriver(
      seeded,
      sanitizedEnv(seeded, { DRIVER_EXERCISE: "1", DRIVER_ROOT: seeded.root }),
    );

    expect(code).toBe(0);
    expect(report.credential_env_names).toEqual([]);
    expect(report.gh_hosts_file_reachable).toBe(false);
    expect(report.gh_auth_status_rc).not.toBe(0);
    expect(report.git_global_user).toBe("");

    expect(report.error).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.added_path).toBe(join(seeded.root, "open-credfree", "credfree-check"));
    expect(report.base_source).toBe("origin");
    expect(report.removed).toBe(true);
  });

  test("POSITIVE CONTROL: the credential-env probe finds a token when one is present", () => {
    // Without this, "credential_env_names was empty" proves nothing — an
    // always-empty probe returns the same answer. The value planted here is a
    // literal fixture string, not a credential.
    const seeded = seed();
    const { report } = runDriver(
      seeded,
      sanitizedEnv(seeded, { GITHUB_TOKEN: "planted-fixture-value-not-a-credential" }),
    );
    expect(report.credential_env_names).toEqual(["GITHUB_TOKEN"]);
  });

  test("POSITIVE CONTROL: the gh-store probe finds the station's real credential store", () => {
    // The sanitised run asserts `gh_hosts_file_reachable === false`. That is
    // only evidence if the same probe can return true — and on this station it
    // can, because the store is there: a plaintext hosts.yml readable by every
    // process running as this user, which is the exposure the broker exists to
    // close. Only its presence and size are asserted; the file is never read.
    const seeded = seed();
    const realHome = process.env["HOME"];
    const realStore = realHome ? join(realHome, ".config", "gh", "hosts.yml") : "";
    if (!realStore || !existsSync(realStore)) {
      // No store on this machine — the control cannot run, and saying so is
      // better than passing silently.
      expect(realStore === "" || !existsSync(realStore)).toBe(true);
      return;
    }

    // Both the HOME-relative path and gh's own config-dir override are restored.
    // Restoring HOME alone is not enough — measured here: with GH_CONFIG_DIR
    // still pointing at the scratch directory, `gh auth status` exits 1 even
    // though hosts.yml is sitting under HOME. That is worth stating, because it
    // means GH_CONFIG_DIR is independently sufficient to close the gh path.
    const { report } = runDriver(seeded, sanitizedEnv(seeded, {
      HOME: realHome!,
      GH_CONFIG_DIR: join(realHome!, ".config", "gh"),
      XDG_CONFIG_HOME: join(realHome!, ".config"),
    }));
    expect(report.gh_hosts_file_reachable).toBe(true);
    expect(report.gh_auth_status_rc).toBe(0);
  });
});

describe("the worktree module names no credential", () => {
  /** Credential-shaped identifiers a module of this kind must not reference. */
  const FORBIDDEN = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    ".netrc",
    "hosts.yml",
    "credential.helper",
  ];

  function scan(source: string): string[] {
    return FORBIDDEN.filter((needle) => source.includes(needle));
  }

  test("no credential name appears in the worktree module", () => {
    expect(scan(readFileSync(WORKTREES_MODULE, "utf8"))).toEqual([]);
  });

  test("no `gh` subprocess is spawned from the worktree module", () => {
    const source = readFileSync(WORKTREES_MODULE, "utf8");
    expect(source).not.toMatch(/execFileSync\(\s*["']gh["']/);
    expect(source).not.toMatch(/spawnSync\(\s*["']gh["']/);
  });

  test("POSITIVE CONTROL: the scanner flags every forbidden name when they are present", () => {
    // A scanner that matches nothing passes the two tests above for free.
    tempDir = mkdtempSync(join(tmpdir(), "repos-credscan-"));
    const planted = join(tempDir, "planted.ts");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(
      planted,
      [
        'const a = process.env["GH_TOKEN"];',
        'const b = process.env["GITHUB_TOKEN"];',
        'const c = process.env["GH_ENTERPRISE_TOKEN"];',
        'const d = "~/.netrc";',
        'const e = "~/.config/gh/hosts.yml";',
        'const f = "credential.helper";',
      ].join("\n"),
    );
    expect(scan(readFileSync(planted, "utf8")).sort()).toEqual([...FORBIDDEN].sort());
  });
});
