import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";
let homeDir = "";
let dbPath = "";
let targetPath = "";
let head = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCli(extraArgs: string[]) {
  return Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      "src/cli/index.tsx",
      "registry",
      "relocate-primary",
      "--repo-id",
      "661",
      "--expected-current-path",
      "/dev/shm/accounts",
      "--target-path",
      targetPath,
      "--expected-remote",
      "github.com/hasna/accounts",
      "--expected-head",
      head,
      "--actor",
      "test:cli",
      "--json",
      ...extraArgs,
    ],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      HOME: homeDir,
      HASNA_REPOS_DB_PATH: dbPath,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  closeDb();
  tempDir = mkdtempSync(join(tmpdir(), "repos-relocate-cli-"));
  homeDir = join(tempDir, "home");
  const worktreeRoot = join(homeDir, ".hasna", "repos", "worktrees");
  targetPath = join(worktreeRoot, "accounts", "task-661");
  dbPath = join(tempDir, "repos.db");
  mkdirSync(targetPath, { recursive: true });
  git(targetPath, "init", "-b", "main");
  git(targetPath, "config", "user.email", "repos-test@invalid.example");
  git(targetPath, "config", "user.name", "Repos Test");
  git(targetPath, "remote", "add", "origin", "https://github.com/hasna/accounts.git");
  writeFileSync(join(targetPath, "README.md"), "# accounts\n");
  git(targetPath, "add", "README.md");
  git(targetPath, "commit", "-m", "initial");
  head = git(targetPath, "rev-parse", "HEAD");

  const db = getDb(dbPath);
  db.query("INSERT INTO repos (id, path, name, org, remote_url) VALUES (661, '/dev/shm/accounts', 'accounts', 'hasna', 'git@github.com:hasna/accounts.git')").run();
  closeDb();
});
afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
  homeDir = "";
  dbPath = "";
  targetPath = "";
  head = "";
});

describe("registry relocate-primary CLI", () => {
  it("is a dry run by default and performs no registry write", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.schema).toBe("open-repos.primary-relocation.v1");
    expect(output.applied).toBe(false);
    expect(output.receipt).toBeNull();

    const db = getDb(dbPath);
    expect(db.query("SELECT path FROM repos WHERE id = 661").get()).toEqual({ path: "/dev/shm/accounts" });
    expect(db.query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
  });

  it("requires explicit --apply and persists one auditable receipt", () => {
    const result = runCli(["--apply"]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.applied).toBe(true);
    expect(output.repo_id).toBe(661);
    expect(output.receipt.actor).toBe("test:cli");

    const db = getDb(dbPath);
    expect(db.query("SELECT id, path FROM repos WHERE id = 661").get()).toEqual({ id: 661, path: targetPath });
    expect(db.query("SELECT count(*) AS count FROM repo_relocation_audit WHERE repo_id = 661").get()).toEqual({ count: 1 });
  });

  it("fails closed with versioned JSON and a non-zero exit on mismatched HEAD", () => {
    head = "0".repeat(40);
    const result = runCli(["--dry-run"]);
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout.toString());
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("HEAD_MISMATCH");

    const db = getDb(dbPath);
    expect(db.query("SELECT path FROM repos WHERE id = 661").get()).toEqual({ path: "/dev/shm/accounts" });
  });

  it("rejects contradictory --apply and --dry-run flags", () => {
    const result = runCli(["--apply", "--dry-run"]);
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout.toString());
    expect(output.error.code).toBe("INVALID_REQUEST");
  });
});
