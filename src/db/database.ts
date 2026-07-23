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

function reconcileRemoteIdentityState(db: Database): V9RemoteIdentityTargetState {
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
}

const BRANCH_COLUMN_CONTRACT = [
  { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
  { name: "repo_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "is_remote", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
  { name: "last_commit_sha", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "last_commit_date", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { name: "ahead", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
  { name: "behind", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
];

const BRANCH_AUDIT_COLUMN_CONTRACT = [
  { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
  { name: "idempotency_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "request_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "plan_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "operation", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "actor", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "row_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "before_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "after_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "rows_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "created_at", type: "TEXT", notnull: 1, dflt_value: "datetime('now')", pk: 0 },
];

function readTableColumnContract(db: Database, table: string): Array<{
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}> {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>).map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type,
    notnull,
    dflt_value,
    pk,
  }));
}

function readUniqueIndexColumnSets(db: Database, table: string): string[][] {
  return (db.query(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>)
    .filter((index) => index.unique === 1)
    .map((index) =>
      (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
}

function validateBranchRepoIndexAndForeignKey(db: Database): void {
  const repoIndex = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_branches_repo'")
    .get() as { sql: string | null } | null;
  if (!repoIndex?.sql || normalizeSql(repoIndex.sql) !== normalizeSql("CREATE INDEX idx_branches_repo ON branches(repo_id)")) {
    throw new Error("branch identity schema is missing its repo index");
  }
  const branchForeignKeys = db.query("PRAGMA foreign_key_list(branches)").all() as Array<{
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  if (branchForeignKeys.length !== 1
    || branchForeignKeys[0]?.table !== "repos"
    || branchForeignKeys[0]?.from !== "repo_id"
    || branchForeignKeys[0]?.to !== "id"
    || branchForeignKeys[0]?.on_update.toUpperCase() !== "NO ACTION"
    || branchForeignKeys[0]?.on_delete.toUpperCase() !== "CASCADE") {
    throw new Error("branch identity schema has an invalid repo foreign key");
  }
}

function reconcileBranchIdentitySchema(db: Database): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branches'").get()) return;
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branches_v10'").get()) {
    throw new Error("branch identity reconciliation found an unexpected temporary table");
  }
  if (stableMigrationState(readTableColumnContract(db, "branches"))
    !== stableMigrationState(BRANCH_COLUMN_CONTRACT)) {
    throw new Error("branch identity schema has an invalid column contract");
  }
  validateBranchRepoIndexAndForeignKey(db);
  const uniqueColumnSets = readUniqueIndexColumnSets(db, "branches");
  if (uniqueColumnSets.length === 1
    && JSON.stringify(uniqueColumnSets[0]) === JSON.stringify(["repo_id", "name", "is_remote"])) {
    return;
  }
  if (uniqueColumnSets.length !== 1
    || JSON.stringify(uniqueColumnSets[0]) !== JSON.stringify(["repo_id", "name"])) {
    throw new Error("branch identity schema has unsupported uniqueness");
  }
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
}

const BRANCH_ADJUDICATION_AUDIT_SQL = `
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
`;

function validateBranchControlSchema(db: Database): void {
  if (stableMigrationState(readTableColumnContract(db, "branches"))
    !== stableMigrationState(BRANCH_COLUMN_CONTRACT)) {
    throw new Error("branch identity schema has an invalid column contract");
  }

  const branchIndexes = db.query("PRAGMA index_list(branches)").all() as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  const uniqueColumnSets = readUniqueIndexColumnSets(db, "branches");
  if (uniqueColumnSets.length !== 1
    || JSON.stringify(uniqueColumnSets[0]) !== JSON.stringify(["repo_id", "name", "is_remote"])) {
    throw new Error("branch identity schema is missing remote classification uniqueness");
  }
  const unexpectedBranchIndexes = branchIndexes
    .filter((index) => index.origin !== "u" && index.name !== "idx_branches_repo")
    .map((index) => index.name);
  if (unexpectedBranchIndexes.length > 0) {
    throw new Error(`branch identity schema has unexpected indexes: ${unexpectedBranchIndexes.join(", ")}`);
  }
  validateBranchRepoIndexAndForeignKey(db);

  if (stableMigrationState(readTableColumnContract(db, "branch_adjudication_audit"))
    !== stableMigrationState(BRANCH_AUDIT_COLUMN_CONTRACT)) {
    throw new Error("branch adjudication audit schema has an invalid column contract");
  }
  const auditIndexes = db.query("PRAGMA index_list(branch_adjudication_audit)").all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  const auditUniqueColumnSets = auditIndexes
    .filter((index) => index.unique === 1)
    .map((index) =>
      (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
  if (auditUniqueColumnSets.length !== 2
    || !auditUniqueColumnSets.some((columns) => JSON.stringify(columns) === JSON.stringify(["id"]))
    || !auditUniqueColumnSets.some((columns) => JSON.stringify(columns) === JSON.stringify(["idempotency_key"]))) {
    throw new Error("branch adjudication audit schema has invalid uniqueness");
  }
  const unexpectedAuditIndexes = auditIndexes
    .filter((index) => index.origin !== "pk"
      && index.origin !== "u"
      && index.name !== "idx_branch_adjudication_audit_created")
    .map((index) => index.name);
  if (unexpectedAuditIndexes.length > 0) {
    throw new Error(`branch adjudication audit schema has unexpected indexes: ${unexpectedAuditIndexes.join(", ")}`);
  }
  const auditIndex = db.query(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_branch_adjudication_audit_created'`)
    .get() as { sql: string | null } | null;
  if (!auditIndex?.sql
    || normalizeSql(auditIndex.sql) !== normalizeSql(
      "CREATE INDEX idx_branch_adjudication_audit_created ON branch_adjudication_audit(created_at)",
    )) {
    throw new Error("branch adjudication audit schema is missing its created index");
  }
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("integrated schema reconciliation failed foreign-key verification");
  }
}

interface IntegratedControlState {
  remote: V9RemoteIdentityTargetState;
  repos: Array<Record<string, unknown>>;
  remotes: Array<Record<string, unknown>>;
  branches: Array<Record<string, unknown>>;
  branchAudits: Array<Record<string, unknown>>;
  worktreeLeases: Array<Record<string, unknown>>;
}

function readIntegratedControlState(
  db: Database,
  remote: V9RemoteIdentityTargetState = readV9RemoteIdentityState(db),
): IntegratedControlState {
  return {
    remote,
    // V9 verifies the complete set of remote-bearing values, while the
    // integrated successor must additionally prove that a marker-time trigger
    // did not alter any non-remote field on those same registry rows.
    repos: (db.query("SELECT * FROM repos").all() as Array<Record<string, unknown>>)
      .sort((left, right) => Number(left["id"]) - Number(right["id"])),
    remotes: (db.query("SELECT * FROM remotes").all() as Array<Record<string, unknown>>)
      .sort((left, right) => Number(left["id"]) - Number(right["id"])),
    branches: (db.query("SELECT * FROM branches").all() as Array<Record<string, unknown>>)
      .sort((left, right) => Number(left["id"]) - Number(right["id"])),
    branchAudits: (db.query("SELECT * FROM branch_adjudication_audit").all() as Array<Record<string, unknown>>)
      .sort((left, right) => String(left["id"]).localeCompare(String(right["id"]))),
    worktreeLeases: (db.query("SELECT * FROM worktree_leases").all() as Array<Record<string, unknown>>)
      .sort((left, right) => String(left["lease_id"]).localeCompare(String(right["lease_id"]))),
  };
}

function reconcileIntegratedControlSchema(db: Database): IntegratedControlState {
  migrateWorktreeLeaseSchema(db);
  const remote = reconcileRemoteIdentityState(db);
  reconcileBranchIdentitySchema(db);
  db.exec(BRANCH_ADJUDICATION_AUDIT_SQL);
  validateBranchControlSchema(db);
  validateWorktreeLeaseSchema(db);
  return readIntegratedControlState(db, remote);
}

function verifyIntegratedControlSchema(db: Database, expected: unknown): void {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("integrated schema reconciliation is missing exact target state");
  }
  const target = expected as IntegratedControlState;
  verifyV9RemoteIdentityState(db, target.remote);
  const actual = readIntegratedControlState(db);
  if (stableMigrationState(actual) !== stableMigrationState(target)) {
    throw new Error("integrated schema reconciliation failed exact-state verification");
  }
  validateBranchControlSchema(db);
  validateWorktreeLeaseSchema(db);
}

type MigrationMarkerRow = Record<string, unknown>;

function readMigrationMarkerRows(db: Database): MigrationMarkerRow[] {
  return db.query("SELECT * FROM migrations").all() as MigrationMarkerRow[];
}

function verifyMigrationMarkerIntegrity(
  db: Database,
  previous: MigrationMarkerRow[],
  inserted: MigrationMarkerRow,
): void {
  const expected = [...previous, inserted].map(stableMigrationState).sort();
  const actual = readMigrationMarkerRows(db).map(stableMigrationState).sort();
  if (stableMigrationState(actual) !== stableMigrationState(expected)) {
    throw new Error("migration marker integrity verification failed");
  }
}

function verifyFtsReposIntegrity(db: Database): void {
  const table = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fts_repos'",
  ).get();
  if (!table) return;
  try {
    // rank=1 extends FTS5's structural integrity check to prove that the
    // external-content index exactly matches every current repos row.
    db.exec("INSERT INTO fts_repos(fts_repos, rank) VALUES ('integrity-check', 1)");
  } catch {
    throw new Error("migration fts_repos integrity verification failed");
  }
}

function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index]!;
    if (index > 0 && migration.version <= MIGRATIONS[index - 1]!.version) {
      throw new Error("Repos migrations must use strictly increasing unique versions");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have completed this migration while this process
      // waited for the write lock, so the marker must be read under that lock.
      const applied = db.query("SELECT 1 FROM migrations WHERE version = ?").get(migration.version);
      if (!applied) {
        const previousMarkers = readMigrationMarkerRows(db);
        if (migration.sql) db.exec(migration.sql);
        const runResult = migration.run?.(db);
        // RETURNING captures SQLite's exact inserted row before any AFTER
        // trigger can rewrite it. The generic ledger check then proves every
        // preexisting marker and this precise new marker survived unchanged.
        const insertedMarker = db.query(
          "INSERT INTO migrations (version) VALUES (?) RETURNING *",
        ).get(migration.version) as MigrationMarkerRow | null;
        if (!insertedMarker) {
          throw new Error("migration marker integrity verification failed");
        }
        verifyMigrationMarkerIntegrity(db, previousMarkers, insertedMarker);
        verifyFtsReposIntegrity(db);
        migration.verifyAfterMarker?.(db, runResult);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
      throw error;
    }
  }
  validateWorktreeLeaseSchema(db);
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

      INSERT INTO fts_repos(fts_repos) VALUES ('rebuild');

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
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS worktree_leases (
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
        repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
        repo_path TEXT,
        worktree_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_worktree_leases_repo_branch ON worktree_leases(canonical_repo, branch);
      CREATE INDEX IF NOT EXISTS idx_worktree_leases_task ON worktree_leases(task_id);
      CREATE INDEX IF NOT EXISTS idx_worktree_leases_status_expiry ON worktree_leases(status, expires_at_ms);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_leases_active_path
        ON worktree_leases(canonical_path)
        WHERE status IN ('preparing', 'active');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_leases_active_repo_branch
        ON worktree_leases(canonical_repo, branch)
        WHERE status IN ('preparing', 'active');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_leases_idempotency
        ON worktree_leases(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
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
    run: reconcileRemoteIdentityState,
    verifyAfterMarker: verifyV9RemoteIdentityState,
  },
  {
    version: 10,
    run: reconcileBranchIdentitySchema,
  },
  {
    version: 11,
    sql: BRANCH_ADJUDICATION_AUDIT_SQL,
  },
  {
    // Versions 9-20 were used by an unpublished worktree-control candidate,
    // while main independently assigned 9-11 to remote identity and branch
    // control. Never reuse those ambiguous markers. Version 21 reasserts the
    // complete schema truth for databases from either lineage.
    version: 21,
    run: reconcileIntegratedControlSchema,
    verifyAfterMarker: verifyIntegratedControlSchema,
  },
];

interface LegacyCollisionCandidate {
  lease_id: string;
  canonical_path: string;
  canonical_repo: string;
  branch: string;
  created_at_ms: number;
  claimed_at_ms: number;
}

function compareLegacyCollisionLineage(
  left: LegacyCollisionCandidate,
  right: LegacyCollisionCandidate,
): number {
  if (left.claimed_at_ms !== right.claimed_at_ms) {
    return left.claimed_at_ms < right.claimed_at_ms ? -1 : 1;
  }
  if (left.created_at_ms !== right.created_at_ms) {
    return left.created_at_ms < right.created_at_ms ? -1 : 1;
  }
  return left.lease_id < right.lease_id ? -1 : left.lease_id > right.lease_id ? 1 : 0;
}

function reconcileLegacyWorktreeCollisions(db: Database): void {
  const candidates = (db.query(`SELECT
      lease_id,
      canonical_path,
      canonical_repo,
      branch,
      created_at_ms,
      COALESCE(
        CAST(json_extract(metadata_json, '$.legacy_import.claimed_at_ms') AS INTEGER),
        created_at_ms
      ) AS claimed_at_ms
    FROM worktree_leases
    WHERE json_extract(metadata_json, '$.legacy_layout') = 1
      AND status IN ('worktree_failed', 'quarantine_failed')`).all() as LegacyCollisionCandidate[])
    .sort(compareLegacyCollisionLineage);
  const pathKeepers = new Map<string, LegacyCollisionCandidate>();
  const branchKeepers = new Map<string, LegacyCollisionCandidate>();
  const demote = db.query(`UPDATE worktree_leases
    SET status = 'failed',
        metadata_json = json_set(
          metadata_json,
          '$.legacy_collision_demoted', json('true'),
          '$.legacy_collision', json(?)
        )
    WHERE lease_id = ?
      AND status IN ('worktree_failed', 'quarantine_failed')`);

  for (const current of candidates) {
    const branchKey = stableMigrationState([current.canonical_repo, current.branch]);
    const pathKeeper = pathKeepers.get(current.canonical_path);
    const branchKeeper = branchKeepers.get(branchKey);
    const keepers = [pathKeeper, branchKeeper]
      .filter((keeper): keeper is LegacyCollisionCandidate => keeper !== undefined)
      .filter((keeper, index, all) =>
        all.findIndex((candidate) => candidate.lease_id === keeper.lease_id) === index)
      .sort(compareLegacyCollisionLineage);
    const keeper = keepers[0];
    if (!keeper) {
      pathKeepers.set(current.canonical_path, current);
      branchKeepers.set(branchKey, current);
      continue;
    }

    const collisionKey = keeper.canonical_path === current.canonical_path
      ? {
          kind: "canonical_path",
          canonical_path: current.canonical_path,
        }
      : {
          kind: "canonical_repo_branch",
          canonical_repo: current.canonical_repo,
          branch: current.branch,
        };
    const receipt = {
      keeper_lease_id: keeper.lease_id,
      collision_key: collisionKey,
      lineage_order: ["claimed_at_ms", "created_at_ms", "lease_id"],
      keeper_lineage: {
        lease_id: keeper.lease_id,
        claimed_at_ms: keeper.claimed_at_ms,
        created_at_ms: keeper.created_at_ms,
      },
      demoted_lineage: {
        lease_id: current.lease_id,
        claimed_at_ms: current.claimed_at_ms,
        created_at_ms: current.created_at_ms,
      },
    };
    const result = demote.run(JSON.stringify(receipt), current.lease_id);
    if (result.changes !== 1) {
      throw new Error(`legacy worktree collision demotion failed: ${current.lease_id}`);
    }
  }
}

function migrateWorktreeLeaseSchema(db: Database): void {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktree_leases'").get();
  if (!table) throw new Error("worktree_leases is missing before worktree schema reconciliation");
  const columns = new Set((db.query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>).map((column) => column.name));

  for (const index of [
    "idx_worktree_leases_repo_branch",
    "idx_worktree_leases_task",
    "idx_worktree_leases_status_expiry",
    "idx_worktree_leases_active_path",
    "idx_worktree_leases_active_repo_branch",
    "idx_worktree_leases_idempotency",
  ]) db.query(`DROP INDEX IF EXISTS ${index}`).run();

  if (!columns.has("canonical_repo")) {
    const legacyColumns = [
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
      "owner_metadata",
      "mode",
      "cleanup_policy",
      "status",
      "git_common_dir",
      "created_at",
      "updated_at",
      "claimed_at",
      "verified_at",
      "released_at",
      "last_error",
    ];
    const allowedLegacyColumns = new Set(legacyColumns);
    const missing = legacyColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) throw new Error(`unsupported worktree_leases schema; missing ${missing.join(", ")}`);
    const unexpected = [...columns].filter((column) => !allowedLegacyColumns.has(column));
    if (unexpected.length > 0) {
      throw new Error(`unsupported worktree_leases schema; unexpected columns ${unexpected.join(", ")}`);
    }
    const legacyTimes = db.query(`SELECT
        lease_id, created_at, updated_at, claimed_at, verified_at, released_at
      FROM worktree_leases ORDER BY lease_id`).all() as Array<{
        lease_id: string;
        created_at: string;
        updated_at: string;
        claimed_at: string;
        verified_at: string | null;
        released_at: string | null;
      }>;
    for (const row of legacyTimes) {
      for (const field of ["created_at", "updated_at", "claimed_at", "verified_at", "released_at"] as const) {
        const value = row[field];
        if (value !== null && strictLegacyTimestampMs(value) === null) {
          throw new Error(`invalid legacy worktree lease timestamp: ${row.lease_id}.${field}`);
        }
      }
    }
    const sqliteInvalidTimestamp = db.query(`SELECT lease_id FROM worktree_leases
      WHERE unixepoch(created_at, 'subsec') IS NULL
         OR unixepoch(updated_at, 'subsec') IS NULL
         OR unixepoch(claimed_at, 'subsec') IS NULL
         OR (verified_at IS NOT NULL AND unixepoch(verified_at, 'subsec') IS NULL)
         OR (released_at IS NOT NULL AND unixepoch(released_at, 'subsec') IS NULL)
      ORDER BY lease_id LIMIT 1`).get() as { lease_id: string } | null;
    if (sqliteInvalidTimestamp) {
      throw new Error(`invalid legacy worktree lease timestamp: ${sqliteInvalidTimestamp.lease_id}.sqlite`);
    }
    const legacyIds = (db.query("SELECT lease_id FROM worktree_leases ORDER BY lease_id").all() as Array<{ lease_id: string }>).map((row) => row.lease_id);
    db.query("ALTER TABLE worktree_leases RENAME TO worktree_leases_legacy_v5").run();
    db.query(worktreeLeaseTableSql()).run();
    db.query(`INSERT INTO worktree_leases (
        lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
        branch, owner, status, generation, fencing_token, idempotency_key,
        source, base_ref, head_sha, expires_at_ms, heartbeat_at_ms,
        created_at_ms, updated_at_ms, released_at_ms, metadata_json,
        repo_catalog_id, repo_path, worktree_path
      ) SELECT
        lease_id,
        lower(CASE
          WHEN repo_id LIKE 'github:%' THEN substr(repo_id, 8)
          WHEN repo_id LIKE 'github.com/%' THEN substr(repo_id, 12)
          ELSE repo_id
        END),
        task_id,
        run_id,
        machine_id,
        worktree_path,
        branch,
        'legacy-import',
        CASE
          WHEN status = 'released' THEN 'released'
          WHEN status = 'quarantined' THEN 'quarantined'
          WHEN status = 'failed' THEN 'failed'
          ELSE 'worktree_failed'
        END,
        1,
        lease_id || ':legacy-v5',
        NULL,
        repo_path,
        base_ref,
        base_sha,
        CAST(ROUND(unixepoch('now', 'subsec') * 1000) AS INTEGER) + 21600000,
        CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER),
        CAST(ROUND(unixepoch(created_at, 'subsec') * 1000) AS INTEGER),
        CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER),
        CASE
          WHEN released_at IS NULL THEN NULL
          ELSE CAST(ROUND(unixepoch(released_at, 'subsec') * 1000) AS INTEGER)
        END,
        json_object(
          'legacy_layout', json('true'),
          'legacy_import', json_object(
            'repo_id', repo_id,
            'status', status,
            'mode', mode,
            'cleanup_policy', cleanup_policy,
            'git_common_dir', git_common_dir,
            'created_at', created_at,
            'created_at_ms', CAST(ROUND(unixepoch(created_at, 'subsec') * 1000) AS INTEGER),
            'updated_at', updated_at,
            'updated_at_ms', CAST(ROUND(unixepoch(updated_at, 'subsec') * 1000) AS INTEGER),
            'claimed_at', claimed_at,
            'claimed_at_ms', CAST(ROUND(unixepoch(claimed_at, 'subsec') * 1000) AS INTEGER),
            'verified_at', verified_at,
            'verified_at_ms', CASE
              WHEN verified_at IS NULL THEN NULL
              ELSE CAST(ROUND(unixepoch(verified_at, 'subsec') * 1000) AS INTEGER)
            END,
            'released_at', released_at,
            'released_at_ms', CASE
              WHEN released_at IS NULL THEN NULL
              ELSE CAST(ROUND(unixepoch(released_at, 'subsec') * 1000) AS INTEGER)
            END,
            'last_error', last_error,
            'owner_metadata_raw', owner_metadata,
            'owner_metadata', CASE
              WHEN json_valid(owner_metadata) THEN json(owner_metadata)
              ELSE owner_metadata
            END
          )
        ),
        repo_catalog_id,
        repo_path,
        worktree_path
      FROM worktree_leases_legacy_v5`).run();
    const migratedIds = (db.query("SELECT lease_id FROM worktree_leases ORDER BY lease_id").all() as Array<{ lease_id: string }>).map((row) => row.lease_id);
    if (JSON.stringify(migratedIds) !== JSON.stringify(legacyIds)) {
      throw new Error("worktree lease migration did not preserve the exact lease key set");
    }
    db.query("DROP TABLE worktree_leases_legacy_v5").run();
  } else {
    if (!columns.has("repo_catalog_id")) {
      db.query("ALTER TABLE worktree_leases ADD COLUMN repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL").run();
    }
    if (!columns.has("repo_path")) db.query("ALTER TABLE worktree_leases ADD COLUMN repo_path TEXT").run();
    if (!columns.has("worktree_path")) db.query("ALTER TABLE worktree_leases ADD COLUMN worktree_path TEXT").run();
    db.query(`UPDATE worktree_leases
      SET repo_path = COALESCE(repo_path, source),
          worktree_path = COALESCE(worktree_path, canonical_path)`).run();
  }

  db.query(`UPDATE worktree_leases
    SET metadata_json = json_set(
      metadata_json,
      '$.release_finalized', json('true'),
      '$.release_verified_head_sha', head_sha,
      '$.release_finalized_at_ms', updated_at_ms
    )
    WHERE json_extract(metadata_json, '$.legacy_layout') = 1
      AND status = 'released'
      AND COALESCE(json_type(metadata_json, '$.release_finalized'), '') != 'true'`).run();
  db.query(`UPDATE worktree_leases
    SET status = 'quarantine_failed'
    WHERE json_extract(metadata_json, '$.legacy_layout') = 1
      AND status = 'quarantined'`).run();
  reconcileLegacyWorktreeCollisions(db);

  validateWorktreeLeaseSchema(db, false);
  const indexStatements = worktreeLeaseIndexStatements();
  for (const statement of Object.values(indexStatements)) db.query(statement).run();
  validateWorktreeLeaseSchema(db);
}

function worktreeLeaseTableSql(): string {
  return `CREATE TABLE worktree_leases (
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
    repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
    repo_path TEXT,
    worktree_path TEXT
  )`;
}

function gitObjectIdSql(value: string): string {
  return `(length(${value}) IN (40, 64)
    AND ${value} NOT GLOB '*[^0-9a-f]*')`;
}

function releaseTerminalProofSql(): string {
  const verifiedHead = "json_extract(metadata_json, '$.release_verified_head_sha')";
  return `(COALESCE(json_type(metadata_json, '$.release_finalized'), '') = 'true'
    AND COALESCE(json_type(metadata_json, '$.release_verified_head_sha'), '') = 'text'
    AND ${gitObjectIdSql(verifiedHead)}
    AND ${verifiedHead} = head_sha
    AND COALESCE(json_type(metadata_json, '$.release_finalized_at_ms'), '') = 'integer'
    AND json_extract(metadata_json, '$.release_finalized_at_ms') >= 0)`;
}

function quarantineTerminalProofSql(): string {
  const verifiedHead = "json_extract(metadata_json, '$.verified_head_sha')";
  return `(COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') = 'true'
    AND COALESCE(json_type(metadata_json, '$.verified_head_sha'), '') = 'text'
    AND ${gitObjectIdSql(verifiedHead)}
    AND ${verifiedHead} = head_sha
    AND json_extract(metadata_json, '$.quarantine_path') = canonical_path
    AND json_extract(metadata_json, '$.backup_ref') = 'refs/hasna/worktrees/' || lease_id || '/' || generation
    AND COALESCE(json_type(metadata_json, '$.quarantine_finalized_at_ms'), '') = 'integer'
    AND json_extract(metadata_json, '$.quarantine_finalized_at_ms') >= 0)`;
}

function worktreeOwnershipPredicateSql(): string {
  return `(status NOT IN ('released', 'failed', 'quarantined')
    OR (status = 'released' AND NOT ${releaseTerminalProofSql()})
    OR (status = 'quarantined' AND NOT ${quarantineTerminalProofSql()}))`;
}

function worktreeLeaseIndexStatements(): Record<string, string> {
  const ownershipPredicate = worktreeOwnershipPredicateSql();
  return {
    idx_worktree_leases_repo_branch: "CREATE INDEX idx_worktree_leases_repo_branch ON worktree_leases(canonical_repo, branch)",
    idx_worktree_leases_task: "CREATE INDEX idx_worktree_leases_task ON worktree_leases(task_id)",
    idx_worktree_leases_status_expiry: "CREATE INDEX idx_worktree_leases_status_expiry ON worktree_leases(status, expires_at_ms)",
    idx_worktree_leases_active_path: `CREATE UNIQUE INDEX idx_worktree_leases_active_path ON worktree_leases(canonical_path)
      WHERE ${ownershipPredicate}`,
    idx_worktree_leases_active_repo_branch: `CREATE UNIQUE INDEX idx_worktree_leases_active_repo_branch ON worktree_leases(canonical_repo, branch)
      WHERE ${ownershipPredicate}`,
    idx_worktree_leases_idempotency: `CREATE UNIQUE INDEX idx_worktree_leases_idempotency ON worktree_leases(idempotency_key)
      WHERE idempotency_key IS NOT NULL`,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function validateWorktreeLeaseSchema(db: Database, requireIndexes = true): void {
  const table = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'worktree_leases'")
    .get() as { name: string; sql: string | null } | null;
  if (!table) throw new Error("worktree_leases is missing after migrations");
  if (typeof table.sql !== "string" || normalizeSql(table.sql) !== normalizeSql(worktreeLeaseTableSql())) {
    throw new Error("worktree lease canonical table SQL is missing or invalid");
  }

  const ownershipPredicate = worktreeOwnershipPredicateSql();
  const duplicatePath = db.query(`SELECT canonical_path FROM worktree_leases
    WHERE ${ownershipPredicate}
    GROUP BY canonical_path HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicatePath) throw new Error("duplicate active worktree path blocks worktree lease reconciliation");
  const duplicateBranch = db.query(`SELECT canonical_repo, branch FROM worktree_leases
    WHERE ${ownershipPredicate}
    GROUP BY canonical_repo, branch HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicateBranch) throw new Error("duplicate active repo/branch blocks worktree lease reconciliation");
  const duplicateIdempotency = db.query(`SELECT idempotency_key FROM worktree_leases
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicateIdempotency) throw new Error("duplicate worktree idempotency key blocks worktree lease reconciliation");
  const invalidTerminalProof = db.query(`SELECT lease_id FROM worktree_leases
    WHERE (
      status = 'released'
      AND json_type(metadata_json, '$.release_finalized') IS NOT NULL
      AND json_type(metadata_json, '$.release_finalized') NOT IN ('true', 'false')
    ) OR (
      status = 'quarantined'
      AND json_type(metadata_json, '$.quarantine_finalized') IS NOT NULL
      AND json_type(metadata_json, '$.quarantine_finalized') NOT IN ('true', 'false')
    ) OR (
      status = 'released'
      AND COALESCE(json_type(metadata_json, '$.release_finalized'), '') = 'true'
      AND NOT ${releaseTerminalProofSql()}
    ) OR (
      status = 'quarantined'
      AND COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') = 'true'
      AND NOT ${quarantineTerminalProofSql()}
    ) LIMIT 1`).get();
  if (invalidTerminalProof) throw new Error("worktree lease terminal proof payload is missing or invalid");
  const canonicalColumns = db.query("PRAGMA table_info(worktree_leases)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const canonicalColumnNames = new Set([
    "lease_id",
    "canonical_repo",
    "task_id",
    "run_id",
    "machine_id",
    "canonical_path",
    "branch",
    "owner",
    "status",
    "generation",
    "fencing_token",
    "idempotency_key",
    "source",
    "base_ref",
    "head_sha",
    "expires_at_ms",
    "heartbeat_at_ms",
    "created_at_ms",
    "updated_at_ms",
    "released_at_ms",
    "metadata_json",
    "repo_catalog_id",
    "repo_path",
    "worktree_path",
  ]);
  const unexpectedColumns = canonicalColumns
    .map((column) => column.name)
    .filter((name) => !canonicalColumnNames.has(name));
  if (unexpectedColumns.length > 0) {
    throw new Error(`worktree lease canonical schema has unexpected columns: ${unexpectedColumns.join(", ")}`);
  }
  const leaseIdColumn = canonicalColumns.find((column) => column.name === "lease_id");
  const primaryKeyColumns = canonicalColumns.filter((column) => column.pk > 0);
  if (!leaseIdColumn
    || leaseIdColumn.pk !== 1
    || leaseIdColumn.notnull !== 1
    || leaseIdColumn.type.toUpperCase() !== "TEXT"
    || leaseIdColumn.dflt_value !== null
    || primaryKeyColumns.length !== 1) {
    throw new Error("worktree lease canonical schema requires lease_id primary key");
  }
  const repoCatalogColumn = canonicalColumns.find((column) => column.name === "repo_catalog_id");
  if (!repoCatalogColumn
    || repoCatalogColumn.type.toUpperCase() !== "INTEGER"
    || repoCatalogColumn.notnull !== 0
    || repoCatalogColumn.dflt_value !== null) {
    throw new Error("worktree lease repo_catalog_id foreign key must allow SET NULL");
  }
  const canonicalColumnContract: Record<string, {
    type: "TEXT" | "INTEGER";
    notnull: 0 | 1;
    defaultValue: string | null;
  }> = {
    canonical_repo: { type: "TEXT", notnull: 1, defaultValue: null },
    task_id: { type: "TEXT", notnull: 1, defaultValue: null },
    run_id: { type: "TEXT", notnull: 1, defaultValue: null },
    machine_id: { type: "TEXT", notnull: 1, defaultValue: null },
    canonical_path: { type: "TEXT", notnull: 1, defaultValue: null },
    branch: { type: "TEXT", notnull: 1, defaultValue: null },
    owner: { type: "TEXT", notnull: 1, defaultValue: null },
    status: { type: "TEXT", notnull: 1, defaultValue: null },
    generation: { type: "INTEGER", notnull: 1, defaultValue: "1" },
    fencing_token: { type: "TEXT", notnull: 1, defaultValue: null },
    idempotency_key: { type: "TEXT", notnull: 0, defaultValue: null },
    source: { type: "TEXT", notnull: 0, defaultValue: null },
    base_ref: { type: "TEXT", notnull: 0, defaultValue: null },
    head_sha: { type: "TEXT", notnull: 0, defaultValue: null },
    expires_at_ms: { type: "INTEGER", notnull: 1, defaultValue: null },
    heartbeat_at_ms: { type: "INTEGER", notnull: 1, defaultValue: null },
    created_at_ms: { type: "INTEGER", notnull: 1, defaultValue: null },
    updated_at_ms: { type: "INTEGER", notnull: 1, defaultValue: null },
    released_at_ms: { type: "INTEGER", notnull: 0, defaultValue: null },
    metadata_json: { type: "TEXT", notnull: 1, defaultValue: "'{}'" },
    repo_path: { type: "TEXT", notnull: 0, defaultValue: null },
    worktree_path: { type: "TEXT", notnull: 0, defaultValue: null },
  };
  for (const [name, expected] of Object.entries(canonicalColumnContract)) {
    const column = canonicalColumns.find((candidate) => candidate.name === name);
    if (!column
      || column.type.toUpperCase() !== expected.type
      || column.notnull !== expected.notnull) {
      throw new Error(`worktree lease canonical schema column is missing or invalid: ${name}`);
    }
    if (column.dflt_value !== expected.defaultValue) {
      throw new Error(`worktree lease canonical schema column has invalid default: ${name}`);
    }
  }

  if (requireIndexes) {
    const indexStatements = worktreeLeaseIndexStatements();
    const indexList = db.query("PRAGMA index_list(worktree_leases)").all() as Array<{
      name: string;
      origin: string;
    }>;
    const expectedIndexNames = new Set(Object.keys(indexStatements));
    const unexpectedIndexes = indexList
      .filter((index) => !expectedIndexNames.has(index.name) && index.origin !== "pk")
      .map((index) => index.name);
    const primaryKeyIndexes = indexList.filter((index) => index.origin === "pk");
    const primaryKeyIndexColumns = primaryKeyIndexes.length === 1
      ? (db.query(`PRAGMA index_info(${JSON.stringify(primaryKeyIndexes[0]!.name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
      : [];
    if (unexpectedIndexes.length > 0) {
      throw new Error(`worktree lease schema has unexpected indexes: ${unexpectedIndexes.join(", ")}`);
    }
    if (primaryKeyIndexes.length !== 1 || JSON.stringify(primaryKeyIndexColumns) !== JSON.stringify(["lease_id"])) {
      throw new Error("worktree lease schema has an invalid primary-key index");
    }
    const installedIndexes = new Map(
      (db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'worktree_leases'").all() as Array<{
        name: string;
        sql: string | null;
      }>).map((row) => [row.name, row.sql]),
    );
    const invalidIndexes = Object.entries(indexStatements)
      .filter(([name, statement]) => {
        const installed = installedIndexes.get(name);
        return typeof installed !== "string" || normalizeSql(installed) !== normalizeSql(statement);
      })
      .map(([name]) => name);
    if (invalidIndexes.length > 0) {
      throw new Error(`worktree lease schema is missing or has invalid indexes: ${invalidIndexes.join(", ")}`);
    }
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(worktree_leases)").all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const repoCatalogForeignKeys = foreignKeys.filter((foreignKey) => foreignKey.from === "repo_catalog_id");
  const repoCatalogForeignKey = repoCatalogForeignKeys[0];
  const repoCatalogForeignKeyRows = repoCatalogForeignKey
    ? foreignKeys.filter((foreignKey) => foreignKey.id === repoCatalogForeignKey.id)
    : [];
  if (foreignKeys.length !== 1
    || repoCatalogForeignKeys.length !== 1
    || repoCatalogForeignKeyRows.length !== 1
    || repoCatalogForeignKey?.seq !== 0
    || repoCatalogForeignKey.table !== "repos"
    || repoCatalogForeignKey.to !== "id"
    || repoCatalogForeignKey.on_update.toUpperCase() !== "NO ACTION"
    || repoCatalogForeignKey.on_delete.toUpperCase() !== "SET NULL") {
    throw new Error("worktree lease repo_catalog_id foreign key is missing or invalid");
  }
  const foreignKeyViolations = db.query("PRAGMA foreign_key_check(worktree_leases)").all();
  if (foreignKeyViolations.length > 0) {
    throw new Error("worktree lease repo_catalog_id foreign key is violated");
  }
}

function strictLegacyTimestampMs(value: string): number | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?)?$/,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) return null;
  const timezone = match[8];
  if (timezone && timezone !== "Z") {
    const [offsetHour, offsetMinute] = timezone.slice(1).split(":").map(Number);
    if (offsetHour! > 14 || offsetMinute! > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const normalized = match[4] ? `${value}${timezone ? "" : "Z"}` : `${value}T00:00:00Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
