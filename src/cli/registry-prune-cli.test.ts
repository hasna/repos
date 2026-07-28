import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";
afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

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

function seed() {
  tempDir = mkdtempSync(join(tmpdir(), "repos-prune-cli-"));
  const dbPath = join(tempDir, "repos.db");
  const live = join(tempDir, "live", "open-live");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "KEEP.txt"), "keep\n");
  const gone = join(tempDir, "gone", "open-gone");
  const db = getDb(dbPath);
  db.query("INSERT INTO repos (path, name, remote_url, default_branch) VALUES (?, 'open-live', 'github.com/hasna/live', 'main')").run(live);
  db.query("INSERT INTO repos (path, name, remote_url, default_branch) VALUES (?, 'open-gone', 'github.com/hasna/gone', 'main')").run(gone);
  closeDb();
  return { dbPath, live, gone };
}

describe("repos registry prune", () => {
  test("the verb exists and is a dry run that deletes nothing", () => {
    // There was no prune, forget, remove or delete verb at all, so 291 stale rows
    // had no supported way to be retired.
    const { dbPath, live } = seed();
    const result = runCli(dbPath, ["registry", "prune", "--json"]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as { applied: boolean; plan: { row_count: number; plan_hash: string; database: string } };
    expect(plan.applied).toBe(false);
    expect(plan.plan.row_count).toBe(1);
    expect(plan.plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    const after = runCli(dbPath, ["repos", "--json", "-n", "10"]);
    expect((JSON.parse(after.stdout) as unknown[]).length).toBe(2);
    expect(existsSync(live)).toBe(true);
  });

  test("--apply alone is refused with a non-zero exit and deletes nothing", () => {
    const { dbPath } = seed();
    const result = runCli(dbPath, ["registry", "prune", "--apply", "--json"]);
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFIRMATION_REQUIRED");
    const after = runCli(dbPath, ["repos", "--json", "-n", "10"]);
    expect((JSON.parse(after.stdout) as unknown[]).length).toBe(2);
  });

  test("refuses when --expected-database names a different database", () => {
    const { dbPath } = seed();
    const dry = JSON.parse(runCli(dbPath, ["registry", "prune", "--json"]).stdout) as { plan: { plan_hash: string } };
    const result = runCli(dbPath, [
      "registry", "prune", "--apply", "--json",
      "--expected-database", "/somewhere/else/repos.db",
      "--expected-plan-hash", dry.plan.plan_hash,
      "--actor", "cli-test", "--idempotency-key", "cli-key-1",
    ]);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.stdout) as { error: { code: string } }).error.code).toBe("DATABASE_MISMATCH");
  });

  test("prunes with every confirmation, and leaves the filesystem alone", () => {
    const { dbPath, live, gone } = seed();
    const dry = JSON.parse(runCli(dbPath, ["registry", "prune", "--json"]).stdout) as { plan: { plan_hash: string; database: string } };
    const result = runCli(dbPath, [
      "registry", "prune", "--apply", "--json",
      "--expected-database", dry.plan.database,
      "--expected-plan-hash", dry.plan.plan_hash,
      "--actor", "cli-test", "--idempotency-key", "cli-key-2",
    ]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { applied: boolean; receipt: { row_count: number } };
    expect(body.applied).toBe(true);
    expect(body.receipt.row_count).toBe(1);

    const after = JSON.parse(runCli(dbPath, ["repos", "--json", "-n", "10"]).stdout) as Array<{ name: string }>;
    expect(after.map((row) => row.name)).toEqual(["open-live"]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(live, "KEEP.txt"))).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  test("the dry run prints the exact confirmed command to run", () => {
    // A refusal that does not say how to proceed just moves the dead end.
    const { dbPath } = seed();
    const human = runCli(dbPath, ["registry", "prune"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("--expected-database");
    expect(human.stdout).toContain("--expected-plan-hash");
    expect(human.stdout).toContain("--idempotency-key");
    expect(human.stdout).toContain("Nothing on disk is touched");
  });
});
