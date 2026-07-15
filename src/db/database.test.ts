import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, closeDb } from "./database";

describe("database", () => {
  beforeAll(() => {
    process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  });

  afterAll(() => {
    closeDb();
    delete process.env["HASNA_REPOS_DB_PATH"];
  });

  it("should initialize with WAL mode (or memory for in-memory)", () => {
    const db = getDb(":memory:");
    const result = db.query("PRAGMA journal_mode").get() as any;
    // In-memory DBs use "memory" journal mode; file-backed DBs use "wal"
    expect(["wal", "memory"]).toContain(result.journal_mode);
  });

  it("should create repos table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get();
    expect(tables).toBeTruthy();
  });

  it("should create commits table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'").get();
    expect(tables).toBeTruthy();
  });

  it("should create branches table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='branches'").get();
    expect(tables).toBeTruthy();
  });

  it("should create tags table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'").get();
    expect(tables).toBeTruthy();
  });

  it("should create remotes table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='remotes'").get();
    expect(tables).toBeTruthy();
  });

  it("should create pull_requests table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pull_requests'").get();
    expect(tables).toBeTruthy();
  });

  it("should create agents table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
    expect(tables).toBeTruthy();
  });

  it("should create automation_state table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_state'").get();
    expect(tables).toBeTruthy();
  });

  it("should create the durable repo relocation audit table", () => {
    const db = getDb(":memory:");
    const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_relocation_audit'").get();
    expect(table).toBeTruthy();
  });

  it("should create FTS5 tables", () => {
    const db = getDb(":memory:");
    const ftsRepos = db.query("SELECT name FROM sqlite_master WHERE name='fts_repos'").get();
    const ftsCommits = db.query("SELECT name FROM sqlite_master WHERE name='fts_commits'").get();
    const ftsPrs = db.query("SELECT name FROM sqlite_master WHERE name='fts_prs'").get();
    expect(ftsRepos).toBeTruthy();
    expect(ftsCommits).toBeTruthy();
    expect(ftsPrs).toBeTruthy();
  });

  it("should track migrations", () => {
    const db = getDb(":memory:");
    const migrations = db.query("SELECT version FROM migrations ORDER BY version").all() as { version: number }[];
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    expect(migrations.map((row) => row.version)).toEqual([1, 2, 3, 4, 6, 7]);
  });

  it("upgrades the live migration-5 worktree schema without skipping relocation audit", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-live-v5-upgrade-"));
    const path = join(dir, "repos.db");
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (5);
      CREATE TABLE worktree_leases (
        lease_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        machine_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        owner_metadata TEXT NOT NULL DEFAULT '{}',
        cleanup_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        git_common_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        verified_at TEXT,
        released_at TEXT,
        last_error TEXT,
        UNIQUE(repo_id, machine_id, task_id, run_id, base_ref)
      );
    `);
    seed.close();
    try {
      const db = getDb(path);
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_leases'").get()).toBeTruthy();
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_relocation_audit'").get()).toBeTruthy();
      expect((db.query("SELECT version FROM migrations ORDER BY version").all() as { version: number }[])
        .map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("upgrades v6 receipts byte-for-byte and removes their current-state repo foreign key", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v6-receipt-upgrade-"));
    const path = join(dir, "repos.db");
    const seed = new Database(path);
    seed.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6);
      CREATE TABLE repos (id INTEGER PRIMARY KEY);
      INSERT INTO repos (id) VALUES (2), (3);
      CREATE TABLE repo_relocation_audit (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
        target_repo_id INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'primary_relocation'),
        actor TEXT NOT NULL,
        expected_current_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        expected_remote TEXT NOT NULL,
        expected_head TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        target_revision TEXT NOT NULL,
        source_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        collisions_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_repo_relocation_audit_repo
        ON repo_relocation_audit(repo_id, created_at);
      INSERT INTO repo_relocation_audit VALUES (
        'receipt-1', 'key-1', 'request-hash', 'plan-hash', 2, 3,
        'primary_relocation', 'test:actor', '/legacy', '/canonical',
        'github.com/hasna/accounts', '${"a".repeat(40)}', 'source-revision',
        'target-revision', '{"id":2}', '{"id":3}', '{"id":2}', '{}', '[]',
        '2026-07-15T00:00:00.000Z'
      );
      CREATE TABLE repo_relocation_audit_v7 (sentinel TEXT);
    `);
    const before = seed.query("SELECT * FROM repo_relocation_audit").get();
    seed.close();
    try {
      expect(() => getDb(path)).toThrow();
      closeDb();
      const recovery = new Database(path);
      expect(recovery.query("SELECT * FROM repo_relocation_audit").get()).toEqual(before);
      expect(recovery.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_repo_relocation_audit_repo'",
      ).get()).toEqual({ name: "idx_repo_relocation_audit_repo" });
      expect(recovery.query("SELECT version FROM migrations WHERE version = 7").get()).toBeNull();
      recovery.exec("DROP TABLE repo_relocation_audit_v7");
      recovery.close();

      const db = getDb(path);
      expect(db.query("SELECT * FROM repo_relocation_audit").get()).toEqual(before);
      expect(db.query("PRAGMA foreign_key_list(repo_relocation_audit)").all()).toEqual([]);
      db.query("DELETE FROM repos WHERE id = 2").run();
      expect(db.query("SELECT * FROM repo_relocation_audit").get()).toEqual(before);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("serializes concurrent first-open migrations across processes", async () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-concurrent-first-open-"));
    const path = join(dir, "repos.db");
    const databaseModule = join(import.meta.dir, "database.ts");
    const script = `
      import { readFileSync } from "node:fs";
      readFileSync(0);
      const { getDb, closeDb } = await import(${JSON.stringify(databaseModule)});
      try {
        const db = getDb();
        const versions = db.query("SELECT version FROM migrations ORDER BY version").all();
        process.stdout.write(JSON.stringify(versions));
        closeDb();
      } catch (error) {
        process.stderr.write(error instanceof Error
          ? (error.stack || error.message) + "\\ncode=" + String(error.code)
          : String(error));
        process.exitCode = 1;
      }
    `;
    try {
      const children = Array.from({ length: 8 }, () => {
        const child = spawn(process.execPath, ["-e", script], {
          env: { ...process.env, HASNA_REPOS_DB_PATH: path },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        return { child, completed };
      });

      // All workers block on stdin until every process has been spawned.
      for (const { child } of children) child.stdin.end("start\n");
      const results = await Promise.all(children.map(({ completed }) => completed));
      expect(results).toEqual(Array.from({ length: 8 }, () => ({
        code: 0,
        stdout: JSON.stringify([1, 2, 3, 4, 6, 7].map((version) => ({ version }))),
        stderr: "",
      })));
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("should have foreign keys enabled", () => {
    const db = getDb(":memory:");
    const result = db.query("PRAGMA foreign_keys").get() as any;
    expect(result.foreign_keys).toBe(1);
  });
});
