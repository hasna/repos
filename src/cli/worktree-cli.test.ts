/**
 * The two shape properties the worktree verbs rest on, asserted against the
 * real CLI rather than against the library.
 *
 * A reviewer can read `worktrees.ts` and see that the path is computed. What
 * they cannot see from there is whether some later commit adds `--path` to the
 * command for convenience. These tests fail if it does.
 *
 * Every case here is refused before the canonical worktree root is ever
 * consulted, so nothing is created under the live root that other agents are
 * working in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function seedDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), "repos-worktree-cli-"));
  const dbPath = join(tempDir, "repos.db");
  getDb(dbPath);
  closeDb();
  return dbPath;
}

function runCli(dbPath: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, HASNA_REPOS_AUTO_BOOTSTRAP: "0", HASNA_REPOS_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function errorOf(stdout: string): { code: string; message: string } {
  return (JSON.parse(stdout) as { error: { code: string; message: string } }).error;
}

describe("repos worktree — argument surface", () => {
  test("the verb exists at all", () => {
    // The owner's premise, checked rather than assumed: `repos --help` on the
    // published 0.1.36 lists no worktree verb. This asserts it now does.
    const dbPath = seedDb();
    const help = runCli(dbPath, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("worktree");
  });

  test("`worktree add` exposes no way to name a destination", () => {
    const dbPath = seedDb();
    const help = runCli(dbPath, ["worktree", "add", "--help"]);
    expect(help.code).toBe(0);
    for (const forbidden of ["--path", "--dir", "--target", "--destination", "--worktree-root", "--root"]) {
      expect(help.stdout).not.toContain(forbidden);
    }
    // The options that do exist are the ones that feed the computation.
    expect(help.stdout).toContain("--task");
    expect(help.stdout).toContain("--name");
  });

  test("`worktree remove` takes a reference, and rejects every path shape", () => {
    const dbPath = seedDb();
    const help = runCli(dbPath, ["worktree", "remove", "--help"]);
    expect(help.stdout).toContain("<ref>");
    expect(help.stdout).not.toContain("--path");

    for (const path of [
      "/home/hasna/.hasna/repos/worktrees/open-repos/a321ba13",
      "/etc",
      "../../etc",
      "~/.hasna",
      "./local",
      "repo/name/extra",
    ]) {
      const result = runCli(dbPath, ["worktree", "remove", path, "--json"]);
      expect(result.code).toBe(1);
      expect(errorOf(result.stdout).code).toBe("INVALID_REQUEST");
    }
  });

  test("a crafted worktree name is refused by the CLI, not just by the library", () => {
    const dbPath = seedDb();
    const result = runCli(dbPath, ["worktree", "add", "open-anything", "--name", "../../escape", "--json"]);
    expect(result.code).toBe(1);
    expect(errorOf(result.stdout).code).toBe("INVALID_WORKTREE_NAME");
  });

  test("an unregistered repo is reported, never guessed at", () => {
    const dbPath = seedDb();
    const result = runCli(dbPath, ["worktree", "add", "open-not-registered", "--task", "abc123", "--json"]);
    expect(result.code).toBe(1);
    expect(errorOf(result.stdout).code).toBe("REPO_NOT_FOUND");
  });

  test("`worktree remove` is callable by a scheduled loop: a dry run and a JSON payload", () => {
    // Requirement 3 of the owner directive — "built so a scheduled loop can call
    // it later without reshaping it" — asserted at the surface a loop actually
    // invokes, because a library-only capability is not one a cron line can use.
    const dbPath = seedDb();
    const help = runCli(dbPath, ["worktree", "remove", "--help"]);
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("--json");
    // The unlanded hazard gets its own opt-in, and the help says so rather than
    // leaving an operator to discover it from a refusal.
    expect(help.stdout).toContain("--allow-unlanded");
  });

  test("`worktree adopt` is the only verb that accepts a path, and defaults to a dry run", () => {
    const dbPath = seedDb();
    const help = runCli(dbPath, ["worktree", "adopt", "--help"]);
    expect(help.stdout).toContain("[path]");
    expect(help.stdout).toContain("--apply");
    expect(help.stdout).toContain("dry run");
  });
});
