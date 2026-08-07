import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

const repoRoot = join(import.meta.dir, "../..");

function runCli(dbPath: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: { ...process.env, HASNA_REPOS_AUTO_BOOTSTRAP: "0", HASNA_REPOS_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, args: string[]): number {
  return Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tempDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).exitCode ?? -1;
}

/** A working checkout under the fixture. */
function makeCheckoutAt(relativePath: string): string {
  const path = join(tempDir, relativePath);
  mkdirSync(path, { recursive: true });
  expect(git(path, ["init", "-q", "-b", "main", "."])).toBe(0);
  expect(git(path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"])).toBe(0);
  return path;
}

function makeCheckout(name: string): string {
  return makeCheckoutAt(name);
}

/** A `.git` stripped down to what the real gutted checkouts retain. */
function makeHollowCheckout(name: string): string {
  const path = makeCheckout(name);
  rmSync(join(path, ".git"), { recursive: true, force: true });
  mkdirSync(join(path, ".git", "hooks"), { recursive: true });
  mkdirSync(join(path, ".git", "worktrees"), { recursive: true });
  return path;
}

function seed(rows: Array<{ name: string; path: string; remote?: string }>): string {
  const dbPath = join(tempDir, "repos.db");
  const db = getDb(dbPath);
  for (const row of rows) {
    db.query("INSERT INTO repos (path, name, remote_url, default_branch) VALUES (?, ?, ?, 'main')")
      .run(row.path, row.name, row.remote ?? null);
  }
  closeDb();
  return dbPath;
}

describe("repo lookup refuses an unusable checkout", () => {
  test("exits non-zero for a hollow .git while still emitting the record", () => {
    // The reported defect: `repos repo <name> --json` returned a path that no
    // `git worktree add`, no `cd` and no `git -C` can use, at exit code 0. The
    // record is still emitted, because a caller diagnosing the row needs the
    // remote and the verdict — but the command must fail.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-hollow-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path, remote: "github.com/hasna/gutted" }]);

    const result = runCli(dbPath, ["repo", "open-gutted", "--json"]);
    expect(result.code).toBe(1);
    const record = JSON.parse(result.stdout) as { path: string; checkout_health: { state: string; usable: boolean } };
    expect(record.path).toBe(path);
    expect(record.checkout_health.state).toBe("hollow-git-dir");
    expect(record.checkout_health.usable).toBe(false);
    expect(result.stderr).toContain("not a usable git checkout");
    expect(result.stderr).toContain("git clone https://github.com/hasna/gutted");
  });

  test("refuses a complete-but-unreadable checkout as 'unreadable' and never prints a re-clone command", () => {
    // stderr is the surface where this defect was dangerous. On a REAL, COMPLETE
    // checkout that merely could not be read, the refusal used to print
    // "The directory survives but its repository does not. Re-clone it with:
    // git clone <remote> <path>" — a data-loss instruction assembled from an
    // EACCES, because `existsSync` reports a permission error as an absence.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-locked-"));
    const path = makeCheckout("open-locked");
    const dbPath = seed([{ name: "open-locked", path, remote: "github.com/hasna/locked" }]);

    const original = statSync(path).mode & 0o777;
    chmodSync(path, 0o000);
    let result: ReturnType<typeof runCli>;
    try {
      // A uid that ignores mode bits (root) would make this fixture vacuous.
      // Assert the denial is real; CI runs as a normal user on ubuntu-latest.
      expect(() => readdirSync(path)).toThrow();
      result = runCli(dbPath, ["repo", "open-locked", "--json"]);
    } finally {
      // Restore before asserting: a mode-000 directory also defeats the
      // afterEach teardown.
      chmodSync(path, original);
    }

    expect(result.code).toBe(1);
    const record = JSON.parse(result.stdout) as { checkout_health: { state: string; usable: boolean } };
    expect(record.checkout_health.state).toBe("unreadable");
    expect(record.checkout_health.usable).toBe(false);
    expect(result.stderr).toContain("not a usable git checkout");
    expect(result.stderr).not.toContain("git clone");
    expect(result.stderr).toContain("Do NOT re-clone");
  });

  test("exits zero for a real checkout and reports it usable", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-ok-"));
    const path = makeCheckout("open-fine");
    const dbPath = seed([{ name: "open-fine", path, remote: "github.com/hasna/fine" }]);

    const result = runCli(dbPath, ["repo", "open-fine", "--json"]);
    expect(result.code).toBe(0);
    const record = JSON.parse(result.stdout) as { checkout_health: { state: string; usable: boolean } };
    expect(record.checkout_health.state).toBe("usable");
    expect(record.checkout_health.usable).toBe(true);
    expect(result.stderr).not.toContain("not a usable git checkout");
  });

  test("--allow-unusable-checkout reports the state without failing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-allow-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path }]);

    const result = runCli(dbPath, ["repo", "open-gutted", "--json", "--allow-unusable-checkout"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { checkout_health: { state: string } }).checkout_health.state)
      .toBe("hollow-git-dir");
    // The verdict is still reported — the flag suppresses the failure, not the finding.
    expect(result.stderr).toContain("hollow-git-dir");
  });

  test("show and inspect are guarded the same way as repo", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-aliases-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path }]);
    for (const verb of ["show", "inspect"]) {
      const result = runCli(dbPath, [verb, "open-gutted", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("hollow-git-dir");
    }
  });
});

describe("repo lookup validates managed path identity", () => {
  test("refuses a managed checkout whose name and path disagree with its remote", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-identity-mismatch-"));
    const path = makeCheckoutAt(join("workspace", "hasnaxyz", "internalapp", "iapp-fixture"));
    const dbPath = seed([{
      name: "iapp-fixture",
      path,
      remote: "github.com/hasna/fixture",
    }]);

    const result = runCli(dbPath, ["repo", "iapp-fixture", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("identity mismatch");
    expect(result.stderr).toContain("github.com/hasnaxyz/iapp-fixture");
    expect(result.stderr).toContain("github.com/hasna/fixture");

    const byPath = runCli(dbPath, ["repo", path, "--json"]);
    expect(byPath.code).toBe(1);
    expect(byPath.stdout.trim()).toBe("");
    expect(byPath.stderr).toContain("identity mismatch");
  });

  test("still resolves a managed checkout whose path and remote identities agree", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-identity-match-"));
    const path = makeCheckoutAt(join("workspace", "hasnaxyz", "internalapp", "iapp-fixture"));
    const dbPath = seed([{
      name: "iapp-fixture",
      path,
      remote: "github.com/hasnaxyz/iapp-fixture",
    }]);

    const result = runCli(dbPath, ["repo", "iapp-fixture", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { path: string }).path).toBe(path);
    expect(result.stderr).not.toContain("identity mismatch");
  });
});

describe("repos cd refuses rather than printing an unusable path", () => {
  test("prints nothing on stdout and exits 1 for a gutted checkout", () => {
    // `cd $(repos cd <name>)` substitutes this straight into another command.
    // A "here it is, but it does not work" answer puts the caller inside a
    // directory that is not a checkout — which is how agents ended up
    // re-cloning by hand and committing into each other's worktrees.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-cd-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path, remote: "github.com/hasna/gutted" }]);

    const result = runCli(dbPath, ["cd", "open-gutted"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("hollow-git-dir");
    expect(result.stderr).toContain("git clone https://github.com/hasna/gutted");
  });

  test("still prints the path for a working checkout", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-cd-ok-"));
    const path = makeCheckout("open-fine");
    const dbPath = seed([{ name: "open-fine", path }]);
    const result = runCli(dbPath, ["cd", "open-fine"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(path);
  });

  test("refuses on the --exact path too, not only the fuzzy one", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-cd-exact-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path }]);
    const result = runCli(dbPath, ["cd", "open-gutted", "--exact"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
  });

  test("names the remote in the refusal even on the fuzzy path", () => {
    // `getRepoPath` returns a path only; the refusal looks the row back up so it
    // can name what to clone instead of saying "there is no remote".
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-cd-fuzzy-"));
    const path = makeHollowCheckout("open-gutted");
    const dbPath = seed([{ name: "open-gutted", path, remote: "github.com/hasna/gutted" }]);
    const result = runCli(dbPath, ["cd", "gutted"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git clone https://github.com/hasna/gutted");
  });

  test("delivers the complete refusal to a stderr pipe before exiting", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-cd-stderr-pipe-"));
    const tail = "stderr-refusal-tail";
    const path = join(tempDir, `${"x".repeat(70_000)}-${tail}`);
    const dbPath = seed([{ name: "large-refusal", path }]);

    // A direct Bun.spawnSync stderr capture does not reproduce the truncation.
    // Route fd 2 through a real shell pipe: on the unfixed console.error +
    // process.exit path, the message stops at one pipe buffer and loses `tail`.
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        "set -o pipefail; bun run src/cli/index.tsx cd large-refusal 2>&1 >/dev/null | cat",
      ],
      cwd: repoRoot,
      env: { ...process.env, HASNA_REPOS_AUTO_BOOTSTRAP: "0", HASNA_REPOS_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.byteLength).toBeGreaterThan(65_536);
    expect(result.stdout.toString()).toContain(tail);
  });
});

describe("--remote prefers a checkout that works", () => {
  test("resolves to the live worktree when the primary clone is gutted", () => {
    // Several remotes on this machine have exactly this shape: a hollow primary
    // and a live worktree. Resolving to the hollow one is what sent agents off
    // to re-clone, so a working checkout has to win over a primary that does not.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-remote-"));
    const live = makeCheckout("live-copy");
    const gutted = makeHollowCheckout("gutted-primary");
    const dbPath = seed([
      { name: "gutted-primary", path: gutted, remote: "github.com/hasna/thing" },
      { name: "live-copy", path: live, remote: "github.com/hasna/thing" },
    ]);

    const result = runCli(dbPath, ["repo", "--remote", "github.com/hasna/thing", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { path: string }).path).toBe(live);
  });

  test("still reports the row when no checkout of the remote works", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-remote-none-"));
    const a = makeHollowCheckout("gutted-a");
    const dbPath = seed([{ name: "gutted-a", path: a, remote: "github.com/hasna/thing" }]);
    const result = runCli(dbPath, ["repo", "--remote", "github.com/hasna/thing", "--json"]);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.stdout) as { checkout_health: { state: string } }).checkout_health.state)
      .toBe("hollow-git-dir");
  });

  test("never resolves to a _factory_src mirror, even when it is the only checkout git can open (todos c0ac7e9b)", () => {
    // Measured on the live registry 2026-08-07, repos 0.1.40:
    //   repos repo --remote hasnaxyz/iapp-takumi --json
    //     rc=0  path .../_factory_src/iapp-takumi  checkout_health usable  HEAD 2026-05-24
    // A separate clone, two and a half months stale, returned as success. The
    // usability filter dropped the hollow canonical, and the single-candidate
    // early return fired before the derived-path exclusion could reject it.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-remote-mirror-"));
    const gutted = makeHollowCheckout("iapp-takumi");
    const mirror = makeCheckout("_factory_src/iapp-takumi");
    const dbPath = seed([
      { name: "iapp-takumi", path: gutted, remote: "github.com/hasnaxyz/iapp-takumi" },
      { name: "iapp-takumi", path: mirror, remote: "github.com/hasnaxyz/iapp-takumi" },
    ]);

    const result = runCli(dbPath, ["repo", "--remote", "github.com/hasnaxyz/iapp-takumi", "--json"]);
    const record = JSON.parse(result.stdout) as { path: string; checkout_health: { state: string } };
    expect(record.path).not.toBe(mirror);
    expect(record.path).toBe(gutted);
    // And the hollow canonical it does return is reported as broken rather than
    // as success, which is the whole difference from the measured behaviour.
    expect(record.checkout_health.state).toBe("hollow-git-dir");
    expect(result.code).toBe(1);
  });

  test("exits non-zero and names the remote when nothing matches (todos c0ac7e9b, original title)", () => {
    // The row was filed as "--remote EXITS 0 WHILE REFUSING to resolve", so the
    // refusal's exit status is pinned here rather than left to be re-measured.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-remote-missing-"));
    const dbPath = seed([{ name: "open-thing", path: makeCheckout("open-thing"), remote: "github.com/hasna/thing" }]);

    const hit = runCli(dbPath, ["repo", "--remote", "github.com/hasna/thing", "--json"]);
    expect(hit.code).toBe(0);

    const miss = runCli(dbPath, ["repo", "--remote", "github.com/hasna/no-such-repo", "--json"]);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("No indexed repo has remote 'github.com/hasna/no-such-repo'");
    expect(miss.stdout).toBe("");
  });

  test("reports the remote as ambiguous only among checkouts that work", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-remote-ambiguous-"));
    const one = makeCheckout("live-one");
    const two = makeCheckout("live-two");
    const gutted = makeHollowCheckout("gutted-three");
    const dbPath = seed([
      { name: "live-one", path: one, remote: "github.com/hasna/thing" },
      { name: "live-two", path: two, remote: "github.com/hasna/thing" },
      { name: "gutted-three", path: gutted, remote: "github.com/hasna/thing" },
    ]);
    const result = runCli(dbPath, ["repo", "--remote", "github.com/hasna/thing", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checked out 2 times");
    expect(result.stderr).not.toContain(gutted);
  });
});

describe("registry health", () => {
  test("counts every row, not a page of them, and lists the unusable ones", () => {
    // The count that scoped this defect had to be hand-rolled against the SQLite
    // file, because `repos repos --json` truncated. A registry whose health
    // cannot be measured with a supported command does not get re-measured.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-health-"));
    const rows: Array<{ name: string; path: string; remote?: string }> = [];
    for (let i = 0; i < 3; i++) rows.push({ name: `ok-${i}`, path: makeCheckout(`ok-${i}`) });
    for (let i = 0; i < 4; i++) rows.push({ name: `hollow-${i}`, path: makeHollowCheckout(`hollow-${i}`) });
    for (let i = 0; i < 2; i++) rows.push({ name: `gone-${i}`, path: join(tempDir, `absent-${i}`) });
    const dbPath = seed(rows);

    const result = runCli(dbPath, ["registry", "health", "--json", "-n", "100"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      total_rows: number;
      usable_rows: number;
      unusable_rows: number;
      unusable_pct: number;
      states: Record<string, number>;
      rows: Array<{ name: string; health: { state: string } }>;
    };
    expect(report.total_rows).toBe(9);
    expect(report.usable_rows).toBe(3);
    expect(report.unusable_rows).toBe(6);
    expect(report.states).toMatchObject({ usable: 3, "hollow-git-dir": 4, "missing-path": 2 });
    expect(report.rows.length).toBe(9);

    const unusableOnly = runCli(dbPath, ["registry", "health", "--json", "--unusable", "-n", "100"]);
    const filtered = JSON.parse(unusableOnly.stdout) as { rows: Array<{ health: { state: string } }> };
    expect(filtered.rows.length).toBe(6);
    expect(filtered.rows.every((row) => row.health.state !== "usable")).toBe(true);

    const byState = runCli(dbPath, ["registry", "health", "--json", "--state", "missing-path", "-n", "100"]);
    expect((JSON.parse(byState.stdout) as { rows: unknown[] }).rows.length).toBe(2);
  });

  test("declares when its own row listing was capped", () => {
    // The summary counts all rows; the listing is paged. Saying so is the
    // difference between a page and a complete answer.
    tempDir = mkdtempSync(join(tmpdir(), "repos-guard-health-cap-"));
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `gone-${i}`, path: join(tempDir, `absent-${i}`) }));
    const dbPath = seed(rows);
    const result = runCli(dbPath, ["registry", "health", "--json", "-n", "2"]);
    const report = JSON.parse(result.stdout) as { total_rows: number; listed: number; listed_truncated: boolean; rows: unknown[] };
    expect(report.total_rows).toBe(5);
    expect(report.listed).toBe(5);
    expect(report.listed_truncated).toBe(true);
    expect(report.rows.length).toBe(2);
  });
});
