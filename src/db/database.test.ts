import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, closeDb } from "./database";
import { listRepos } from "./repos";

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

  it("rejects SQLite memory URI aliases before opening or creating an artifact", () => {
    closeDb();
    const uri = `file::memory:?cache=shared&repos_test=${process.pid}`;
    expect(() => getDb(uri)).toThrow("SQLite memory URI paths are unsupported; use exact :memory:");
    expect(existsSync(uri)).toBe(false);
    process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
    getDb(":memory:");
  });

  it("keeps parameterless SDK reads inside the active explicit database context", () => {
    closeDb();
    const previousPrimary = process.env["HASNA_REPOS_DB_PATH"];
    const previousFallback = process.env["REPOS_DB_PATH"];
    const previousRequirement = process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"];
    delete process.env["HASNA_REPOS_DB_PATH"];
    delete process.env["REPOS_DB_PATH"];
    process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"] = "1";

    try {
      const isolated = getDb(":memory:");
      isolated.query("INSERT INTO repos (path, name) VALUES ('/tmp/sdk-review', 'sdk-review')").run();

      expect(listRepos({ query: "sdk-review" })).toHaveLength(1);
      expect(getDb()).toBe(isolated);
      expect(() => getDb(join(tmpdir(), "different-repos.db"))).toThrow(
        "cannot switch Repos database paths while a database is open",
      );
    } finally {
      closeDb();
      if (previousPrimary === undefined) delete process.env["HASNA_REPOS_DB_PATH"];
      else process.env["HASNA_REPOS_DB_PATH"] = previousPrimary;
      if (previousFallback === undefined) delete process.env["REPOS_DB_PATH"];
      else process.env["REPOS_DB_PATH"] = previousFallback;
      if (previousRequirement === undefined) delete process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"];
      else process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"] = previousRequirement;
      getDb(":memory:");
    }
  });

  it("requires migrate:false opens to use an explicit non-default path and never discovers cwd or HOME", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-unmigrated-open-"));
    const previousHome = process.env["HOME"];
    const previousPrimary = process.env["HASNA_REPOS_DB_PATH"];
    const previousFallback = process.env["REPOS_DB_PATH"];
    const previousRequirement = process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"];
    const defaultPath = join(dir, ".hasna", "repos", "repos.db");
    mkdirSync(join(dir, ".repos"), { recursive: true });

    try {
      process.env["HOME"] = dir;
      delete process.env["HASNA_REPOS_DB_PATH"];
      delete process.env["REPOS_DB_PATH"];
      delete process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"];

      expect(() => getDb(undefined, { migrate: false })).toThrow("explicit non-default Repos database path");
      expect(existsSync(defaultPath)).toBe(false);

      process.env["HASNA_REPOS_DB_PATH"] = defaultPath;
      expect(() => getDb(undefined, { migrate: false })).toThrow("explicit non-default Repos database path");
      expect(() => getDb(defaultPath, { migrate: false })).toThrow("explicit non-default Repos database path");
      expect(existsSync(defaultPath)).toBe(false);
    } finally {
      closeDb();
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousPrimary === undefined) delete process.env["HASNA_REPOS_DB_PATH"];
      else process.env["HASNA_REPOS_DB_PATH"] = previousPrimary;
      if (previousFallback === undefined) delete process.env["REPOS_DB_PATH"];
      else process.env["REPOS_DB_PATH"] = previousFallback;
      if (previousRequirement === undefined) delete process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"];
      else process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"] = previousRequirement;
      rmSync(dir, { recursive: true, force: true });
      getDb(":memory:");
    }
  });

  it("migrates an explicitly opened unmigrated singleton exactly once on the first normal access", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-deferred-migrate-"));
    const path = join(dir, "isolated.db");
    try {
      const raw = getDb(path, { migrate: false });
      expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'migrations'").get()).toBeNull();

      const migrated = getDb(path);
      expect(migrated).toBe(raw);
      expect(migrated.query("SELECT version FROM migrations ORDER BY version").all())
        .toEqual([1, 2, 3, 4, 6, 7, 8, 9].map((version) => ({ version })));
      expect(getDb(path)).toBe(migrated);
      expect(migrated.query("SELECT count(*) AS count FROM migrations WHERE version = 9").get())
        .toEqual({ count: 1 });
      expect(() => getDb(join(dir, "other.db"))).toThrow("cannot switch Repos database paths");
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
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
    expect(migrations.map((row) => row.version)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
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
        .map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
      // This fixture intentionally models only the v7 receipt shape. Mark the
      // later remote-bearing migrations as handled so this test remains scoped
      // to byte-preserving v7 recovery; v9 exact-schema behavior is covered
      // independently below.
      recovery.exec("INSERT INTO migrations (version) VALUES (8), (9)");
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

  it("atomically sanitizes repository and remote identities, rebuilds FTS, and reopens idempotently", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v8-remote-sanitize-"));
    const path = join(dir, "repos.db");
    const credential = ["member", "phrase"].join(":");
    const queryMarker = ["access", "marker"].join("");
    const unsafe = `https://${credential}@Code.Example.test:8443/team/tool.git?key=${queryMarker}#fragment`;
    try {
      const initial = getDb(path);
      initial.query("DELETE FROM migrations WHERE version = 8").run();
      const repo = initial.query("INSERT INTO repos (path, name, remote_url) VALUES (?, ?, ?) RETURNING id")
        .get(join(dir, "repo"), "repo", unsafe) as { id: number };
      initial.query("INSERT INTO remotes (repo_id, name, url, fetch_url) VALUES (?, 'origin', ?, ?)")
        .run(repo.id, unsafe, "file:///local/fetch");
      initial.query("INSERT INTO remotes (repo_id, name, url) VALUES (?, 'local', 'file:///local/repo')").run(repo.id);
      closeDb();

      const migrated = getDb(path);
      expect(migrated.query("SELECT remote_url FROM repos WHERE id = ?").get(repo.id)).toEqual({
        remote_url: "code.example.test/team/tool",
      });
      expect(migrated.query("SELECT name, url, fetch_url FROM remotes WHERE repo_id = ? ORDER BY name").all(repo.id)).toEqual([{
        name: "origin",
        url: "code.example.test/team/tool",
        fetch_url: null,
      }]);
      expect(migrated.query("SELECT rowid FROM fts_repos WHERE fts_repos MATCH ?").all(queryMarker)).toEqual([]);
      expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.query("SELECT count(*) AS count FROM migrations WHERE version = 8").get()).toEqual({ count: 1 });
      closeDb();

      const reopened = getDb(path);
      expect(reopened.query("SELECT remote_url FROM repos WHERE id = ?").get(repo.id)).toEqual({
        remote_url: "code.example.test/team/tool",
      });
      expect(reopened.query("SELECT count(*) AS count FROM migrations WHERE version = 8").get()).toEqual({ count: 1 });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back every v8 rewrite and its marker when a synthetic migration step fails", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v8-remote-rollback-"));
    const path = join(dir, "repos.db");
    const unsafe = `ssh://${["actor", "phrase"].join(":")}@git.example.test/team/tool.git`;
    let repoId = 0;
    try {
      const initial = getDb(path);
      initial.query("DELETE FROM migrations WHERE version = 8").run();
      repoId = Number((initial.query("INSERT INTO repos (path, name, remote_url) VALUES (?, ?, ?) RETURNING id")
        .get(join(dir, "repo"), "repo", unsafe) as { id: number }).id);
      initial.exec(`
        CREATE TRIGGER synthetic_v8_failure BEFORE UPDATE OF remote_url ON repos
        WHEN NEW.id = ${repoId}
        BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;
      `);
      closeDb();

      expect(() => getDb(path)).toThrow("synthetic migration failure");
      closeDb();
      const afterFailure = new Database(path);
      expect(afterFailure.query("SELECT remote_url FROM repos WHERE id = ?").get(repoId)).toEqual({ remote_url: unsafe });
      expect(afterFailure.query("SELECT version FROM migrations WHERE version = 8").get()).toBeNull();
      afterFailure.exec("DROP TRIGGER synthetic_v8_failure");
      afterFailure.close();

      const recovered = getDb(path);
      expect(recovered.query("SELECT remote_url FROM repos WHERE id = ?").get(repoId)).toEqual({
        remote_url: "git.example.test/team/tool",
      });
      expect(recovered.query("SELECT count(*) AS count FROM migrations WHERE version = 8").get()).toEqual({ count: 1 });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("applies v9 after an exact v8 marker and sanitizes later remote-bearing state", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-after-v8-"));
    const path = join(dir, "repos.db");
    const unsafe = `https://${["actor", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8);
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        remote_url TEXT
      );
      CREATE TABLE remotes (
        id INTEGER PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        fetch_url TEXT
      );
      CREATE TABLE repo_relocation_audit (
        id TEXT PRIMARY KEY,
        expected_remote TEXT NOT NULL,
        source_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        after_json TEXT NOT NULL
      );
    `);
    seed.query("INSERT INTO repos (id, path, name, remote_url) VALUES (1, '/tmp/v9', 'v9', ?)").run(unsafe);
    seed.query("INSERT INTO remotes (id, repo_id, name, url, fetch_url) VALUES (1, 1, 'origin', ?, ?)")
      .run(unsafe, unsafe);
    seed.query("INSERT INTO remotes (id, repo_id, name, url) VALUES (2, 1, 'local', 'file:///tmp/v9')").run();
    const snapshot = JSON.stringify({ id: 1, path: "/tmp/v9", name: "v9", remote_url: unsafe });
    seed.query(`INSERT INTO repo_relocation_audit
      (id, expected_remote, source_json, target_json, after_json) VALUES ('receipt-v9', ?, ?, ?, ?)`)
      .run(unsafe, snapshot, snapshot, snapshot);
    seed.close();

    try {
      const migrated = getDb(path);
      expect(migrated.query("SELECT remote_url FROM repos WHERE id = 1").get()).toEqual({
        remote_url: "git.example.test/team/tool",
      });
      expect(migrated.query("SELECT name, url, fetch_url FROM remotes ORDER BY id").all()).toEqual([{
        name: "origin",
        url: "git.example.test/team/tool",
        fetch_url: "git.example.test/team/tool",
      }]);
      const receipt = migrated.query(`SELECT expected_remote, source_json, target_json, after_json
        FROM repo_relocation_audit WHERE id = 'receipt-v9'`).get() as Record<string, string>;
      expect(receipt.expected_remote).toBe("git.example.test/team/tool");
      for (const field of ["source_json", "target_json", "after_json"]) {
        expect(JSON.parse(receipt[field]!)).toMatchObject({ remote_url: "git.example.test/team/tool" });
      }
      expect(JSON.stringify(receipt)).not.toContain("phrase");
      expect(migrated.query("SELECT count(*) AS count FROM migrations WHERE version = 9").get()).toEqual({ count: 1 });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back v9 without a marker when any required remote-bearing column is missing", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-schema-guard-"));
    const unsafe = `https://${["actor", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const cases = [
      { name: "repos.remote_url", repos: "id INTEGER PRIMARY KEY, path TEXT, name TEXT", remotes: "id INTEGER PRIMARY KEY, url TEXT, fetch_url TEXT", audit: "id TEXT PRIMARY KEY, expected_remote TEXT, source_json TEXT, target_json TEXT, after_json TEXT" },
      { name: "remotes.fetch_url", repos: "id INTEGER PRIMARY KEY, path TEXT, name TEXT, remote_url TEXT", remotes: "id INTEGER PRIMARY KEY, url TEXT", audit: "id TEXT PRIMARY KEY, expected_remote TEXT, source_json TEXT, target_json TEXT, after_json TEXT" },
      { name: "repo_relocation_audit.target_json", repos: "id INTEGER PRIMARY KEY, path TEXT, name TEXT, remote_url TEXT", remotes: "id INTEGER PRIMARY KEY, url TEXT, fetch_url TEXT", audit: "id TEXT PRIMARY KEY, expected_remote TEXT, source_json TEXT, after_json TEXT" },
    ];

    try {
      for (const item of cases) {
        const path = join(dir, `${item.name.replace(/[^a-z]+/gi, "-")}.db`);
        const seed = new Database(path);
        seed.exec(`
          CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE);
          INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8);
          CREATE TABLE repos (${item.repos});
          CREATE TABLE remotes (${item.remotes});
          CREATE TABLE repo_relocation_audit (${item.audit});
        `);
        if (item.repos.includes("remote_url")) {
          seed.query("INSERT INTO repos (id, path, name, remote_url) VALUES (1, '/tmp/guard', 'guard', ?)").run(unsafe);
        }
        seed.close();

        expect(() => getDb(path)).toThrow("v9 requires the exact remote-bearing schema");
        closeDb();
        const raw = new Database(path);
        expect(raw.query("SELECT version FROM migrations WHERE version = 9").get()).toBeNull();
        if (item.repos.includes("remote_url")) {
          expect(raw.query("SELECT remote_url FROM repos WHERE id = 1").get()).toEqual({ remote_url: unsafe });
        }
        raw.close();
      }
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back v9 when a trigger recontaminates a sanitized value before the marker", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-trigger-guard-"));
    const path = join(dir, "repos.db");
    const unsafe = `https://${["actor", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE);
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8);
      CREATE TABLE repos (id INTEGER PRIMARY KEY, path TEXT, name TEXT, remote_url TEXT);
      CREATE TABLE remotes (id INTEGER PRIMARY KEY, url TEXT, fetch_url TEXT);
      CREATE TABLE repo_relocation_audit (
        id TEXT PRIMARY KEY, expected_remote TEXT, source_json TEXT, target_json TEXT, after_json TEXT
      );
      INSERT INTO repos (id, path, name, remote_url)
        VALUES (1, '/tmp/trigger-guard', 'trigger-guard', '${unsafe}');
      CREATE TRIGGER repos_remote_recontaminate AFTER UPDATE OF remote_url ON repos
      BEGIN
        UPDATE repos SET remote_url = '${unsafe}' WHERE id = NEW.id;
      END;
    `);
    seed.close();

    try {
      expect(() => getDb(path)).toThrow("remote identity successor migration failed canonical verification");
      closeDb();
      const raw = new Database(path);
      expect(raw.query("SELECT remote_url FROM repos WHERE id = 1").get()).toEqual({ remote_url: unsafe });
      expect(raw.query("SELECT version FROM migrations WHERE version = 9").get()).toBeNull();
      raw.close();
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
        stdout: JSON.stringify([1, 2, 3, 4, 6, 7, 8, 9].map((version) => ({ version }))),
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
