import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, closeDb } from "./database";
import { listRepos } from "./repos";
import { importWorktree, inspectWorktree, renewWorktreeLease } from "../lib/worktrees";

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
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21].map((version) => ({ version })));
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

  it("should create the durable branch adjudication audit table", () => {
    const db = getDb(":memory:");
    const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='branch_adjudication_audit'").get();
    expect(table).toBeTruthy();
  });

  it("should create worktree_leases table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_leases'").get();
    expect(tables).toBeTruthy();
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
    expect(migrations.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21]);
  });

  it("migrates existing branch uniqueness to include remote classification", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-branch-identity-upgrade-"));
    const path = join(dir, "repos.db");
    try {
      const initial = getDb(path);
      const repo = initial.query("INSERT INTO repos (path, name) VALUES ('/tmp/existing', 'existing') RETURNING id")
        .get() as { id: number };
      initial.query(`INSERT INTO branches (repo_id, name, is_remote, last_commit_sha)
        VALUES (?, 'origin/main', 0, 'local')`).run(repo.id);
      closeDb();

      const seed = new Database(path);
      seed.exec(`
        PRAGMA foreign_keys = ON;
        DELETE FROM migrations WHERE version IN (10, 21);
        DROP INDEX idx_branches_repo;
        ALTER TABLE branches RENAME TO branches_current;
        CREATE TABLE branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          is_remote INTEGER NOT NULL DEFAULT 0,
          last_commit_sha TEXT,
          last_commit_date TEXT,
          ahead INTEGER NOT NULL DEFAULT 0,
          behind INTEGER NOT NULL DEFAULT 0,
          UNIQUE(repo_id, name)
        );
        INSERT INTO branches SELECT * FROM branches_current;
        DROP TABLE branches_current;
        CREATE INDEX idx_branches_repo ON branches(repo_id);
      `);
      seed.close();

      const migrated = getDb(path);
      migrated.query(`INSERT INTO branches (repo_id, name, is_remote, last_commit_sha)
        VALUES (?, 'origin/main', 1, 'remote')`).run(repo.id);
      expect(migrated.query(`SELECT name, is_remote, last_commit_sha FROM branches
        WHERE repo_id = ? ORDER BY is_remote`).all(repo.id)).toEqual([
        { name: "origin/main", is_remote: 0, last_commit_sha: "local" },
        { name: "origin/main", is_remote: 1, last_commit_sha: "remote" },
      ]);
      expect(() => migrated.query(`INSERT INTO branches (repo_id, name, is_remote, last_commit_sha)
        VALUES (?, 'origin/main', 1, 'duplicate-remote')`).run(repo.id)).toThrow("UNIQUE constraint failed");
      expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.query("SELECT version FROM migrations WHERE version = 10").get()).toEqual({ version: 10 });
      expect(migrated.query("SELECT version FROM migrations WHERE version = 21").get()).toEqual({ version: 21 });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rebuilds version-21 indexes for semantically proved terminal ownership", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v10-finalizing-index-"));
    const path = join(dir, "repos.db");
    try {
      process.env["HASNA_REPOS_DB_PATH"] = path;
      getDb(path);
      closeDb();
      const seed = new Database(path);
      seed.exec(`
        DELETE FROM migrations WHERE version = 21;
        DROP INDEX idx_worktree_leases_active_path;
        DROP INDEX idx_worktree_leases_active_repo_branch;
        CREATE UNIQUE INDEX idx_worktree_leases_active_path
          ON worktree_leases(canonical_path)
          WHERE status IN ('preparing', 'active', 'releasing', 'quarantining', 'quarantine_finalizing');
        CREATE UNIQUE INDEX idx_worktree_leases_active_repo_branch
          ON worktree_leases(canonical_repo, branch)
          WHERE status IN ('preparing', 'active', 'releasing', 'quarantining', 'quarantine_finalizing');
      `);
      seed.close();

      const db = getDb(path);
      expect(db.query("SELECT 1 FROM migrations WHERE version = 21").get()).toEqual({ 1: 1 });
      const indexes = db.query(`SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_worktree_leases_active_path',
          'idx_worktree_leases_active_repo_branch'
        ) ORDER BY name`).all() as Array<{ name: string; sql: string }>;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((index) =>
        index.sql.includes("status NOT IN ('released', 'failed', 'quarantined')")
        && index.sql.includes("$.release_finalized")
        && index.sql.includes("$.release_verified_head_sha")
        && index.sql.includes("$.quarantine_finalized")
        && index.sql.includes("$.backup_ref"))).toBe(true);
      db.exec(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, expires_at_ms,
          heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (
          'wt_provisional_release', 'hasna/repos', 'task-provisional', 'run-provisional',
          'station01', '/tmp/provisional', 'task/provisional', 'owner', 'released',
          1, 'token-provisional', 1, 1, 1, 1, '{"release_finalized":false}'
        );
      `);
      expect(() => db.query(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, expires_at_ms,
          heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (
          'wt_provisional_competitor', 'hasna/repos', 'task-competitor', 'run-competitor',
          'station01', '/tmp/provisional', 'task/provisional', 'competitor', 'active',
          1, 'token-competitor', 1, 1, 1, 1, '{}'
        );
      `).run()).toThrow("UNIQUE constraint failed");
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("keeps null or missing terminal proofs ownership-reserving and rejects them on reopen", () => {
    const objectId = "a".repeat(40);
    for (const scenario of [
      {
        name: "released-null-head",
        status: "released",
        headSha: null,
        metadata: JSON.stringify({
          release_finalized: true,
          release_verified_head_sha: objectId,
          release_finalized_at_ms: 1,
        }),
      },
      {
        name: "quarantined-missing-path",
        status: "quarantined",
        headSha: objectId,
        metadata: JSON.stringify({
          quarantine_finalized: true,
          verified_head_sha: objectId,
          backup_ref: "refs/hasna/worktrees/wt_invalid_terminal/1",
          quarantine_finalized_at_ms: 1,
        }),
      },
    ] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-terminal-null-${scenario.name}-`));
      const path = join(dir, "repos.db");
      const canonicalPath = `/tmp/${scenario.name}`;
      const branch = `task/${scenario.name}`;
      try {
        const initial = getDb(path);
        initial.query(`
          INSERT INTO worktree_leases (
            lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
            branch, owner, status, generation, fencing_token, head_sha,
            expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
          ) VALUES (
            'wt_invalid_terminal', 'hasna/repos', 'task-invalid', 'run-invalid',
            'station01', ?, ?, 'owner', ?, 1, 'token-invalid', ?,
            1, 1, 1, 1, ?
          )
        `).run(canonicalPath, branch, scenario.status, scenario.headSha, scenario.metadata);
        closeDb();

        expect(() => getDb(path)).toThrow("worktree lease terminal proof payload is missing or invalid");
        closeDb();

        const check = new Database(path);
        const insertSuccessor = (
          leaseId: string,
          successorPath: string,
          successorBranch: string,
        ) => check.query(`
          INSERT INTO worktree_leases (
            lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
            branch, owner, status, generation, fencing_token,
            expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
          ) VALUES (
            ?, 'hasna/repos', 'task-successor', 'run-successor',
            'station02', ?, ?, 'successor', 'active', 1, ?,
            2, 2, 2, 2, '{}'
          )
        `).run(leaseId, successorPath, successorBranch, `${leaseId}:1`);

        expect(() => insertSuccessor(
          "wt_path_successor",
          canonicalPath,
          `${branch}-different`,
        )).toThrow("UNIQUE constraint failed: worktree_leases.canonical_path");
        expect(() => insertSuccessor(
          "wt_branch_successor",
          `${canonicalPath}-different`,
          branch,
        )).toThrow("UNIQUE constraint failed: worktree_leases.canonical_repo, worktree_leases.branch");
        expect(check.query("SELECT lease_id FROM worktree_leases WHERE owner = 'successor'").all()).toEqual([]);
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("reopens provisional terminal rows without releasing their ownership", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-provisional-terminal-reopen-"));
    const path = join(dir, "repos.db");
    try {
      const initial = getDb(path);
      initial.exec(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token,
          expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES
          (
            'wt_provisional_released', 'hasna/repos', 'task-release', 'run-release',
            'station01', '/tmp/provisional-released', 'task/provisional-released',
            'owner', 'released', 1, 'token-release',
            1, 1, 1, 1, '{"release_finalized":false}'
          ),
          (
            'wt_provisional_quarantined', 'hasna/repos', 'task-quarantine', 'run-quarantine',
            'station01', '/tmp/provisional-quarantined', 'task/provisional-quarantined',
            'owner', 'quarantined', 1, 'token-quarantine',
            1, 1, 1, 1, '{}'
          );
      `);
      closeDb();

      const reopened = getDb(path);
      expect(reopened.query(`
        SELECT lease_id, status FROM worktree_leases
        WHERE owner = 'owner' ORDER BY lease_id
      `).all()).toEqual([
        { lease_id: "wt_provisional_quarantined", status: "quarantined" },
        { lease_id: "wt_provisional_released", status: "released" },
      ]);
      expect(() => reopened.query(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token,
          expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (
          'wt_provisional_path_successor', 'hasna/repos', 'task-next', 'run-next',
          'station02', '/tmp/provisional-released', 'task/different',
          'successor', 'active', 1, 'token-next',
          2, 2, 2, 2, '{}'
        );
      `).run()).toThrow("UNIQUE constraint failed: worktree_leases.canonical_path");
      expect(() => reopened.query(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token,
          expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (
          'wt_provisional_branch_successor', 'hasna/repos', 'task-next', 'run-next',
          'station02', '/tmp/different', 'task/provisional-quarantined',
          'successor', 'active', 1, 'token-next',
          2, 2, 2, 2, '{}'
        );
      `).run()).toThrow("UNIQUE constraint failed: worktree_leases.canonical_repo, worktree_leases.branch");
      expect(reopened.query("SELECT lease_id FROM worktree_leases WHERE owner = 'successor'").all()).toEqual([]);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back version 21 when its marker trigger mutates any integrated row set", () => {
    for (const scenario of ["repo", "remote", "branch", "branch-audit", "worktree-lease"] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-v21-marker-${scenario}-`));
      const path = join(dir, "repos.db");
      try {
        const initial = getDb(path);
        const repo = initial.query("INSERT INTO repos (path, name) VALUES (?, ?) RETURNING id")
          .get(join(dir, "repo"), `repo-${scenario}`) as { id: number };
        const remote = initial.query(`INSERT INTO remotes (
          repo_id, name, url
        ) VALUES (?, 'origin', 'https://github.com/hasna/repos.git') RETURNING id`)
          .get(repo.id) as { id: number };
        const branch = initial.query(`INSERT INTO branches (
          repo_id, name, is_remote, last_commit_sha
        ) VALUES (?, 'codewith/v21-proof', 0, ?) RETURNING id`)
          .get(repo.id, "a".repeat(40)) as { id: number };
        initial.query(`INSERT INTO branch_adjudication_audit (
          id, idempotency_key, request_hash, plan_hash, operation, actor,
          row_count, before_json, after_json, rows_json
        ) VALUES (
          'audit-v21-proof', 'audit-v21-proof-key', 'request-hash', 'plan-hash',
          'branch_adjudication', 'reviewed-actor', 1, '{}', '{}', '[]'
        )`).run();
        initial.query(`INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, expires_at_ms,
          heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (
          'wt_v21_marker_proof', 'hasna/repos', 'task-v21', 'run-v21',
          'station01', ?, 'codewith/v21-proof', 'reviewed-owner', 'failed',
          1, 'wt_v21_marker_proof:1', 1, 1, 1, 1, '{}'
        )`).run(join(dir, "worktree"));
        initial.query("DELETE FROM migrations WHERE version = 21").run();
        const triggerAction = scenario === "repo"
          ? `UPDATE repos SET name = 'substituted' WHERE id = ${repo.id};`
          : scenario === "remote"
            ? `UPDATE remotes SET name = 'mirror' WHERE id = ${remote.id};`
            : scenario === "branch"
              ? `DELETE FROM branches WHERE id = ${branch.id};`
              : scenario === "branch-audit"
                ? "UPDATE branch_adjudication_audit SET actor = 'substituted' WHERE id = 'audit-v21-proof';"
                : "DELETE FROM worktree_leases WHERE lease_id = 'wt_v21_marker_proof';";
        initial.exec(`
          CREATE TRIGGER mutate_v21_target AFTER INSERT ON migrations
          WHEN NEW.version = 21
          BEGIN
            ${triggerAction}
          END;
        `);
        closeDb();

        expect(() => getDb(path)).toThrow("integrated schema reconciliation failed exact-state verification");
        closeDb();
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
        expect(check.query("SELECT name FROM repos WHERE id = ?").get(repo.id))
          .toEqual({ name: `repo-${scenario}` });
        expect(check.query("SELECT name FROM remotes WHERE id = ?").get(remote.id))
          .toEqual({ name: "origin" });
        expect(check.query("SELECT id FROM branches WHERE id = ?").get(branch.id)).toEqual({ id: branch.id });
        expect(check.query("SELECT actor FROM branch_adjudication_audit WHERE id = 'audit-v21-proof'").get())
          .toEqual({ actor: "reviewed-actor" });
        expect(check.query("SELECT lease_id FROM worktree_leases WHERE lease_id = 'wt_v21_marker_proof'").get())
          .toEqual({ lease_id: "wt_v21_marker_proof" });
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("rolls back any migration whose marker trigger rewrites the exact migrations ledger", () => {
    for (const scenario of [
      "delete-earlier",
      "rewrite-earlier",
      "delete-current",
      "rewrite-current",
    ] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-generic-marker-${scenario}-`));
      const path = join(dir, "repos.db");
      try {
        const initial = getDb(path);
        initial.query("DELETE FROM migrations WHERE version = 4").run();
        const before = initial.query("SELECT * FROM migrations ORDER BY id").all();
        const triggerAction = scenario === "delete-earlier"
          ? "DELETE FROM migrations WHERE version = 2;"
          : scenario === "rewrite-earlier"
            ? "UPDATE migrations SET applied_at = '2000-01-01 00:00:00' WHERE version = 2;"
            : scenario === "delete-current"
              ? "DELETE FROM migrations WHERE version = NEW.version;"
              : "UPDATE migrations SET applied_at = '2000-01-01 00:00:00' WHERE version = NEW.version;";
        initial.exec(`
          CREATE TRIGGER mutate_generic_migration_marker AFTER INSERT ON migrations
          WHEN NEW.version = 4
          BEGIN
            ${triggerAction}
          END;
        `);
        closeDb();

        expect(() => getDb(path)).toThrow("migration marker integrity verification failed");
        closeDb();
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT * FROM migrations ORDER BY id").all()).toEqual(before);
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("rolls back a marker trigger that corrupts the external-content repository index", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-marker-fts-integrity-"));
    const path = join(dir, "repos.db");
    try {
      const initial = getDb(path);
      const repo = initial.query("INSERT INTO repos (path, name) VALUES (?, ?) RETURNING id")
        .get(join(dir, "indexed-repo"), "marker-index-proof") as { id: number };
      initial.query("DELETE FROM migrations WHERE version = 4").run();
      initial.exec(`
        CREATE TRIGGER corrupt_fts_after_marker AFTER INSERT ON migrations
        WHEN NEW.version = 4
        BEGIN
          INSERT INTO fts_repos(fts_repos) VALUES ('delete-all');
        END;
      `);
      closeDb();

      expect(() => getDb(path)).toThrow("migration fts_repos integrity verification failed");
      closeDb();
      const check = new Database(path);
      expect(check.query("SELECT 1 FROM migrations WHERE version = 4").get()).toBeNull();
      expect(check.query("SELECT rowid FROM fts_repos WHERE fts_repos MATCH 'marker'").all())
        .toEqual([{ rowid: repo.id }]);
      check.exec("INSERT INTO fts_repos(fts_repos, rank) VALUES ('integrity-check', 1)");
      check.close();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
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
      INSERT INTO migrations (version) VALUES
        (5), (9), (10), (11), (12), (13), (14), (15), (16), (17), (18), (19), (20);
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
      INSERT INTO worktree_leases (
        lease_id, repo_id, repo_path, repo_catalog_id, machine_id,
        worktree_path, branch, base_ref, base_sha, task_id, run_id, mode,
        owner_metadata, cleanup_policy, status, git_common_dir, created_at,
        updated_at, claimed_at, verified_at, released_at, last_error
      ) VALUES (
        'wt_aaaaaaaaaaaaaaaa', 'github:Hasna/Repos', '/legacy/repos', NULL, 'station01',
        '/legacy/worktree', 'task/legacy', 'main', '${"a".repeat(40)}',
        'task-legacy', 'run-legacy', 'required',
        '{"agent":"legacy-agent","legacy_status":"owner-value","legacy_layout":"owner-layout","legacy_owner_metadata_raw":"owner-raw"}',
        'retain', 'claimed', '/legacy/common', '1970-07-15T12:34:56.001Z',
        '2026-07-15T00:00:00.250Z', '2026-07-15T00:00:00.375Z',
        '0000-02-29T00:00:00.000Z', NULL, 'legacy failure'
      );
      INSERT INTO worktree_leases SELECT
        'wt_bbbbbbbbbbbbbbbb', repo_id, repo_path, repo_catalog_id, machine_id,
        '/legacy/worktree-b', branch, base_ref, base_sha, 'task-legacy-b', 'run-legacy-b',
        mode, '[]', cleanup_policy, 'released', git_common_dir, created_at, updated_at,
        claimed_at, verified_at, '2026-07-15T00:00:00.625Z', last_error
      FROM worktree_leases WHERE lease_id = 'wt_aaaaaaaaaaaaaaaa';
      INSERT INTO worktree_leases SELECT
        'wt_cccccccccccccccc', repo_id, repo_path, repo_catalog_id, machine_id,
        '/legacy/worktree-c', branch, base_ref, base_sha, 'task-legacy-c', 'run-legacy-c',
        mode, '"scalar"', cleanup_policy, 'released', git_common_dir, created_at, updated_at,
        claimed_at, verified_at, released_at, last_error
      FROM worktree_leases WHERE lease_id = 'wt_aaaaaaaaaaaaaaaa';
      INSERT INTO worktree_leases SELECT
        'wt_dddddddddddddddd', repo_id, repo_path, repo_catalog_id, machine_id,
        '/legacy/worktree-d', branch, base_ref, base_sha, 'task-legacy-d', 'run-legacy-d',
        mode, 'null', cleanup_policy, 'released', git_common_dir, created_at, updated_at,
        claimed_at, verified_at, released_at, last_error
      FROM worktree_leases WHERE lease_id = 'wt_aaaaaaaaaaaaaaaa';
    `);
    seed.close();
    try {
      process.env["HASNA_REPOS_DB_PATH"] = path;
      const db = getDb(path);
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_leases'").get()).toBeTruthy();
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_relocation_audit'").get()).toBeTruthy();
      expect((db.query("SELECT version FROM migrations ORDER BY version").all() as { version: number }[])
        .map((row) => row.version)).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
      const columns = (db.query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain("canonical_repo");
      expect(columns).toContain("canonical_path");
      expect(columns).toContain("repo_catalog_id");
      expect(columns).toContain("repo_path");
      expect(columns).toContain("worktree_path");
      expect(db.query("SELECT canonical_repo, canonical_path, owner, status, repo_path, worktree_path FROM worktree_leases WHERE lease_id = ?")
        .get("wt_aaaaaaaaaaaaaaaa")).toEqual({
          canonical_repo: "hasna/repos",
          canonical_path: "/legacy/worktree",
          owner: "legacy-import",
          status: "worktree_failed",
          repo_path: "/legacy/repos",
          worktree_path: "/legacy/worktree",
        });
      expect(db.query("SELECT created_at_ms, updated_at_ms, released_at_ms FROM worktree_leases WHERE lease_id = ?")
        .get("wt_aaaaaaaaaaaaaaaa")).toEqual({
          created_at_ms: Date.parse("1970-07-15T12:34:56.001Z"),
          updated_at_ms: Date.parse("2026-07-15T00:00:00.250Z"),
          released_at_ms: null,
        });
      expect(db.query("SELECT released_at_ms FROM worktree_leases WHERE lease_id = ?").get("wt_bbbbbbbbbbbbbbbb"))
        .toEqual({ released_at_ms: Date.parse("2026-07-15T00:00:00.625Z") });
      expect(inspectWorktree({ leaseId: "wt_aaaaaaaaaaaaaaaa" }).lease?.metadata).toEqual({
        legacy_layout: true,
        legacy_import: expect.objectContaining({
          status: "claimed",
          repo_id: "github:Hasna/Repos",
          mode: "required",
          cleanup_policy: "retain",
          git_common_dir: "/legacy/common",
          created_at: "1970-07-15T12:34:56.001Z",
          created_at_ms: Date.parse("1970-07-15T12:34:56.001Z"),
          updated_at: "2026-07-15T00:00:00.250Z",
          claimed_at: "2026-07-15T00:00:00.375Z",
          claimed_at_ms: Date.parse("2026-07-15T00:00:00.375Z"),
          verified_at: "0000-02-29T00:00:00.000Z",
          verified_at_ms: Date.parse("0000-02-29T00:00:00.000Z"),
          released_at: null,
          last_error: "legacy failure",
          owner_metadata_raw: '{"agent":"legacy-agent","legacy_status":"owner-value","legacy_layout":"owner-layout","legacy_owner_metadata_raw":"owner-raw"}',
          owner_metadata: {
            agent: "legacy-agent",
            legacy_status: "owner-value",
            legacy_layout: "owner-layout",
            legacy_owner_metadata_raw: "owner-raw",
          },
        }),
      });
      for (const leaseId of ["wt_bbbbbbbbbbbbbbbb", "wt_cccccccccccccccc", "wt_dddddddddddddddd"]) {
        expect(inspectWorktree({ leaseId }).lease?.metadata).toEqual({
          legacy_layout: true,
          release_finalized: true,
          release_verified_head_sha: "a".repeat(40),
          release_finalized_at_ms: Date.parse("2026-07-15T00:00:00.250Z"),
          legacy_import: expect.objectContaining({
            mode: "required",
            repo_id: "github:Hasna/Repos",
            cleanup_policy: "retain",
            git_common_dir: "/legacy/common",
            created_at: "1970-07-15T12:34:56.001Z",
            created_at_ms: Date.parse("1970-07-15T12:34:56.001Z"),
            updated_at: "2026-07-15T00:00:00.250Z",
            claimed_at: "2026-07-15T00:00:00.375Z",
            claimed_at_ms: Date.parse("2026-07-15T00:00:00.375Z"),
            verified_at: "0000-02-29T00:00:00.000Z",
            verified_at_ms: Date.parse("0000-02-29T00:00:00.000Z"),
            last_error: "legacy failure",
          }),
        });
      }
      expect((inspectWorktree({ leaseId: "wt_bbbbbbbbbbbbbbbb" }).lease?.metadata["legacy_import"] as Record<string, unknown>)["released_at"])
        .toBe("2026-07-15T00:00:00.625Z");
      const legacyRenewal = renewWorktreeLease({
        leaseId: "wt_aaaaaaaaaaaaaaaa",
        generation: 1,
        fencingToken: "wt_aaaaaaaaaaaaaaaa:legacy-v5",
        ttlSeconds: 60,
      });
      expect(legacyRenewal.ok).toBe(false);
      expect(legacyRenewal.code).toBe("lease_not_active");
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const worktreeRoot = join(dir, "worktrees");
      const source = join(worktreeRoot, "imported-source");
      mkdirSync(source, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
      git("init", "-b", "main");
      git("config", "user.email", "repos-test@invalid.example");
      git("config", "user.name", "Repos Test");
      git("remote", "add", "origin", "https://github.com/hasna/migrated-claim.git");
      writeFileSync(join(source, "README.md"), "# migrated claim\n");
      git("add", "README.md");
      git("commit", "-m", "initial");
      git("checkout", "-b", "codewith/migrated-claim");
      const originalPath = process.env["PATH"] || "";
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const shimDir = join(dir, "bin");
      const shim = join(shimDir, "git");
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(shim, `#!/bin/sh
if [ "$1" = "ls-remote" ] && [ "$2" = "--symref" ] && [ "$3" = "origin" ] && [ "$4" = "HEAD" ]; then
  head="$(${JSON.stringify(realGit)} rev-parse refs/heads/main)"
  printf 'ref: refs/heads/main\\tHEAD\\n%s\\tHEAD\\n' "$head"
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`);
      chmodSync(shim, 0o755);
      process.env["PATH"] = `${shimDir}:${originalPath}`;
      let claim;
      try {
        claim = importWorktree({
          repo: "hasna/migrated-claim",
          taskId: "task-migrated-claim",
          runId: "run-migrated-claim",
          machineId: "station01",
          branch: "codewith/migrated-claim",
          owner: "migration-test",
          path: source,
          root: worktreeRoot,
        });
      } finally {
        process.env["PATH"] = originalPath;
      }
      expect(claim.ok).toBe(true);
      expect(inspectWorktree({ leaseId: claim.lease!.lease_id }).lease?.status).toBe("active");
      expect(renewWorktreeLease({
        leaseId: claim.lease!.lease_id,
        generation: claim.lease!.generation,
        fencingToken: claim.lease!.fencing_token,
        ttlSeconds: 60,
      }).ok).toBe(true);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("refuses legacy schema drift without dropping unknown payload columns", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-legacy-unknown-column-"));
    const path = join(dir, "repos.db");
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9);
      CREATE TABLE worktree_leases (
        lease_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        repo_catalog_id INTEGER,
        machine_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        owner_metadata TEXT NOT NULL,
        cleanup_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        git_common_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        verified_at TEXT,
        released_at TEXT,
        last_error TEXT,
        future_payload TEXT
      );
      INSERT INTO worktree_leases VALUES (
        'wt_future_payload', 'github:hasna/repos', '/legacy/repos', NULL, 'station01',
        '/legacy/worktree', 'task/future', 'main', '${"a".repeat(40)}',
        'task-future', 'run-future', 'required', '{}', 'retain', 'claimed',
        '/legacy/common', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z',
        '2026-07-16T00:00:00Z', NULL, NULL, NULL, 'must-preserve'
      );
    `);
    seed.close();
    try {
      process.env["HASNA_REPOS_DB_PATH"] = path;
      expect(() => getDb(path)).toThrow("unexpected columns future_payload");
      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT future_payload FROM worktree_leases").get())
        .toEqual({ future_payload: "must-preserve" });
      expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
      check.close();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back migration 21 when legacy timestamps are malformed", () => {
    for (const scenario of [
      { slug: "numeric", createdAt: "0", releasedAt: null },
      { slug: "impossible-date", createdAt: "2026-07-15T00:00:00Z", releasedAt: "2026-02-30T00:00:00Z" },
      { slug: "unsupported-offset", createdAt: "2026-07-15T00:00:00Z", releasedAt: "2026-07-15T00:00:00+15:00" },
      { slug: "unsupported-max-offset-minutes", createdAt: "2026-07-15T00:00:00Z", releasedAt: "2026-07-15T00:00:00+14:01" },
    ]) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-live-v5-invalid-time-${scenario.slug}-`));
      const path = join(dir, "repos.db");
      const seed = new Database(path);
      seed.exec(`
        CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO migrations (version) VALUES (5), (8);
        CREATE TABLE worktree_leases (
          lease_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL,
          repo_catalog_id INTEGER, machine_id TEXT NOT NULL, worktree_path TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL, base_ref TEXT NOT NULL, base_sha TEXT NOT NULL,
          task_id TEXT NOT NULL, run_id TEXT NOT NULL, mode TEXT NOT NULL,
          owner_metadata TEXT NOT NULL DEFAULT '{}', cleanup_policy TEXT NOT NULL,
          status TEXT NOT NULL, git_common_dir TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, claimed_at TEXT NOT NULL, verified_at TEXT,
          released_at TEXT, last_error TEXT,
          UNIQUE(repo_id, machine_id, task_id, run_id, base_ref)
        );
        INSERT INTO worktree_leases (
          lease_id, repo_id, repo_path, machine_id, worktree_path, branch, base_ref,
          base_sha, task_id, run_id, mode, cleanup_policy, status, created_at,
          updated_at, claimed_at, released_at
        ) VALUES (
          'wt_invalid_time', 'github:hasna/repos', '/legacy/repos', 'station01',
          '/legacy/invalid-time', 'task/invalid-time', 'main', '${"a".repeat(40)}',
          'task-invalid-time', 'run-invalid-time', 'required', 'retain', 'claimed',
          '${scenario.createdAt}', '2026-07-15T00:00:00Z',
          '2026-07-15T00:00:00Z', ${scenario.releasedAt ? `'${scenario.releasedAt}'` : "NULL"}
        );
      `);
      seed.close();
      try {
        process.env["HASNA_REPOS_DB_PATH"] = path;
        expect(() => getDb()).toThrow("invalid legacy worktree lease timestamp");
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
        const columns = (check.query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>).map((row) => row.name);
        expect(columns).toContain("repo_id");
        expect(columns).not.toContain("canonical_repo");
        expect(check.query("SELECT created_at, released_at FROM worktree_leases").get()).toEqual({
          created_at: scenario.createdAt,
          released_at: scenario.releasedAt,
        });
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("reserves one colliding legacy claim and safely demotes the rest", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-live-v5-duplicate-"));
    const path = join(dir, "repos.db");
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO migrations (version) VALUES (5), (8);
      CREATE TABLE worktree_leases (
        lease_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL,
        repo_catalog_id INTEGER, machine_id TEXT NOT NULL, worktree_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL, base_ref TEXT NOT NULL, base_sha TEXT NOT NULL,
        task_id TEXT NOT NULL, run_id TEXT NOT NULL, mode TEXT NOT NULL,
        owner_metadata TEXT NOT NULL DEFAULT '{}', cleanup_policy TEXT NOT NULL,
        status TEXT NOT NULL, git_common_dir TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, claimed_at TEXT NOT NULL, verified_at TEXT,
        released_at TEXT, last_error TEXT,
        UNIQUE(repo_id, machine_id, task_id, run_id, base_ref)
      );
      INSERT INTO worktree_leases (
        lease_id, repo_id, repo_path, machine_id, worktree_path, branch, base_ref,
        base_sha, task_id, run_id, mode, cleanup_policy, status, created_at,
        updated_at, claimed_at
      ) VALUES
        ('wt_aaaaaaaaaaaaaaaa', 'github:hasna/repos', '/legacy/repos', 'station01', '/legacy/a', 'task/shared', 'main', '${"a".repeat(40)}', 'task-a', 'run-a', 'required', 'retain', 'claimed', '2026-07-14', '2026-07-16', '2026-07-16'),
        ('wt_bbbbbbbbbbbbbbbb', 'github:hasna/repos', '/legacy/repos', 'station02', '/legacy/b', 'task/shared', 'main', '${"b".repeat(40)}', 'task-b', 'run-b', 'required', 'retain', 'claimed', '2026-07-15', '2026-07-15', '2026-07-15'),
        ('wt_cccccccccccccccc', 'github:hasna/repos', '/legacy/repos', 'station03', '/legacy/c', 'task/quarantine-shared', 'main', '${"c".repeat(40)}', 'task-c', 'run-c', 'required', 'retain', 'quarantined', '2026-07-16', '2026-07-17', '2026-07-18'),
        ('wt_dddddddddddddddd', 'github:hasna/repos', '/legacy/repos', 'station04', '/legacy/d', 'task/quarantine-shared', 'main', '${"d".repeat(40)}', 'task-d', 'run-d', 'required', 'retain', 'quarantined', '2026-07-15', '2026-07-17', '2026-07-18');
    `);
    seed.close();
    try {
      process.env["HASNA_REPOS_DB_PATH"] = path;
      const db = getDb();
      expect(db.query("SELECT 1 FROM migrations WHERE version = 21").get()).toEqual({ 1: 1 });
      const columns = (db.query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).not.toContain("repo_id");
      expect(columns).toContain("canonical_repo");
      expect(db.query("SELECT lease_id, status FROM worktree_leases ORDER BY lease_id").all()).toEqual([
        { lease_id: "wt_aaaaaaaaaaaaaaaa", status: "failed" },
        { lease_id: "wt_bbbbbbbbbbbbbbbb", status: "worktree_failed" },
        { lease_id: "wt_cccccccccccccccc", status: "failed" },
        { lease_id: "wt_dddddddddddddddd", status: "quarantine_failed" },
      ]);
      expect(db.query("SELECT COUNT(*) AS count FROM worktree_leases WHERE status NOT IN ('released', 'failed', 'quarantined')").get())
        .toEqual({ count: 2 });
      for (const [leaseId, keeperLeaseId] of [
        ["wt_aaaaaaaaaaaaaaaa", "wt_bbbbbbbbbbbbbbbb"],
        ["wt_cccccccccccccccc", "wt_dddddddddddddddd"],
      ]) {
        const metadata = JSON.parse((db.query("SELECT metadata_json FROM worktree_leases WHERE lease_id = ?")
          .get(leaseId) as { metadata_json: string }).metadata_json) as Record<string, unknown>;
        expect(metadata["legacy_collision_demoted"]).toBe(true);
        expect(metadata["legacy_collision"]).toEqual({
          keeper_lease_id: keeperLeaseId,
          collision_key: {
            kind: "canonical_repo_branch",
            canonical_repo: "hasna/repos",
            branch: leaseId === "wt_aaaaaaaaaaaaaaaa" ? "task/shared" : "task/quarantine-shared",
          },
          lineage_order: ["claimed_at_ms", "created_at_ms", "lease_id"],
          keeper_lineage: expect.objectContaining({ lease_id: keeperLeaseId }),
          demoted_lineage: expect.objectContaining({ lease_id: leaseId }),
        });
      }
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("never records a transitively demoted legacy collision row as a keeper", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-transitive-legacy-collision-"));
    const path = join(dir, "repos.db");
    try {
      getDb(path);
      closeDb();
      const seed = new Database(path);
      seed.exec(`
        DELETE FROM migrations WHERE version = 21;
        DROP INDEX idx_worktree_leases_active_path;
        DROP INDEX idx_worktree_leases_active_repo_branch;
      `);
      const insert = seed.query(`INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, expires_at_ms,
          heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES (?, 'hasna/repos', ?, ?, 'station01', ?, ?, 'legacy-import',
          'worktree_failed', 1, ?, 10, 10, ?, ?, ?)`);
      const rows = [
        {
          leaseId: "wt_transitive_a",
          path: join(dir, "shared-path"),
          branch: "task/transitive-a",
          lineage: 1,
        },
        {
          leaseId: "wt_transitive_b",
          path: join(dir, "shared-path"),
          branch: "task/transitive-shared",
          lineage: 2,
        },
        {
          leaseId: "wt_transitive_c",
          path: join(dir, "path-c"),
          branch: "task/transitive-shared",
          lineage: 3,
        },
        {
          leaseId: "wt_transitive_d",
          path: join(dir, "path-d"),
          branch: "task/transitive-shared",
          lineage: 4,
        },
      ];
      for (const row of rows) {
        insert.run(
          row.leaseId,
          `task-${row.leaseId}`,
          `run-${row.leaseId}`,
          row.path,
          row.branch,
          `${row.leaseId}:1`,
          row.lineage,
          row.lineage,
          JSON.stringify({
            legacy_layout: true,
            legacy_import: { claimed_at_ms: row.lineage },
          }),
        );
      }
      seed.close();

      const migrated = getDb(path);
      expect(migrated.query("SELECT lease_id, status FROM worktree_leases ORDER BY lease_id").all())
        .toEqual([
          { lease_id: "wt_transitive_a", status: "worktree_failed" },
          { lease_id: "wt_transitive_b", status: "failed" },
          { lease_id: "wt_transitive_c", status: "worktree_failed" },
          { lease_id: "wt_transitive_d", status: "failed" },
        ]);
      const metadata = Object.fromEntries(
        (migrated.query("SELECT lease_id, metadata_json FROM worktree_leases ORDER BY lease_id").all() as Array<{
          lease_id: string;
          metadata_json: string;
        }>).map((row) => [row.lease_id, JSON.parse(row.metadata_json) as Record<string, unknown>]),
      );
      expect(metadata["wt_transitive_b"]?.["legacy_collision"]).toEqual(expect.objectContaining({
        keeper_lease_id: "wt_transitive_a",
        collision_key: {
          kind: "canonical_path",
          canonical_path: join(dir, "shared-path"),
        },
      }));
      expect(metadata["wt_transitive_c"]?.["legacy_collision_demoted"]).toBeUndefined();
      expect(metadata["wt_transitive_d"]?.["legacy_collision"]).toEqual(expect.objectContaining({
        keeper_lease_id: "wt_transitive_c",
        collision_key: {
          kind: "canonical_repo_branch",
          canonical_repo: "hasna/repos",
          branch: "task/transitive-shared",
        },
      }));
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("refuses canonical marker drift with a missing or violated repo catalog foreign key", () => {
    for (const scenario of [
      "missing",
      "violated",
      "not-null-set-null",
      "conflicting",
      "unrelated",
      "update-cascade",
    ] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-canonical-fk-${scenario}-`));
      const path = join(dir, "repos.db");
      const seed = new Database(path);
      const foreignKey = scenario === "missing"
        ? ""
        : scenario === "not-null-set-null"
          ? "NOT NULL REFERENCES repos(id) ON DELETE SET NULL"
          : scenario === "update-cascade"
            ? "REFERENCES repos(id) ON UPDATE CASCADE ON DELETE SET NULL"
          : "REFERENCES repos(id) ON DELETE SET NULL";
      const extraForeignKey = scenario === "conflicting"
        ? ", FOREIGN KEY (repo_catalog_id) REFERENCES other(id) ON DELETE CASCADE"
        : scenario === "unrelated"
          ? ", FOREIGN KEY (task_id) REFERENCES other(id) ON DELETE CASCADE"
          : "";
      seed.exec(`
        CREATE TABLE migrations (
          id INTEGER PRIMARY KEY,
          version INTEGER NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (9), (10);
        CREATE TABLE repos (id INTEGER PRIMARY KEY);
        CREATE TABLE other (id INTEGER PRIMARY KEY);
        INSERT INTO repos (id) VALUES (1);
        INSERT INTO other (id) VALUES (1);
        CREATE TABLE worktree_leases (
          lease_id TEXT PRIMARY KEY NOT NULL,
          canonical_repo TEXT NOT NULL,
          task_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          owner TEXT NOT NULL,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1,
          fencing_token TEXT NOT NULL,
          idempotency_key TEXT,
          source TEXT,
          base_ref TEXT,
          head_sha TEXT,
          expires_at_ms INTEGER NOT NULL,
          heartbeat_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          released_at_ms INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          repo_catalog_id INTEGER ${foreignKey},
          repo_path TEXT,
          worktree_path TEXT
          ${extraForeignKey}
        );
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, expires_at_ms,
          heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json,
          repo_catalog_id, repo_path, worktree_path
        ) VALUES (
          'wt_canonical_fk', 'hasna/repos', 'task-fk', 'run-fk', 'station01',
          '/tmp/fk-worktree', 'task/fk', 'legacy-import', 'failed', 1,
          'wt_canonical_fk:legacy', 1, 1, 1, 1, '{}',
          ${scenario === "violated"
            ? "999"
            : scenario === "not-null-set-null" || scenario === "conflicting"
              ? "1"
              : "NULL"},
          '/tmp/repos', '/tmp/fk-worktree'
        );
      `);
      seed.close();
      try {
        process.env["HASNA_REPOS_DB_PATH"] = path;
        expect(() => getDb()).toThrow(/canonical table SQL|foreign-key verification/);
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
        expect(check.query("SELECT repo_catalog_id FROM worktree_leases").get()).toEqual({
          repo_catalog_id: scenario === "violated"
            ? 999
            : scenario === "not-null-set-null" || scenario === "conflicting"
              ? 1
              : null,
        });
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("refuses nullable or composite canonical lease ID primary keys", () => {
    for (const scenario of ["nullable", "composite", "wrong-type"] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-canonical-lease-id-${scenario}-`));
      const path = join(dir, "repos.db");
      const seed = new Database(path);
      const leaseIdColumn = scenario === "nullable"
        ? "lease_id TEXT PRIMARY KEY"
        : scenario === "wrong-type"
          ? "lease_id INTEGER PRIMARY KEY NOT NULL"
          : "lease_id TEXT NOT NULL";
      const tablePrimaryKey = scenario === "composite"
        ? ", PRIMARY KEY (lease_id, task_id)"
        : "";
      const leaseIdValue = scenario === "nullable"
        ? "NULL"
        : scenario === "wrong-type"
          ? "1"
          : "'wt_duplicate'";
      const secondLeaseIdValue = scenario === "wrong-type" ? "2" : leaseIdValue;
      seed.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (9), (10);
      CREATE TABLE repos (id INTEGER PRIMARY KEY);
      CREATE TABLE worktree_leases (
        ${leaseIdColumn},
        canonical_repo TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        fencing_token TEXT NOT NULL,
        idempotency_key TEXT,
        source TEXT,
        base_ref TEXT,
        head_sha TEXT,
        expires_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        released_at_ms INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        repo_path TEXT,
        worktree_path TEXT
        ${tablePrimaryKey}
      );
      INSERT INTO worktree_leases (
        lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
        branch, owner, status, generation, fencing_token, expires_at_ms,
        heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
      ) VALUES
        (${leaseIdValue}, 'hasna/repos', 'task-a', 'run-a', 'station01', '/tmp/a',
         'task/a', 'legacy-import', 'failed', 1, 'token-a', 1, 1, 1, 1, '{}'),
        (${secondLeaseIdValue}, 'hasna/repos', 'task-b', 'run-b', 'station01', '/tmp/b',
         'task/b', 'legacy-import', 'failed', 1, 'token-b', 1, 1, 1, 1, '{}');
      `);
      seed.close();
      try {
        process.env["HASNA_REPOS_DB_PATH"] = path;
        expect(() => getDb()).toThrow("canonical table SQL");
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
        const duplicateCount = scenario === "nullable"
          ? check.query("SELECT count(*) AS count FROM worktree_leases WHERE lease_id IS NULL").get()
          : scenario === "composite"
            ? check.query("SELECT count(*) AS count FROM worktree_leases WHERE lease_id = 'wt_duplicate'").get()
            : check.query("SELECT count(*) AS count FROM worktree_leases").get();
        expect(duplicateCount).toEqual({ count: 2 });
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("refuses canonical marker drift with missing operational columns", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-canonical-missing-column-"));
    const path = join(dir, "repos.db");
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (5), (6), (7), (9), (10);
      CREATE TABLE repos (id INTEGER PRIMARY KEY);
      CREATE TABLE worktree_leases (
        lease_id TEXT PRIMARY KEY NOT NULL,
        canonical_repo TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        fencing_token TEXT NOT NULL,
        idempotency_key TEXT,
        source TEXT,
        base_ref TEXT,
        head_sha TEXT,
        expires_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        repo_path TEXT,
        worktree_path TEXT
      );
    `);
    seed.close();
    try {
      process.env["HASNA_REPOS_DB_PATH"] = path;
      expect(() => getDb()).toThrow("canonical table SQL");
      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toBeNull();
      const columns = (check.query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).not.toContain("released_at_ms");
      check.close();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("validates canonical lease invariants after all migration markers exist", () => {
    for (const scenario of [
      "missing-column",
      "extra-column",
      "wrong-default",
      "wrong-table-sql",
      "missing-indexes",
      "wrong-index-literal-case",
      "extra-index",
      "invalid-terminal-proof",
      "numeric-terminal-proof",
      "empty-terminal-proof",
      "intermediate-terminal-proof",
      "uppercase-terminal-proof",
      "duplicate-active",
      "unknown-status-duplicate",
    ] as const) {
      closeDb();
      const dir = mkdtempSync(join(tmpdir(), `repos-completed-marker-drift-${scenario}-`));
      const path = join(dir, "repos.db");
      try {
        process.env["HASNA_REPOS_DB_PATH"] = path;
        getDb(path);
        closeDb();
        const seed = new Database(path);
        if (scenario === "missing-column") {
          seed.query("ALTER TABLE worktree_leases DROP COLUMN released_at_ms").run();
        } else if (scenario === "extra-column") {
          seed.query("ALTER TABLE worktree_leases ADD COLUMN unexpected TEXT").run();
        } else if (scenario === "wrong-default" || scenario === "wrong-table-sql") {
          seed.exec(`
            DROP TABLE worktree_leases;
            CREATE TABLE worktree_leases (
              lease_id TEXT PRIMARY KEY NOT NULL,
              canonical_repo TEXT NOT NULL,
              task_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              machine_id TEXT NOT NULL,
              canonical_path TEXT NOT NULL,
              branch TEXT NOT NULL${scenario === "wrong-table-sql" ? " COLLATE NOCASE" : ""},
              owner TEXT NOT NULL,
              status TEXT NOT NULL,
              generation INTEGER NOT NULL DEFAULT ${scenario === "wrong-default" ? "99" : "1"},
              fencing_token TEXT NOT NULL,
              idempotency_key TEXT,
              source TEXT,
              base_ref TEXT,
              head_sha TEXT,
              expires_at_ms INTEGER NOT NULL,
              heartbeat_at_ms INTEGER NOT NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              released_at_ms INTEGER,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
              repo_path TEXT,
              worktree_path TEXT
            );
          `);
        } else if (scenario === "wrong-index-literal-case") {
          seed.exec(`
            DROP INDEX idx_worktree_leases_active_path;
            DROP INDEX idx_worktree_leases_active_repo_branch;
            CREATE UNIQUE INDEX idx_worktree_leases_active_path ON worktree_leases(canonical_path)
              WHERE (status NOT IN ('RELEASED', 'FAILED', 'QUARANTINED')
                OR (status = 'RELEASED' AND COALESCE(json_extract(metadata_json, '$.release_finalized'), 0) != 1)
                OR (status = 'QUARANTINED' AND COALESCE(json_extract(metadata_json, '$.quarantine_finalized'), 0) != 1));
            CREATE UNIQUE INDEX idx_worktree_leases_active_repo_branch ON worktree_leases(canonical_repo, branch)
              WHERE (status NOT IN ('RELEASED', 'FAILED', 'QUARANTINED')
                OR (status = 'RELEASED' AND COALESCE(json_extract(metadata_json, '$.release_finalized'), 0) != 1)
                OR (status = 'QUARANTINED' AND COALESCE(json_extract(metadata_json, '$.quarantine_finalized'), 0) != 1));
          `);
        } else if (scenario === "extra-index") {
          seed.query("CREATE UNIQUE INDEX idx_worktree_leases_unexpected ON worktree_leases(task_id)").run();
        } else if (scenario === "invalid-terminal-proof"
          || scenario === "numeric-terminal-proof"
          || scenario === "empty-terminal-proof"
          || scenario === "intermediate-terminal-proof"
          || scenario === "uppercase-terminal-proof") {
          seed.exec(`
            INSERT INTO worktree_leases (
              lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
              branch, owner, status, generation, fencing_token, head_sha,
              expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
            ) VALUES (
              'wt_invalid_terminal_proof', 'hasna/repos', 'task-proof', 'run-proof',
              'station01', '/tmp/invalid-proof', 'task/invalid-proof', 'owner', 'released',
              1, 'token-proof', '${scenario === "uppercase-terminal-proof" ? "A".repeat(40) : "a".repeat(40)}', 1, 1, 1, 1,
              '${scenario === "numeric-terminal-proof"
                ? `{"release_finalized":1,"release_verified_head_sha":"${"a".repeat(40)}","release_finalized_at_ms":1}`
                : scenario === "empty-terminal-proof"
                  ? `{"release_finalized":true,"release_verified_head_sha":"","release_finalized_at_ms":-1}`
                  : scenario === "intermediate-terminal-proof"
                    ? `{"release_finalized":true,"release_verified_head_sha":"${"a".repeat(48)}","release_finalized_at_ms":1}`
                    : scenario === "uppercase-terminal-proof"
                      ? `{"release_finalized":true,"release_verified_head_sha":"${"A".repeat(40)}","release_finalized_at_ms":1}`
                  : `{"release_finalized":true}`}'
            );
          `);
        } else {
          seed.query("DROP INDEX idx_worktree_leases_active_path").run();
          seed.query("DROP INDEX idx_worktree_leases_active_repo_branch").run();
          if (scenario === "duplicate-active" || scenario === "unknown-status-duplicate") {
            seed.exec(`
              INSERT INTO worktree_leases (
                lease_id, canonical_repo, task_id, run_id, machine_id,
                canonical_path, branch, owner, status, generation, fencing_token,
                expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms,
                metadata_json
              ) VALUES
                ('wt_marker_drift_a', 'hasna/repos', 'task-a', 'run-a', 'station01',
                 '/tmp/marker-drift', 'task/marker-drift', 'a',
                 '${scenario === "unknown-status-duplicate" ? "future_in_progress" : "preparing"}', 1,
                 'token-a', 1, 1, 1, 1, '{}'),
                ('wt_marker_drift_b', 'hasna/repos', 'task-b', 'run-b', 'station01',
                 '/tmp/marker-drift', 'task/marker-drift', 'b', 'preparing', 1,
                 'token-b', 1, 1, 1, 1, '{}');
            `);
          }
        }
        seed.close();

        const expected = scenario === "missing-column"
          || scenario === "extra-column"
          || scenario === "wrong-default"
          || scenario === "wrong-table-sql"
          ? "table SQL"
          : scenario === "missing-indexes"
            ? "indexes"
            : scenario === "wrong-index-literal-case"
              ? "indexes"
            : scenario === "extra-index"
              ? "unexpected indexes"
            : scenario === "invalid-terminal-proof"
              ? "terminal proof payload"
            : scenario === "numeric-terminal-proof"
              ? "terminal proof payload"
            : scenario === "empty-terminal-proof"
              ? "terminal proof payload"
            : scenario === "intermediate-terminal-proof"
              ? "terminal proof payload"
            : scenario === "uppercase-terminal-proof"
              ? "terminal proof payload"
            : "duplicate active worktree path";
        expect(() => getDb(path)).toThrow(expected);
        const check = new Database(path, { readonly: true });
        expect(check.query("SELECT 1 FROM migrations WHERE version = 21").get()).toEqual({ 1: 1 });
        check.close();
      } finally {
        closeDb();
        rmSync(dir, { recursive: true, force: true });
        process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
        getDb(":memory:");
      }
    }
  });

  it("accepts exact 64-hex terminal proofs in validation and ownership indexes", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-sha256-terminal-proof-"));
    const path = join(dir, "repos.db");
    try {
      const initial = getDb(path);
      const objectId = "a".repeat(64);
      initial.exec(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token, head_sha,
          expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES
          (
            'wt_sha256_released', 'hasna/repos', 'task-released', 'run-released',
            'station01', '/tmp/sha256-released', 'task/sha256-released', 'owner',
            'released', 1, 'token-released', '${objectId}', 1, 1, 1, 1,
            '{"release_finalized":true,"release_verified_head_sha":"${objectId}","release_finalized_at_ms":1}'
          ),
          (
            'wt_sha256_quarantined', 'hasna/repos', 'task-quarantined', 'run-quarantined',
            'station01', '/tmp/sha256-quarantined', 'task/sha256-quarantined', 'owner',
            'quarantined', 2, 'token-quarantined', '${objectId}', 1, 1, 1, 1,
            '{"quarantine_finalized":true,"verified_head_sha":"${objectId}","quarantine_path":"/tmp/sha256-quarantined","backup_ref":"refs/hasna/worktrees/wt_sha256_quarantined/2","quarantine_finalized_at_ms":1}'
          );
      `);
      closeDb();

      const reopened = getDb(path);
      reopened.exec(`
        INSERT INTO worktree_leases (
          lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
          branch, owner, status, generation, fencing_token,
          expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
        ) VALUES
          (
            'wt_sha256_released_successor', 'hasna/repos', 'task-released-next', 'run-released-next',
            'station02', '/tmp/sha256-released', 'task/sha256-released', 'next-owner',
            'active', 1, 'token-released-next', 2, 2, 2, 2, '{}'
          ),
          (
            'wt_sha256_quarantined_successor', 'hasna/repos', 'task-quarantined-next', 'run-quarantined-next',
            'station02', '/tmp/sha256-quarantined', 'task/sha256-quarantined', 'next-owner',
            'active', 1, 'token-quarantined-next', 2, 2, 2, 2, '{}'
          );
      `);
      expect(reopened.query("SELECT lease_id FROM worktree_leases WHERE owner = 'next-owner' ORDER BY lease_id").all())
        .toEqual([
          { lease_id: "wt_sha256_quarantined_successor" },
          { lease_id: "wt_sha256_released_successor" },
        ]);
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
    try {
      const initial = getDb(path);
      initial.exec(`
        INSERT INTO repos (id, path, name) VALUES
          (2, '/tmp/source', 'source'),
          (3, '/tmp/target', 'target');
        INSERT INTO repo_relocation_audit VALUES (
        'receipt-1', 'key-1', 'request-hash', 'plan-hash', 2, 3,
        'primary_relocation', 'test:actor', '/legacy', '/canonical',
        'github.com/hasna/accounts', '${"a".repeat(40)}', 'source-revision',
        'target-revision', '{"id":2}', '{"id":3}', '{"id":2}', '{}', '[]',
        '2026-07-15T00:00:00.000Z'
      );
      `);
      const before = initial.query("SELECT * FROM repo_relocation_audit").get();
      closeDb();

      const seed = new Database(path);
      seed.exec(`
        PRAGMA foreign_keys = ON;
        DELETE FROM migrations WHERE version = 7;
        DROP INDEX idx_repo_relocation_audit_repo;
        ALTER TABLE repo_relocation_audit RENAME TO repo_relocation_audit_current;
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
        INSERT INTO repo_relocation_audit SELECT * FROM repo_relocation_audit_current;
        DROP TABLE repo_relocation_audit_current;
        CREATE INDEX idx_repo_relocation_audit_repo
          ON repo_relocation_audit(repo_id, created_at);
        CREATE TABLE repo_relocation_audit_v7 (sentinel TEXT);
      `);
      seed.close();

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
    const snapshot = JSON.stringify({ id: 1, path: "/tmp/v9", name: "v9", remote_url: unsafe });

    try {
      const initial = getDb(path);
      const repo = initial.query("INSERT INTO repos (path, name, remote_url) VALUES ('/tmp/v9', 'v9', ?) RETURNING id")
        .get(unsafe) as { id: number };
      initial.query("INSERT INTO remotes (repo_id, name, url, fetch_url) VALUES (?, 'origin', ?, ?)")
        .run(repo.id, unsafe, unsafe);
      initial.query("INSERT INTO remotes (repo_id, name, url) VALUES (?, 'local', 'file:///tmp/v9')")
        .run(repo.id);
      initial.query(`INSERT INTO repo_relocation_audit (
        id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id,
        operation, actor, expected_current_path, target_path, expected_remote,
        expected_head, source_revision, target_revision, source_json,
        target_json, after_json, counts_json, collisions_json, created_at
      ) VALUES (
        'receipt-v9', 'receipt-v9-key', 'request-hash', 'plan-hash', ?, ?,
        'primary_relocation', 'migration-test', '/tmp/v9', '/tmp/v9', ?,
        ?, 'source-revision', 'target-revision', ?, ?, ?, '{}', '[]',
        '2026-07-15T00:00:00.000Z'
      )`).run(
        repo.id,
        repo.id,
        unsafe,
        "a".repeat(40),
        snapshot,
        snapshot,
        snapshot,
      );
      initial.query("DELETE FROM migrations WHERE version = 9").run();
      closeDb();

      const migrated = getDb(path);
      expect(migrated.query("SELECT remote_url FROM repos WHERE id = ?").get(repo.id)).toEqual({
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
          INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8), (21);
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
      expect(() => getDb(path)).toThrow("remote identity successor migration failed exact-state verification");
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

  it("rolls back v9 when the real migration marker insert triggers recontamination", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-marker-trigger-"));
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
        VALUES (1, '/tmp/marker-trigger', 'marker-trigger', '${unsafe}');
      CREATE TRIGGER migrations_v9_recontaminate AFTER INSERT ON migrations
      WHEN NEW.version = 9
      BEGIN
        UPDATE repos SET remote_url = '${unsafe}' WHERE id = 1;
      END;
    `);
    seed.close();

    try {
      expect(() => getDb(path)).toThrow("remote identity successor migration failed exact-state verification");
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

  it("rolls back v9 when the marker trigger makes canonical same-count substitutions", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-exact-marker-"));
    const path = join(dir, "repos.db");
    const original = "github.com/hasna/original";
    const substituted = "github.com/hasna/substituted";
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE);
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8);
      CREATE TABLE repos (id INTEGER PRIMARY KEY, path TEXT, name TEXT, remote_url TEXT);
      CREATE TABLE remotes (id INTEGER PRIMARY KEY, url TEXT, fetch_url TEXT);
      CREATE TABLE repo_relocation_audit (
        id TEXT PRIMARY KEY, expected_remote TEXT, source_json TEXT, target_json TEXT, after_json TEXT
      );
      INSERT INTO repos VALUES (1, '/tmp/exact-marker', 'exact-marker', '${original}');
      INSERT INTO remotes VALUES (11, '${original}', '${original}');
      INSERT INTO repo_relocation_audit VALUES (
        'exact-receipt', '${original}',
        '{"remote_url":"${original}"}',
        '{"remote_url":"${original}"}',
        '{"remote_url":"${original}"}'
      );
      CREATE TRIGGER migrations_v9_substitute AFTER INSERT ON migrations
      WHEN NEW.version = 9
      BEGIN
        UPDATE repos SET remote_url = '${substituted}' WHERE id = 1;
        DELETE FROM remotes WHERE id = 11;
        INSERT INTO remotes VALUES (12, '${substituted}', '${substituted}');
        UPDATE repo_relocation_audit SET
          expected_remote = '${substituted}',
          source_json = '{"remote_url":"${substituted}"}'
          WHERE id = 'exact-receipt';
      END;
    `);
    seed.close();

    try {
      expect(() => getDb(path)).toThrow("remote identity successor migration failed exact-state verification");
      closeDb();
      const raw = new Database(path);
      expect(raw.query("SELECT id, remote_url FROM repos").all()).toEqual([{ id: 1, remote_url: original }]);
      expect(raw.query("SELECT id, url, fetch_url FROM remotes").all()).toEqual([{
        id: 11,
        url: original,
        fetch_url: original,
      }]);
      expect(raw.query("SELECT expected_remote, source_json FROM repo_relocation_audit").get()).toEqual({
        expected_remote: original,
        source_json: JSON.stringify({ remote_url: original }),
      });
      expect(raw.query("SELECT version FROM migrations WHERE version = 9").get()).toBeNull();
      raw.close();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
      getDb(":memory:");
    }
  });

  it("rolls back v9 when the marker trigger changes a non-remote receipt field", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "repos-v9-complete-receipt-"));
    const path = join(dir, "repos.db");
    const identity = "github.com/hasna/original";
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE);
      INSERT INTO migrations (version) VALUES (1), (2), (3), (4), (6), (7), (8);
      CREATE TABLE repos (id INTEGER PRIMARY KEY, path TEXT, name TEXT, remote_url TEXT);
      CREATE TABLE remotes (id INTEGER PRIMARY KEY, url TEXT, fetch_url TEXT);
      CREATE TABLE repo_relocation_audit (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        expected_remote TEXT NOT NULL,
        source_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        after_json TEXT NOT NULL
      );
      INSERT INTO repos VALUES (1, '/tmp/complete-receipt', 'complete-receipt', '${identity}');
      INSERT INTO repo_relocation_audit VALUES (
        'complete-receipt', 'reviewed-actor', '${identity}',
        '{"remote_url":"${identity}"}',
        '{"remote_url":"${identity}"}',
        '{"remote_url":"${identity}"}'
      );
      CREATE TRIGGER migrations_v9_change_actor AFTER INSERT ON migrations
      WHEN NEW.version = 9
      BEGIN
        UPDATE repo_relocation_audit SET actor = 'substituted-actor'
        WHERE id = 'complete-receipt';
      END;
    `);
    seed.close();

    try {
      expect(() => getDb(path)).toThrow("remote identity successor migration failed exact-state verification");
      closeDb();
      const raw = new Database(path);
      expect(raw.query("SELECT actor FROM repo_relocation_audit").get()).toEqual({ actor: "reviewed-actor" });
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
        stdout: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21].map((version) => ({ version }))),
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
