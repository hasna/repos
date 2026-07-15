import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizeRemoteIdentity } from "../lib/remote-identity.js";

function findNearestReposDb(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".repos", "repos.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getDbPath(): string {
  if (process.env["HASNA_REPOS_DB_PATH"]) {
    return process.env["HASNA_REPOS_DB_PATH"];
  }
  if (process.env["REPOS_DB_PATH"]) {
    return process.env["REPOS_DB_PATH"];
  }

  if (process.env["HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH"] === "1") {
    throw new Error("an explicit Repos database path is required");
  }

  const cwd = process.cwd();
  const nearest = findNearestReposDb(cwd);
  if (nearest) return nearest;

  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const newPath = join(home, ".hasna", "repos", "repos.db");
  const legacyPath = join(home, ".git-local", "repos.db");

  if (existsSync(legacyPath) && !existsSync(newPath)) {
    return legacyPath;
  }

  return newPath;
}

let _db: Database | null = null;
let _dbPath: string | null = null;
let _dbMigrated = false;
const WAL_NEGOTIATION_TIMEOUT_MS = 5_000;
const WAL_NEGOTIATION_WAIT_MS = 10;
const walNegotiationWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteLockContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlite = error as { code?: unknown; errno?: unknown };
  return sqlite.code === "SQLITE_BUSY"
    || sqlite.code === "SQLITE_LOCKED"
    || sqlite.errno === 5
    || sqlite.errno === 6;
}

function enableWalWithBoundedRetry(db: Database): void {
  const deadline = performance.now() + WAL_NEGOTIATION_TIMEOUT_MS;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!isSqliteLockContention(error) || remaining <= 0) throw error;
      Atomics.wait(
        walNegotiationWait,
        0,
        0,
        Math.min(WAL_NEGOTIATION_WAIT_MS, remaining),
      );
    }
  }
}

export interface DatabaseOpenOptions {
  migrate?: boolean;
}

function normalizeDbPath(path: string): string {
  if (path === ":memory:" || path.startsWith("file:")) return path;
  return resolve(path);
}

function getExplicitNonDefaultDbPath(customPath?: string): string {
  const configured = customPath
    ?? process.env["HASNA_REPOS_DB_PATH"]
    ?? process.env["REPOS_DB_PATH"];
  if (!configured) {
    throw new Error("migrate:false requires an explicit non-default Repos database path");
  }
  const path = normalizeDbPath(configured);
  if (path === ":memory:" || path.startsWith("file::memory:")) return path;

  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const defaults = [
    normalizeDbPath(join(home, ".hasna", "repos", "repos.db")),
    normalizeDbPath(join(home, ".git-local", "repos.db")),
  ];
  if (defaults.includes(path)) {
    throw new Error("migrate:false requires an explicit non-default Repos database path");
  }
  return path;
}

export function getDb(customPath?: string, options: DatabaseOpenOptions = {}): Database {
  if (_db) {
    if (customPath !== undefined && normalizeDbPath(customPath) !== _dbPath) {
      throw new Error("cannot switch Repos database paths while a database is open; call closeDb() first");
    }
    if (options.migrate !== false && !_dbMigrated) {
      runMigrations(_db);
      _dbMigrated = true;
    }
    return _db;
  }

  const path = options.migrate === false
    ? getExplicitNonDefaultDbPath(customPath)
    : normalizeDbPath(customPath ?? getDbPath());

  if (path !== ":memory:" && !path.startsWith("file::memory:")) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  try {
    // Install the bounded lock wait before journal-mode negotiation: a group
    // of processes may all be opening and migrating the same new database.
    db.exec("PRAGMA busy_timeout = 5000");
    // SQLite's journal-mode PRAGMA can still return SQLITE_BUSY immediately
    // while another first opener is negotiating WAL, without invoking the
    // connection busy handler. Retry only that bounded first-open boundary.
    enableWalWithBoundedRetry(db);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");

    if (options.migrate !== false) {
      runMigrations(db);
      _dbMigrated = true;
    }
  } catch (error) {
    db.close();
    _dbMigrated = false;
    throw error;
  }

  _db = db;
  _dbPath = path;
  return db;
}

/** Apply pending migrations to an already-open, caller-owned database. */
export function migrateDb(db: Database): void {
  runMigrations(db);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
    _dbMigrated = false;
  }
}

interface Migration {
  version: number;
  sql?: string;
  run?: (db: Database) => void;
}

function sanitizeRelocationSnapshot(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("remote identity migration found an invalid relocation snapshot");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("remote identity migration found an invalid relocation snapshot");
  }
  const snapshot = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(snapshot, "remote_url")) {
    snapshot["remote_url"] = sanitizeRemoteIdentity(snapshot["remote_url"]);
  }
  return JSON.stringify(snapshot);
}

function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  for (const migration of MIGRATIONS) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have completed this migration while this process
      // waited for the write lock, so the marker must be read under that lock.
      const applied = db.query("SELECT 1 FROM migrations WHERE version = ?").get(migration.version);
      if (!applied) {
        if (migration.sql) db.exec(migration.sql);
        migration.run?.(db);
        db.query("INSERT INTO migrations (version) VALUES (?)").run(migration.version);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
      throw error;
    }
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        org TEXT,
        remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        description TEXT,
        last_scanned TEXT,
        commit_count INTEGER NOT NULL DEFAULT 0,
        branch_count INTEGER NOT NULL DEFAULT 0,
        tag_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_repos_name ON repos(name);
      CREATE INDEX idx_repos_org ON repos(org);

      CREATE TABLE commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        date TEXT NOT NULL,
        message TEXT NOT NULL,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, sha)
      );

      CREATE INDEX idx_commits_repo ON commits(repo_id);
      CREATE INDEX idx_commits_date ON commits(date);
      CREATE INDEX idx_commits_author ON commits(author_email);

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

      CREATE INDEX idx_branches_repo ON branches(repo_id);

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sha TEXT NOT NULL,
        date TEXT,
        message TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX idx_tags_repo ON tags(repo_id);

      CREATE TABLE remotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        fetch_url TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE TABLE pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        merged_at TEXT,
        closed_at TEXT,
        url TEXT,
        base_branch TEXT,
        head_branch TEXT,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, number)
      );

      CREATE INDEX idx_prs_repo ON pull_requests(repo_id);
      CREATE INDEX idx_prs_state ON pull_requests(state);
      CREATE INDEX idx_prs_author ON pull_requests(author);

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        session_id TEXT,
        capabilities TEXT DEFAULT '[]',
        working_dir TEXT,
        focus_project_id TEXT,
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_repos USING fts5(
        name, org, description, remote_url,
        content='repos', content_rowid='id'
      );

      CREATE TRIGGER repos_ai AFTER INSERT ON repos BEGIN
        INSERT INTO fts_repos(rowid, name, org, description, remote_url)
        VALUES (new.id, new.name, new.org, new.description, new.remote_url);
      END;

      CREATE TRIGGER repos_ad AFTER DELETE ON repos BEGIN
        INSERT INTO fts_repos(fts_repos, rowid, name, org, description, remote_url)
        VALUES ('delete', old.id, old.name, old.org, old.description, old.remote_url);
      END;

      CREATE TRIGGER repos_au AFTER UPDATE ON repos BEGIN
        INSERT INTO fts_repos(fts_repos, rowid, name, org, description, remote_url)
        VALUES ('delete', old.id, old.name, old.org, old.description, old.remote_url);
        INSERT INTO fts_repos(rowid, name, org, description, remote_url)
        VALUES (new.id, new.name, new.org, new.description, new.remote_url);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(
        message, author_name, author_email,
        content='commits', content_rowid='id'
      );

      CREATE TRIGGER commits_ai AFTER INSERT ON commits BEGIN
        INSERT INTO fts_commits(rowid, message, author_name, author_email)
        VALUES (new.id, new.message, new.author_name, new.author_email);
      END;

      CREATE TRIGGER commits_ad AFTER DELETE ON commits BEGIN
        INSERT INTO fts_commits(fts_commits, rowid, message, author_name, author_email)
        VALUES ('delete', old.id, old.message, old.author_name, old.author_email);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_prs USING fts5(
        title, author,
        content='pull_requests', content_rowid='id'
      );

      CREATE TRIGGER prs_ai AFTER INSERT ON pull_requests BEGIN
        INSERT INTO fts_prs(rowid, title, author)
        VALUES (new.id, new.title, new.author);
      END;

      CREATE TRIGGER prs_ad AFTER DELETE ON pull_requests BEGIN
        INSERT INTO fts_prs(fts_prs, rowid, title, author)
        VALUES ('delete', old.id, old.title, old.author);
      END;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata TEXT,
        UNIQUE(source_type, source_id, relation, target_type, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS automation_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Version 5 is already used by the live worktree lease schema. Keep the
    // relocation audit on its own version so upgrades never skip it.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS repo_relocation_audit (
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

      CREATE INDEX IF NOT EXISTS idx_repo_relocation_audit_repo
        ON repo_relocation_audit(repo_id, created_at);
    `,
  },
  {
    // Relocation receipts are immutable historical facts. A receipt's repo_id
    // identifies the survivor at the time of that exact operation; it must not
    // be rewritten merely because that survivor is absorbed later. Rebuild the
    // live v6 table without a current-state repos FK so chained relocations can
    // delete a later target row without changing any prior receipt bytes.
    version: 7,
    sql: `
      DROP INDEX IF EXISTS idx_repo_relocation_audit_repo;

      CREATE TABLE repo_relocation_audit_v7 (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
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

      INSERT INTO repo_relocation_audit_v7 (
        id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id,
        operation, actor, expected_current_path, target_path, expected_remote,
        expected_head, source_revision, target_revision, source_json,
        target_json, after_json, counts_json, collisions_json, created_at
      ) SELECT
        id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id,
        operation, actor, expected_current_path, target_path, expected_remote,
        expected_head, source_revision, target_revision, source_json,
        target_json, after_json, counts_json, collisions_json, created_at
      FROM repo_relocation_audit;

      DROP TABLE repo_relocation_audit;
      ALTER TABLE repo_relocation_audit_v7 RENAME TO repo_relocation_audit;

      CREATE INDEX idx_repo_relocation_audit_repo
        ON repo_relocation_audit(repo_id, created_at);
    `,
  },
  {
    // Remote identities are public catalog metadata, never credential-bearing
    // transport URLs. This data rewrite and its version marker share the
    // outer BEGIN IMMEDIATE transaction in runMigrations.
    version: 8,
    run(db) {
      const tableColumns = (table: string) => new Set(
        (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      const repoColumns = tableColumns("repos");
      if (repoColumns.has("id") && repoColumns.has("remote_url")) {
        const repoRows = db.query("SELECT id, remote_url FROM repos").all() as Array<{
          id: number;
          remote_url: string | null;
        }>;
        const updateRepo = db.query("UPDATE repos SET remote_url = ? WHERE id = ?");
        for (const row of repoRows) {
          updateRepo.run(sanitizeRemoteIdentity(row.remote_url), row.id);
        }
      }

      const remoteColumns = tableColumns("remotes");
      if (remoteColumns.has("id") && remoteColumns.has("url") && remoteColumns.has("fetch_url")) {
        const remoteRows = db.query("SELECT id, url, fetch_url FROM remotes").all() as Array<{
          id: number;
          url: string;
          fetch_url: string | null;
        }>;
        const updateRemote = db.query("UPDATE remotes SET url = ?, fetch_url = ? WHERE id = ?");
        const deleteRemote = db.query("DELETE FROM remotes WHERE id = ?");
        for (const row of remoteRows) {
          const url = sanitizeRemoteIdentity(row.url);
          if (!url) {
            deleteRemote.run(row.id);
            continue;
          }
          updateRemote.run(url, sanitizeRemoteIdentity(row.fetch_url), row.id);
        }
      }

      if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts_repos'").get()) {
        db.exec("INSERT INTO fts_repos(fts_repos) VALUES ('rebuild')");
      }
      if (db.query("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("remote identity migration failed foreign-key verification");
      }
    },
  },
  {
    // V8 may already have been applied by a process that opened the registry
    // before the incident was contained. Preserve that exact migration and use
    // a successor for later contamination plus relocation receipt snapshots.
    version: 9,
    run(db) {
      const tableColumns = (table: string) => new Set(
        (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      const repoColumns = tableColumns("repos");
      const remoteColumns = tableColumns("remotes");
      const auditColumns = tableColumns("repo_relocation_audit");
      const required = [
        [repoColumns, ["id", "remote_url"]],
        [remoteColumns, ["id", "url", "fetch_url"]],
        [auditColumns, ["id", "expected_remote", "source_json", "target_json", "after_json"]],
      ] as const;
      if (required.some(([columns, names]) => names.some((name) => !columns.has(name)))) {
        throw new Error("v9 requires the exact remote-bearing schema");
      }

      const repoRows = db.query("SELECT id, remote_url FROM repos").all() as Array<{
        id: number;
        remote_url: string | null;
      }>;
      const updateRepo = db.query("UPDATE repos SET remote_url = ? WHERE id = ?");
      for (const row of repoRows) updateRepo.run(sanitizeRemoteIdentity(row.remote_url), row.id);

      const remoteRows = db.query("SELECT id, url, fetch_url FROM remotes").all() as Array<{
        id: number;
        url: string;
        fetch_url: string | null;
      }>;
      const updateRemote = db.query("UPDATE remotes SET url = ?, fetch_url = ? WHERE id = ?");
      const removeRemote = db.query("DELETE FROM remotes WHERE id = ?");
      for (const row of remoteRows) {
        const url = sanitizeRemoteIdentity(row.url);
        if (!url) {
          removeRemote.run(row.id);
          continue;
        }
        updateRemote.run(url, sanitizeRemoteIdentity(row.fetch_url), row.id);
      }

      const auditRows = db.query(`SELECT id, expected_remote, source_json, target_json, after_json
        FROM repo_relocation_audit`).all() as Array<{
        id: string;
        expected_remote: string;
        source_json: string;
        target_json: string;
        after_json: string;
      }>;
      const updateAudit = db.query(`UPDATE repo_relocation_audit SET
        expected_remote = ?, source_json = ?, target_json = ?, after_json = ? WHERE id = ?`);
      for (const row of auditRows) {
        updateAudit.run(
          sanitizeRemoteIdentity(row.expected_remote) ?? "",
          sanitizeRelocationSnapshot(row.source_json),
          sanitizeRelocationSnapshot(row.target_json),
          sanitizeRelocationSnapshot(row.after_json),
          row.id,
        );
      }

      if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts_repos'").get()) {
        db.exec("INSERT INTO fts_repos(fts_repos) VALUES ('rebuild')");
      }
      if (db.query("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("remote identity successor migration failed foreign-key verification");
      }
    },
  },
];
