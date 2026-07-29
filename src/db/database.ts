import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizeRemoteIdentity } from "../lib/remote-identity.js";
import { resolvePullRequestOrigin } from "../lib/pr-identity.js";

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

function rejectSqliteMemoryUri(path: string): string {
  if (path.startsWith("file::memory:")) {
    throw new Error("SQLite memory URI paths are unsupported; use exact :memory:");
  }
  return path;
}

export function getDbPath(): string {
  if (process.env["HASNA_REPOS_DB_PATH"]) {
    return rejectSqliteMemoryUri(process.env["HASNA_REPOS_DB_PATH"]);
  }
  if (process.env["REPOS_DB_PATH"]) {
    return rejectSqliteMemoryUri(process.env["REPOS_DB_PATH"]);
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

export interface NonMigratingDatabaseContext {
  db: Database;
  path: string;
  close: () => void;
}

function normalizeDbPath(path: string): string {
  rejectSqliteMemoryUri(path);
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
  if (path === ":memory:") return path;

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

  if (path !== ":memory:") {
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

/**
 * Open an exact caller-selected registry for inspection without running schema
 * migrations or changing the process-wide singleton. File-backed contexts are
 * read-only, so a planning call cannot create a database, negotiate WAL, or
 * persist a pending migration. An already-open in-memory context is reused
 * because SQLite cannot reopen the same private in-memory database.
 */
export function openNonMigratingDb(customPath?: string): NonMigratingDatabaseContext {
  if (_db) {
    if (customPath !== undefined && normalizeDbPath(customPath) !== _dbPath) {
      throw new Error("cannot switch Repos database paths while a database is open; call closeDb() first");
    }
    return { db: _db, path: _dbPath!, close: () => {} };
  }
  if (customPath === undefined) {
    throw new Error("non-migrating Repos access requires an explicit database path");
  }
  const path = normalizeDbPath(customPath);
  if (path === ":memory:") {
    throw new Error("non-migrating in-memory Repos access requires an active database context");
  }
  if (!existsSync(path)) {
    throw new Error("non-migrating Repos database does not exist");
  }
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, path, close: () => db.close() };
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
  run?: (db: Database) => unknown;
  verifyAfterMarker?: (db: Database, runResult: unknown) => void;
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

interface V9RemoteIdentityTargetState {
  repos: Array<{ id: number; remote_url: string | null }>;
  remotes: Array<{ id: number; url: string; fetch_url: string | null }>;
  audits: Array<Record<string, unknown>>;
}

function stableMigrationState(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableMigrationState).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableMigrationState(record[key])}`).join(",")}}`;
}

function readV9RemoteIdentityState(db: Database): V9RemoteIdentityTargetState {
  return {
    repos: (db.query("SELECT id, remote_url FROM repos").all() as V9RemoteIdentityTargetState["repos"])
      .sort((left, right) => left.id - right.id),
    remotes: (db.query("SELECT id, url, fetch_url FROM remotes").all() as V9RemoteIdentityTargetState["remotes"])
      .sort((left, right) => left.id - right.id),
    // The complete durable receipt is part of the exact migration target.
    // Selecting only the rewritten fields would let a marker-time trigger
    // alter an actor, hash, count, revision, or timestamp without detection.
    audits: (db.query("SELECT * FROM repo_relocation_audit").all() as V9RemoteIdentityTargetState["audits"])
      .sort((left, right) => String(left["id"]) < String(right["id"]) ? -1 : String(left["id"]) > String(right["id"]) ? 1 : 0),
  };
}

function verifyV9RemoteIdentityState(db: Database, expected: unknown): void {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("remote identity successor migration is missing exact target state");
  }
  const actual = readV9RemoteIdentityState(db);
  // Compare complete ID-keyed target rows, including deletion and exact
  // cardinality. Canonicality alone would allow a trigger to substitute a
  // different canonical value or replace one row with another.
  if (stableMigrationState(actual) !== stableMigrationState(expected)) {
    throw new Error("remote identity successor migration failed exact-state verification");
  }
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("remote identity successor migration failed foreign-key verification");
  }
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
        const runResult = migration.run?.(db);
        db.query("INSERT INTO migrations (version) VALUES (?)").run(migration.version);
        migration.verifyAfterMarker?.(db, runResult);
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
        UNIQUE(repo_id, name, is_remote)
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
      const targetRepos = repoRows
        .map((row) => ({ id: row.id, remote_url: sanitizeRemoteIdentity(row.remote_url) }))
        .sort((left, right) => left.id - right.id);
      const updateRepo = db.query("UPDATE repos SET remote_url = ? WHERE id = ?");
      for (const row of targetRepos) updateRepo.run(row.remote_url, row.id);

      const remoteRows = db.query("SELECT id, url, fetch_url FROM remotes").all() as Array<{
        id: number;
        url: string;
        fetch_url: string | null;
      }>;
      const targetRemotes = remoteRows.flatMap((row) => {
        const url = sanitizeRemoteIdentity(row.url);
        return url ? [{ id: row.id, url, fetch_url: sanitizeRemoteIdentity(row.fetch_url) }] : [];
      }).sort((left, right) => left.id - right.id);
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

      const auditRows = db.query("SELECT * FROM repo_relocation_audit").all() as Array<Record<string, unknown>>;
      const targetAudits = auditRows.map<Record<string, unknown>>((row) => ({
        ...row,
        expected_remote: sanitizeRemoteIdentity(row["expected_remote"]) ?? "",
        source_json: sanitizeRelocationSnapshot(String(row["source_json"])),
        target_json: sanitizeRelocationSnapshot(String(row["target_json"])),
        after_json: sanitizeRelocationSnapshot(String(row["after_json"])),
      })).sort((left, right) => String(left["id"]) < String(right["id"]) ? -1 : String(left["id"]) > String(right["id"]) ? 1 : 0);
      const updateAudit = db.query(`UPDATE repo_relocation_audit SET
        expected_remote = ?, source_json = ?, target_json = ?, after_json = ? WHERE id = ?`);
      for (const row of targetAudits) {
        updateAudit.run(
          String(row["expected_remote"]),
          String(row["source_json"]),
          String(row["target_json"]),
          String(row["after_json"]),
          String(row["id"]),
        );
      }

      if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts_repos'").get()) {
        db.exec("INSERT INTO fts_repos(fts_repos) VALUES ('rebuild')");
      }
      const expected: V9RemoteIdentityTargetState = {
        repos: targetRepos,
        remotes: targetRemotes,
        audits: targetAudits,
      };
      verifyV9RemoteIdentityState(db, expected);
      return expected;
    },
    verifyAfterMarker: verifyV9RemoteIdentityState,
  },
  {
    version: 10,
    run(db) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branches'").get()) return;
      db.exec(`
        DROP INDEX IF EXISTS idx_branches_repo;

        CREATE TABLE branches_v10 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          is_remote INTEGER NOT NULL DEFAULT 0,
          last_commit_sha TEXT,
          last_commit_date TEXT,
          ahead INTEGER NOT NULL DEFAULT 0,
          behind INTEGER NOT NULL DEFAULT 0,
          UNIQUE(repo_id, name, is_remote)
        );

        INSERT INTO branches_v10 (
          id, repo_id, name, is_remote, last_commit_sha, last_commit_date, ahead, behind
        ) SELECT
          id, repo_id, name, is_remote, last_commit_sha, last_commit_date, ahead, behind
        FROM branches;

        DROP TABLE branches;
        ALTER TABLE branches_v10 RENAME TO branches;
        CREATE INDEX idx_branches_repo ON branches(repo_id);
      `);
    },
  },
  {
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS branch_adjudication_audit (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_branch_adjudication_audit_created
        ON branch_adjudication_audit(created_at);
    `,
  },
  {
    // Merge-gate columns for pull_requests plus the identity index the
    // cross-checkout de-duplication read path depends on. The same GitHub PR is
    // indexed once per local checkout of that repository, so `url` — not
    // (repo_id, number) — is the stable identity of a pull request.
    version: 12,
    run: (db) => upgradePullRequestGateColumns(db),
  },
  {
    // Receipts for `repos registry prune`. A deletion primitive on the registry
    // has to answer "who removed row 526, when, and against which plan" after
    // the row is gone, so the removed rows are stored verbatim. repo_id is a
    // plain INTEGER, not a foreign key: the row it refers to no longer exists,
    // which is the whole point of the receipt.
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS registry_prune_audit (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        plan_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        rows_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_registry_prune_audit_created
        ON registry_prune_audit(created_at);
    `,
  },
  {
    // Worktree leases: who claimed which worktree, off which base, for which
    // task, on which machine.
    //
    // This table is not new. It exists on the live registry on this station,
    // holding three rows dated 2026-07-09/10, and `primary-relocation` and
    // `registry-prune` have both known about it for months — but no migration
    // ever created it and no shipped build ever inserted into it. It arrived
    // from a build that is not in this tree, which means a fresh install has
    // never had the table at all while an old station silently does. Two
    // divergent schemas for the same name is the exact shape that makes a
    // later migration unsafe to write.
    //
    // So this states the schema in the tree, matching the live one column for
    // column, and adds nothing to it. `IF NOT EXISTS` keeps the existing rows
    // and their history; the column check below turns a *different* pre-existing
    // shape into a loud failure rather than an INSERT that fails at runtime on
    // one station and works on another.
    version: 14,
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_leases (
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

      // The shape check runs BEFORE the indexes, and that ordering is the whole
      // point of splitting the statements.
      //
      // Adversarial review found the first version of this migration unusable on
      // exactly the station it was written to protect: with the indexes in the
      // same `exec` block, `CREATE INDEX … ON worktree_leases(repo_id)` reached a
      // pre-existing table that has no `repo_id` and SQLite raised "no such
      // column: repo_id" first. The diagnostic below never ran — it was dead
      // code for its only input — and because the migration marker is written
      // after `run()`, every subsequent `getDb()` failed the same way. One
      // divergent table bricked every `repos` verb on that station with no
      // in-CLI recovery.
      const present = columnNames(db, "worktree_leases");
      const missing = WORKTREE_LEASE_COLUMNS.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw new Error(
          `worktree_leases exists with an unexpected schema; missing columns: ${missing.join(", ")}. `
          + "Back up ~/.hasna/repos/repos.db, then rename or drop the table so this migration can create it.",
        );
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktree_leases_repo ON worktree_leases(repo_id);
        CREATE INDEX IF NOT EXISTS idx_worktree_leases_task ON worktree_leases(task_id);
        CREATE INDEX IF NOT EXISTS idx_worktree_leases_status ON worktree_leases(status);
        CREATE INDEX IF NOT EXISTS idx_worktree_leases_machine ON worktree_leases(machine_id);
      `);
    },
  },
];

/**
 * Every column the lease writers depend on. Compared against the live table so
 * a station carrying the out-of-tree variant fails at migration time — where
 * the operator can see it — rather than at the first INSERT.
 */
const WORKTREE_LEASE_COLUMNS = [
  "lease_id",
  "repo_id",
  "repo_path",
  "repo_catalog_id",
  "machine_id",
  "worktree_path",
  "branch",
  "base_ref",
  "base_sha",
  "task_id",
  "run_id",
  "mode",
  "owner_metadata",
  "cleanup_policy",
  "status",
  "git_common_dir",
  "created_at",
  "updated_at",
  "claimed_at",
  "verified_at",
  "released_at",
  "last_error",
] as const;

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== null;
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

const PR_GATE_COLUMNS: Array<[string, string]> = [
  ["head_sha", "TEXT"],
  ["mergeable", "TEXT"],
  ["merge_state_status", "TEXT"],
  ["ci_state", "TEXT"],
  ["is_draft", "INTEGER NOT NULL DEFAULT 0"],
  ["review_decision", "TEXT"],
  // GitHub identity resolved from the PR's own URL. Stored rather than derived
  // per query so --org filtering and de-duplication stay indexed instead of
  // loading the whole table into memory.
  ["gh_owner", "TEXT"],
  ["gh_repo", "TEXT"],
];

/**
 * Add the merge-gate and identity columns, then repair identities the old write
 * path lost.
 *
 * Written imperatively rather than as a static SQL blob because it has to run
 * against databases that reached this point by different routes — including
 * ones whose earlier migrations were recorded without every table being
 * created. Each step therefore checks for what it is about to touch, and adding
 * an already-present column is a no-op rather than a failure.
 */
function upgradePullRequestGateColumns(db: Database): number {
  if (!tableExists(db, "pull_requests")) return 0;

  const existing = columnNames(db, "pull_requests");
  for (const [name, definition] of PR_GATE_COLUMNS) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE pull_requests ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prs_url ON pull_requests(url);
    CREATE INDEX IF NOT EXISTS idx_prs_updated ON pull_requests(updated_at);
    CREATE INDEX IF NOT EXISTS idx_prs_owner ON pull_requests(gh_owner, gh_repo);
  `);

  // Repair the FTS mirror before touching row data.
  //
  // Writes used INSERT OR REPLACE, which resolves a conflict by deleting the
  // existing row and inserting a new one — and with PRAGMA recursive_triggers
  // OFF (the default; nothing here enables it) that delete never fired prs_ad.
  // Every re-sync therefore appended another entry and orphaned the previous
  // one. On the live index this left roughly seven stale entries per live row.
  // The join in searchPullRequests hides them, so this is bloat rather than
  // wrong results, but it grows without bound. A rebuild re-derives the whole
  // index from the external content table.
  if (tableExists(db, "fts_prs")) {
    db.exec("INSERT INTO fts_prs(fts_prs) VALUES('rebuild')");
  }

  // A scan that could not read `git remote get-url origin` used to overwrite a
  // known-good remote identity with NULL. Restore what the per-repo remotes
  // table still knows; lib/scanner.ts stops the bleeding going forward.
  if (tableExists(db, "repos") && tableExists(db, "remotes")) {
    db.exec(`
      UPDATE repos
      SET remote_url = (
        SELECT url FROM remotes
        WHERE remotes.repo_id = repos.id AND remotes.name = 'origin' AND remotes.url IS NOT NULL
        LIMIT 1
      )
      WHERE remote_url IS NULL
        AND EXISTS (
          SELECT 1 FROM remotes
          WHERE remotes.repo_id = repos.id AND remotes.name = 'origin' AND remotes.url IS NOT NULL
        );

      UPDATE repos
      SET org = substr(remote_url, instr(remote_url, '/') + 1,
                       instr(substr(remote_url, instr(remote_url, '/') + 1), '/') - 1)
      WHERE org IS NULL AND remote_url IS NOT NULL AND instr(remote_url, '/') > 0;
    `);
  }

  const updated = backfillPullRequestOrigins(db);

  // Created only after the backfill so that rewriting every row's gh_owner does
  // not push two FTS writes per row through the trigger.
  if (tableExists(db, "fts_prs")) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prs_au AFTER UPDATE ON pull_requests BEGIN
        INSERT INTO fts_prs(fts_prs, rowid, title, author)
        VALUES ('delete', old.id, old.title, old.author);
        INSERT INTO fts_prs(rowid, title, author)
        VALUES (new.id, new.title, new.author);
      END;
    `);
  }

  return updated;
}

/**
 * Populate gh_owner/gh_repo for rows written before migration 12. Parsing is
 * done in TypeScript so it uses the same parser the write path uses, instead of
 * a second, divergent SQL implementation.
 */
function backfillPullRequestOrigins(db: Database): number {
  const hasRepos = tableExists(db, "repos");
  const rows = db
    .query(hasRepos
      ? "SELECT p.id, p.url, r.remote_url, r.org FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id"
      : "SELECT id, url, NULL AS remote_url, NULL AS org FROM pull_requests")
    .all() as Array<{ id: number; url: string | null; remote_url: string | null; org: string | null }>;
  const update = db.query("UPDATE pull_requests SET gh_owner = ?, gh_repo = ? WHERE id = ?");
  let updated = 0;
  for (const row of rows) {
    const origin = resolvePullRequestOrigin(row.url, row.remote_url, row.org);
    if (!origin.org && !origin.repo) continue;
    update.run(origin.org, origin.repo, row.id);
    updated++;
  }
  return updated;
}
