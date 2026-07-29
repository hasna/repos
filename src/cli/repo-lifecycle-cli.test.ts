/**
 * The repository plane as CLI verbs — `repos create`, `repos clone`,
 * `repos archive` — and the credential boundary they exist to enforce.
 *
 * The R5 directive's rationale is the requirement: an agent calls the verb and
 * never holds a GitHub credential. That decomposes into properties this file
 * asserts against the real CLI, each with a positive control, because a check
 * that cannot fail is not evidence:
 *
 *   - **The caller's token is never the operation's authority.** A token
 *     planted in the caller's environment must be absent from the environment
 *     of every `gh` child the CLI spawns. Control: a canary variable planted
 *     the same way IS visible to the child, so the probe demonstrably reads
 *     the child environment; and when the CLI's own credential command is
 *     configured, a token DOES appear — the same probe finds a token when one
 *     is supposed to be there.
 *   - **Fail closed.** When the configured credential command fails or returns
 *     nothing, the verb exits non-zero with CREDENTIAL_UNAVAILABLE and `gh` is
 *     never spawned — asserted from the shim's call log, which the happy-path
 *     tests prove is written on every invocation.
 *   - **The resolved token never reaches the caller.** A hostile shim echoes
 *     the token it received back on stderr; the CLI's error output must not
 *     contain it. Control: the shim's own log does, so the token was really
 *     in play.
 *
 * No real network, no real credential: `gh` is a recording shim on PATH.
 * Token values in this file are fabricated markers, not credentials.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Fabricated markers; never real credentials. Deliberately NOT provider-
 * prefixed: the command token must be caught by the exact-value redaction
 * (a vault-minted token can have a shape no prefix list anticipates), and the
 * prefix rule would mask a regression in that leg.
 */
const CALLER_TOKEN = "vault-caller-marker-0123456789abcdef";
const COMMAND_TOKEN = "vault-minted-marker-fedcba9876543210";

interface Fixture {
  dbPath: string;
  configPath: string;
  shimDir: string;
  logDir: string;
  workDir: string;
}

/**
 * A `gh` shim that records every invocation (argv on one line each, the full
 * environment to a numbered file) and answers from a scripted scenario:
 *
 *   GH_SHIM_EXISTING=1      `api repos/...` preflight reports the repo exists
 *   GH_SHIM_CREATE_FAIL=1   `repo create` fails, echoing its own GH_TOKEN to
 *                           stderr — the hostile case redaction must survive
 *   GH_SHIM_AUTH_FAIL=1     every subcommand fails like an unauthenticated gh
 *
 * `repo clone` produces a real git repository at the destination so the
 * registration leg has something true to index.
 */
function seed(config: object = {}): Fixture {
  tempDir = mkdtempSync(join(tmpdir(), "repos-lifecycle-"));
  const shimDir = join(tempDir, "shim");
  const logDir = join(tempDir, "log");
  const workDir = join(tempDir, "work");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const shim = `#!/usr/bin/env bash
set -u
seq=$(ls "$GH_SHIM_LOG_DIR" | grep -c '^env-' || true)
printf '%s\\n' "$*" >> "$GH_SHIM_LOG_DIR/argv.log"
env > "$GH_SHIM_LOG_DIR/env-$seq"
if [ "\${GH_SHIM_AUTH_FAIL:-0}" = "1" ]; then
  echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2
  exit 4
fi
case "$1 $2" in
  "api repos/"*)
    if [ "\${GH_SHIM_EXISTING:-0}" = "1" ]; then echo "12345"; exit 0; fi
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
    ;;
  "repo create")
    if [ "\${GH_SHIM_CREATE_FAIL:-0}" = "1" ]; then
      echo "gh: boom while holding \${GH_TOKEN:-no-token}" >&2
      exit 1
    fi
    echo "https://github.com/$3"
    exit 0
    ;;
  "repo clone")
    dest="$4"
    mkdir -p "$dest"
    git -C "$dest" init -q -b main
    echo "clone" > "$dest/README.md"
    git -C "$dest" add README.md
    git -C "$dest" -c user.name=t -c user.email=t@t commit -q -m init
    git -C "$dest" remote add origin "https://github.com/$3.git"
    exit 0
    ;;
  "repo archive"|"repo unarchive")
    exit 0
    ;;
esac
echo "gh shim: unscripted call: $*" >&2
exit 64
`;
  writeFileSync(join(shimDir, "gh"), shim);
  chmodSync(join(shimDir, "gh"), 0o755);

  const dbPath = join(tempDir, "repos.db");
  getDb(dbPath);
  closeDb();

  const configPath = join(tempDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));

  return { dbPath, configPath, shimDir, logDir, workDir };
}

/** A credential command the CLI can be configured with. */
function writeCredentialCommand(fixture: Fixture, body: string): string {
  const path = join(tempDir, "cred-cmd.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function runCli(fixture: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: `${fixture.shimDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: tempDir,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      HASNA_REPOS_DB_PATH: fixture.dbPath,
      HASNA_REPOS_CONFIG_PATH: fixture.configPath,
      GH_SHIM_LOG_DIR: fixture.logDir,
      // The canary rides next to the planted token: if the child environment
      // recording could not see variables, the canary assertions would fail.
      REPOS_TEST_CANARY: "canary-visible",
      GH_TOKEN: CALLER_TOKEN,
      GITHUB_TOKEN: CALLER_TOKEN,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The CLI's JSON result is pretty-printed; parse it from the first brace. */
function parseCliJson(stdout: string): any {
  const start = stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start));
}

function ghInvocations(fixture: Fixture): string[] {
  const log = join(fixture.logDir, "argv.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function ghChildEnvs(fixture: Fixture): string[] {
  return readdirSync(fixture.logDir)
    .filter((name) => name.startsWith("env-"))
    .map((name) => readFileSync(join(fixture.logDir, name), "utf8"));
}

describe("repos create", () => {
  test("creates through the shim and reports the URL", () => {
    const fixture = seed();
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"]);
    expect(result.code).toBe(0);
    const payload = parseCliJson(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.repo.org).toBe("hasna");
    expect(payload.repo.name).toBe("scratch-r5");
    expect(payload.repo.url).toBe("https://github.com/hasna/scratch-r5");
    expect(payload.repo.visibility).toBe("private");
    const calls = ghInvocations(fixture);
    expect(calls.some((line) => line.startsWith("api repos/hasna/scratch-r5"))).toBe(true);
    expect(calls.some((line) => line.startsWith("repo create hasna/scratch-r5"))).toBe(true);
    expect(calls.some((line) => line.includes("--private"))).toBe(true);
  });

  test("scrubs the caller's token from every gh child — and the canary proves the probe sees the env", () => {
    const fixture = seed();
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"]);
    expect(result.code).toBe(0);
    const envs = ghChildEnvs(fixture);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      // Positive control: the recording sees the child environment at all.
      expect(env).toContain("REPOS_TEST_CANARY=canary-visible");
      // The boundary: the caller's credential names are gone, value and name.
      expect(env).not.toContain(CALLER_TOKEN);
      expect(env).not.toMatch(/^GH_TOKEN=/m);
      expect(env).not.toMatch(/^GITHUB_TOKEN=/m);
      expect(env).not.toMatch(/^GH_ENTERPRISE_TOKEN=/m);
      expect(env).not.toMatch(/^GITHUB_ENTERPRISE_TOKEN=/m);
    }
  });

  /**
   * Scrubbing the token variables is not sufficient on its own: `gh` resolves
   * its credential store from `GH_CONFIG_DIR`, then `XDG_CONFIG_HOME/gh`, then
   * `$HOME/.config/gh`. Either of the first two, set by the caller, substitutes
   * the identity that performs the mutation while the result still reports
   * `credential_source: "gh-store"`.
   *
   * Measured before the fix against the real CLI and a genuinely private
   * repository: `GH_CONFIG_DIR` pointed at a caller-written `hosts.yml` made gh
   * fail `HTTP 401: Bad credentials`, where the same call with the variable
   * absent succeeded through the station store. So the caller's redirection was
   * reaching the child, and this asserts it no longer does.
   */
  test("scrubs the caller's gh config-dir redirections, so the station store is the only one reachable", () => {
    const fixture = seed();
    const callerStore = join(tempDir, "caller-gh-store");
    mkdirSync(callerStore, { recursive: true });
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"], {
      GH_CONFIG_DIR: callerStore,
      XDG_CONFIG_HOME: callerStore,
    });
    expect(result.code).toBe(0);
    const envs = ghChildEnvs(fixture);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      // Positive control: this recording does see caller-supplied variables —
      // the canary is planted by exactly the same mechanism.
      expect(env).toContain("REPOS_TEST_CANARY=canary-visible");
      expect(env).not.toMatch(/^GH_CONFIG_DIR=/m);
      expect(env).not.toMatch(/^XDG_CONFIG_HOME=/m);
      expect(env).not.toContain(callerStore);
      // HOME must survive: gh's default config path is $HOME/.config/gh, which
      // is where the station's own credential lives. Scrubbing the
      // redirections is what makes that default binding.
      expect(env).toMatch(/^HOME=/m);
    }
  });

  test("a configured credential command supplies the child token — the same probe finds it", () => {
    const fixture = seed();
    const credPath = writeCredentialCommand(fixture, `echo "${COMMAND_TOKEN}"`);
    writeFileSync(fixture.configPath, JSON.stringify({ github: { credentialCommand: [credPath] } }));
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"]);
    expect(result.code).toBe(0);
    const envs = ghChildEnvs(fixture);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env).toMatch(new RegExp(`^GH_TOKEN=${COMMAND_TOKEN}$`, "m"));
      expect(env).not.toContain(CALLER_TOKEN);
    }
    // The token the CLI resolved for its children never reaches the caller.
    expect(result.stdout).not.toContain(COMMAND_TOKEN);
    expect(result.stderr).not.toContain(COMMAND_TOKEN);
  });

  test("fails closed when the credential command fails: typed error, gh never spawned", () => {
    const fixture = seed();
    const credPath = writeCredentialCommand(fixture, "exit 1");
    writeFileSync(fixture.configPath, JSON.stringify({ github: { credentialCommand: [credPath] } }));
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("CREDENTIAL_UNAVAILABLE");
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("fails closed when the credential command returns nothing", () => {
    const fixture = seed();
    const credPath = writeCredentialCommand(fixture, "exit 0");
    writeFileSync(fixture.configPath, JSON.stringify({ github: { credentialCommand: [credPath] } }));
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("CREDENTIAL_UNAVAILABLE");
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("an unauthenticated gh maps to CREDENTIAL_UNAVAILABLE, not a generic failure", () => {
    const fixture = seed();
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"], { GH_SHIM_AUTH_FAIL: "1" });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("CREDENTIAL_UNAVAILABLE");
  });

  test("redacts the resolved token from hostile gh stderr — the shim log proves it was there", () => {
    const fixture = seed();
    const credPath = writeCredentialCommand(fixture, `echo "${COMMAND_TOKEN}"`);
    writeFileSync(fixture.configPath, JSON.stringify({ github: { credentialCommand: [credPath] } }));
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"], { GH_SHIM_CREATE_FAIL: "1" });
    expect(result.code).not.toBe(0);
    // Positive control: the token really was in the child's hands.
    const envs = ghChildEnvs(fixture);
    expect(envs.some((env) => env.includes(COMMAND_TOKEN))).toBe(true);
    // The hostile stderr echoed it; the CLI's own output must not.
    expect(result.stdout).not.toContain(COMMAND_TOKEN);
    expect(result.stderr).not.toContain(COMMAND_TOKEN);
  });

  test("refuses an existing repository without creating", () => {
    const fixture = seed();
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--json"], { GH_SHIM_EXISTING: "1" });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("REPO_EXISTS");
    const calls = ghInvocations(fixture);
    expect(calls.some((line) => line.startsWith("repo create"))).toBe(false);
  });

  test.each([
    "no-slash",
    "../escape/name",
    "org/-evil",
    "org/..",
    "org/name/extra",
    "org/name with space",
  ])("refuses the malformed spec %s before any gh call", (spec) => {
    const fixture = seed();
    const result = runCli(fixture, ["create", spec, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("INVALID_REPO_SPEC");
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("a leading-dash spec is refused by argument shape before any gh call", () => {
    // Commander intercepts `-evil/name` as an unknown option, which is the
    // same property — the value cannot reach gh argv — via an earlier gate.
    const fixture = seed();
    const result = runCli(fixture, ["create", "-evil/name", "--json"]);
    expect(result.code).not.toBe(0);
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("--public and --description reach gh", () => {
    const fixture = seed();
    const result = runCli(fixture, [
      "create", "hasna/scratch-r5", "--public", "--description", "R5 scratch", "--json",
    ]);
    expect(result.code).toBe(0);
    const calls = ghInvocations(fixture);
    const createCall = calls.find((line) => line.startsWith("repo create"));
    expect(createCall).toContain("--public");
    expect(createCall).toContain("R5 scratch");
  });

  test("--dir clones after creating and registers the checkout", () => {
    const fixture = seed();
    const result = runCli(fixture, ["create", "hasna/scratch-r5", "--dir", fixture.workDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = parseCliJson(result.stdout);
    expect(payload.clone.path).toBe(join(fixture.workDir, "scratch-r5"));
    expect(payload.clone.registered).toBe(true);
    const db = getDb(fixture.dbPath);
    const row = db.query("SELECT name FROM repos WHERE path = ?").get(join(fixture.workDir, "scratch-r5")) as { name: string } | null;
    expect(row?.name).toBe("scratch-r5");
  });
});

describe("repos clone", () => {
  test("clones to <dir>/<name> and registers it", () => {
    const fixture = seed();
    const result = runCli(fixture, ["clone", "hasna/scratch-r5", "--dir", fixture.workDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = parseCliJson(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.clone.path).toBe(join(fixture.workDir, "scratch-r5"));
    expect(payload.clone.registered).toBe(true);
    const db = getDb(fixture.dbPath);
    const row = db.query("SELECT name FROM repos WHERE path = ?").get(join(fixture.workDir, "scratch-r5")) as { name: string } | null;
    expect(row?.name).toBe("scratch-r5");
  });

  test("refuses an occupied destination before any gh call", () => {
    const fixture = seed();
    mkdirSync(join(fixture.workDir, "scratch-r5"), { recursive: true });
    writeFileSync(join(fixture.workDir, "scratch-r5", "keep"), "occupied");
    const result = runCli(fixture, ["clone", "hasna/scratch-r5", "--dir", fixture.workDir, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("TARGET_PATH_OCCUPIED");
    expect(ghInvocations(fixture)).toEqual([]);
    // The occupant is untouched — the factory destroy-then-create hazard is
    // not reproduced on the repository plane either.
    expect(readFileSync(join(fixture.workDir, "scratch-r5", "keep"), "utf8")).toBe("occupied");
  });

  test("scrubs the caller's token from the clone child too", () => {
    const fixture = seed();
    const result = runCli(fixture, ["clone", "hasna/scratch-r5", "--dir", fixture.workDir, "--json"]);
    expect(result.code).toBe(0);
    const envs = ghChildEnvs(fixture);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env).toContain("REPOS_TEST_CANARY=canary-visible");
      expect(env).not.toContain(CALLER_TOKEN);
    }
  });
});

describe("repos archive", () => {
  test("archives by org/name spec", () => {
    const fixture = seed();
    const result = runCli(fixture, ["archive", "hasna/scratch-r5", "--json"]);
    expect(result.code).toBe(0);
    const payload = parseCliJson(result.stdout);
    expect(payload.archived).toBe(true);
    const calls = ghInvocations(fixture);
    expect(calls).toContain("repo archive hasna/scratch-r5 --yes");
  });

  test("--restore unarchives", () => {
    const fixture = seed();
    const result = runCli(fixture, ["archive", "hasna/scratch-r5", "--restore", "--json"]);
    expect(result.code).toBe(0);
    const payload = parseCliJson(result.stdout);
    expect(payload.archived).toBe(false);
    expect(ghInvocations(fixture)).toContain("repo unarchive hasna/scratch-r5 --yes");
  });

  test("resolves a registry name to its GitHub identity", () => {
    const fixture = seed();
    const db = getDb(fixture.dbPath);
    db.prepare(
      "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, 'open-scratch', 'hasna', 'github.com/hasna/scratch-r5', 'main', ?)",
    ).run(join(fixture.workDir, "open-scratch"), "2026-07-01 00:00:00");
    closeDb();
    const result = runCli(fixture, ["archive", "open-scratch", "--json"]);
    expect(result.code).toBe(0);
    expect(ghInvocations(fixture)).toContain("repo archive hasna/scratch-r5 --yes");
  });

  test("refuses a registry row with no GitHub remote", () => {
    const fixture = seed();
    const db = getDb(fixture.dbPath);
    db.prepare(
      "INSERT INTO repos (path, name, default_branch, updated_at) VALUES (?, 'local-only', 'main', ?)",
    ).run(join(fixture.workDir, "local-only"), "2026-07-01 00:00:00");
    closeDb();
    const result = runCli(fixture, ["archive", "local-only", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("REPO_HAS_NO_REMOTE");
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("refuses an unknown registry name", () => {
    const fixture = seed();
    const result = runCli(fixture, ["archive", "never-heard-of-it", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("REPO_NOT_FOUND");
    expect(ghInvocations(fixture)).toEqual([]);
  });

  test("there is no delete verb — archive is the terminal CLI state", () => {
    const fixture = seed();
    const result = runCli(fixture, ["delete", "hasna/scratch-r5"]);
    expect(result.code).not.toBe(0);
    expect(ghInvocations(fixture)).toEqual([]);
  });
});
