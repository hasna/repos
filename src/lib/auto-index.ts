import { existsSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { Client } from "pg";
import { getDb, getDbPath } from "../db/database.js";
import { applyPostgresMigrations } from "../db/pg-migrations.js";
import type { ScanResult } from "../types/index.js";
import { getConfig, getHookQueuePath, getWorkspaceRoots } from "./config.js";
import { getSourceMachineId } from "./machine-id.js";
import { describeDanglingCheckouts, drainHookQueue, installPostCommitHooks } from "./repo-hooks.js";
import { discoverRepos, scanRepoPaths } from "./scanner.js";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

const WORKSPACE_BOOTSTRAP_STATE_KEY = "workspace_bootstrap";

export interface RemoteSyncSummary {
  direction: "pull" | "push";
  enabled: boolean;
  rowsSynced: number;
  errors: string[];
  skippedReason?: string;
  teardownStatus?: "failed";
}

export interface WorkspaceBootstrapResult {
  bootstrapped: boolean;
  roots: string[];
  hooks: ReturnType<typeof installPostCommitHooks>;
  scan?: ScanResult;
  remotePull?: RemoteSyncSummary;
  remotePush?: RemoteSyncSummary;
}

export interface AutoIndexWorker {
  roots: string[];
  stop: () => void;
}

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export interface ReposRemoteSyncClient {
  connect?: () => Promise<unknown> | unknown;
  query: (sql: string, params?: unknown[]) => Promise<QueryResultLike>;
  end?: () => Promise<void> | void;
}

export interface SyncRepoCatalogOptions {
  databaseSchema?: string | null;
  databaseUrl?: string | null;
  remoteClient?: ReposRemoteSyncClient;
  remoteClientFactory?: (databaseUrl: string) => ReposRemoteSyncClient;
  storageMode?: "local" | "remote" | "hybrid";
}

export interface RemoteIdentityCleanupOptions {
  actor: string;
  apply?: boolean;
  databaseSchema?: string | null;
  databaseUrl?: string | null;
  expectedPlanHash?: string;
  idempotencyKey: string;
  remoteClient?: ReposRemoteSyncClient;
  version?: 1;
}

export interface RemoteIdentityCleanupCounts {
  repos_scanned: number;
  repos_update: number;
  remotes_scanned: number;
  remotes_update: number;
  remotes_delete: number;
  search_vectors_repaired: number;
}

export interface RemoteIdentityCleanupSummary {
  schema: "open-repos.remote-identity-cleanup.v1";
  version: 1;
  applied: boolean;
  replayed: boolean;
  idempotency_key: string;
  plan_hash: string;
  counts: RemoteIdentityCleanupCounts;
}

type SyncTableName = "repos" | "automation_state";
type SQLiteBinding = string | number | bigint | boolean | Uint8Array | null;

interface SyncTableSpec {
  table: SyncTableName;
  idColumn: string;
  columns: string[];
  remoteMode: "direct" | "record";
}

const SYNC_RECORD_TABLE = "repos_sync_records";
const SYNC_TABLES: SyncTableSpec[] = [
  {
    table: "repos",
    idColumn: "path",
    remoteMode: "direct",
    columns: [
      "path",
      "name",
      "org",
      "remote_url",
      "default_branch",
      "description",
      "last_scanned",
      "commit_count",
      "branch_count",
      "tag_count",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "automation_state",
    idColumn: "key",
    remoteMode: "record",
    columns: ["key", "value", "updated_at"],
  },
];

function emptyHookSummary(): ReturnType<typeof installPostCommitHooks> {
  return {
    installed: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    results: [],
  };
}

function appendDanglingWarning(
  message: string,
  hooks: ReturnType<typeof installPostCommitHooks>,
): string {
  const dangling = describeDanglingCheckouts(hooks);
  return dangling ? `${message}; [warn] ${dangling}` : message;
}

function getAutomationState<T>(key: string): { value: T; updatedAt: string } | null {
  const db = getDb();
  const row = db.query("SELECT value, updated_at FROM automation_state WHERE key = ?").get(key) as {
    value: string;
    updated_at: string;
  } | null;

  if (!row) return null;

  try {
    return {
      value: JSON.parse(row.value) as T,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function setAutomationState(key: string, value: unknown): void {
  const db = getDb();
  db.query(`
    INSERT INTO automation_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

function getRepoCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM repos").get() as { count: number };
  return row.count;
}

function getReposStorageMode(): "local" | "remote" | "hybrid" {
  const raw = (process.env["HASNA_REPOS_STORAGE_MODE"] || process.env["REPOS_STORAGE_MODE"] || "local").toLowerCase();
  if (raw === "remote" || raw === "hybrid") return raw;
  if (process.env["HASNA_REPOS_DATABASE_URL"] || process.env["REPOS_DATABASE_URL"]) return "hybrid";
  return "local";
}

function getReposDatabaseUrl(options: SyncRepoCatalogOptions): string | null {
  return options.databaseUrl ?? process.env["HASNA_REPOS_DATABASE_URL"] ?? process.env["REPOS_DATABASE_URL"] ?? null;
}

function getReposDatabaseSchema(options: SyncRepoCatalogOptions): string | null {
  return options.databaseSchema ?? process.env["HASNA_REPOS_DATABASE_SCHEMA"] ?? process.env["REPOS_DATABASE_SCHEMA"] ?? null;
}

function getEnvFlag(primary: string, fallback: string, defaultValue: boolean): boolean {
  const raw = process.env[primary] ?? process.env[fallback];
  if (raw === undefined || raw === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function createRemoteSyncClient(databaseUrl: string): ReposRemoteSyncClient {
  const sslEnabled = getEnvFlag("HASNA_REPOS_DATABASE_SSL", "REPOS_DATABASE_SSL", true);
  return new Client({
    connectionString: databaseUrl,
    ssl: sslEnabled,
  });
}

function quotePgIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error("HASNA_REPOS_DATABASE_SCHEMA must be a simple Postgres identifier");
  }
  return `"${identifier}"`;
}

async function prepareRemoteSearchPath(remote: ReposRemoteSyncClient, schema: string | null): Promise<void> {
  if (!schema) return;
  const quoted = quotePgIdentifier(schema);
  await remote.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
  // All callers open a transaction before schema preparation. Keep schema
  // selection transaction-local so an injected, caller-owned connection is
  // returned with exactly the same session search_path it had on entry.
  await remote.query(`SET LOCAL search_path TO ${quoted}`);
}

function redactErrorMessage(_error: unknown, _databaseUrl: string | null): string {
  return "remote repository catalog synchronization failed";
}

function normalizeTimestamp(value: unknown): string {
  const parsed = Date.parse(String(value ?? ""));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordId(row: Record<string, unknown>, spec: SyncTableSpec): string {
  const value = row[spec.idColumn];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${spec.table} row is missing ${spec.idColumn}`);
  }
  return String(value);
}

function normalizePayload(row: Record<string, unknown>, spec: SyncTableSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const column of spec.columns) {
    payload[column] = row[column] ?? null;
  }
  if (spec.table === "repos" && !payload["default_branch"]) payload["default_branch"] = "main";
  if (spec.table === "repos") payload["remote_url"] = sanitizeRemoteIdentity(payload["remote_url"]);
  return payload;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("remote sync payload must be an object");
}

function toSqliteBinding(value: unknown): SQLiteBinding {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

async function ensureRemoteSyncSchema(remote: ReposRemoteSyncClient): Promise<void> {
  await remote.query(`
    CREATE TABLE IF NOT EXISTS repos (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      org TEXT,
      remote_url TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      description TEXT,
      last_scanned TIMESTAMPTZ,
      commit_count INTEGER NOT NULL DEFAULT 0,
      branch_count INTEGER NOT NULL DEFAULT 0,
      tag_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await remote.query("ALTER TABLE repos ADD COLUMN IF NOT EXISTS source_machine_id TEXT");
  await remote.query("CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name)");
  await remote.query("CREATE INDEX IF NOT EXISTS idx_repos_org ON repos(org)");
  await remote.query(`
    CREATE TABLE IF NOT EXISTS ${SYNC_RECORD_TABLE} (
      table_name text NOT NULL,
      record_id text NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      source_machine_id text,
      PRIMARY KEY (table_name, record_id)
    )
  `);
  await remote.query(`CREATE INDEX IF NOT EXISTS idx_repos_sync_records_updated_at ON ${SYNC_RECORD_TABLE}(updated_at)`);
}

const REMOTE_IDENTITY_CLEANUP_SCHEMA = "open-repos.remote-identity-cleanup.v1" as const;

type RemoteCleanupChange =
  | {
      id: number;
      beforeUrl: unknown;
      beforeFetchUrl: unknown;
      delete: true;
    }
  | {
      id: number;
      beforeUrl: unknown;
      beforeFetchUrl: unknown;
      url: string;
      fetchUrl: string | null;
      delete: false;
    };

interface RemoteCleanupSearchVectorChange {
  id: number;
  before: unknown;
  target: string;
}

class RemoteIdentityCleanupFailure extends Error {}

function cleanupFailure(message: string): RemoteIdentityCleanupFailure {
  return new RemoteIdentityCleanupFailure(message);
}

function cleanupPlanHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanupValueDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ type: typeof value, value: value ?? null }))
    .digest("hex");
}

function cleanupRepoState(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row["id"]),
    name: row["name"] ?? null,
    org: row["org"] ?? null,
    description: row["description"] ?? null,
    remote_url: row["remote_url"] ?? null,
    search_vector: row["search_vector"] ?? null,
  };
}

function cleanupRemoteState(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row["id"]),
    url: row["url"] ?? null,
    fetch_url: row["fetch_url"] ?? null,
  };
}

function exactCleanupState(
  rows: Array<Record<string, unknown>>,
  project: (row: Record<string, unknown>) => Record<string, unknown>,
): Map<number, string> {
  const state = new Map<number, string>();
  for (const row of rows) {
    const projected = project(row);
    const id = Number(projected["id"]);
    if (!Number.isSafeInteger(id) || id < 1 || state.has(id)) {
      throw cleanupFailure("remote identity cleanup verification failed");
    }
    state.set(id, cleanupValueDigest(projected));
  }
  return state;
}

function cleanupStatesEqual(expected: Map<number, string>, actual: Map<number, string>): boolean {
  if (expected.size !== actual.size) return false;
  for (const [id, digest] of expected) {
    if (actual.get(id) !== digest) return false;
  }
  return true;
}

const CLEANUP_COUNT_FIELDS: Array<keyof RemoteIdentityCleanupCounts> = [
  "repos_scanned",
  "repos_update",
  "remotes_scanned",
  "remotes_update",
  "remotes_delete",
  "search_vectors_repaired",
];

function parseCleanupCounts(value: unknown): RemoteIdentityCleanupCounts {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cleanupFailure("remote identity cleanup persisted audit is invalid");
  }
  const counts = parsed as Record<string, unknown>;
  const keys = Object.keys(counts).sort();
  const expectedKeys = [...CLEANUP_COUNT_FIELDS].sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || CLEANUP_COUNT_FIELDS.some((field) => !Number.isSafeInteger(counts[field]) || Number(counts[field]) < 0)
  ) {
    throw cleanupFailure("remote identity cleanup persisted audit is invalid");
  }
  return Object.fromEntries(CLEANUP_COUNT_FIELDS.map((field) => [field, Number(counts[field])])) as unknown as RemoteIdentityCleanupCounts;
}

function cleanupCountsEqual(
  left: RemoteIdentityCleanupCounts,
  right: RemoteIdentityCleanupCounts,
): boolean {
  return CLEANUP_COUNT_FIELDS.every((field) => left[field] === right[field]);
}

function cleanupAuditIntegrityHash(value: {
  idempotencyKey: string;
  version: number;
  mode: "dry_run" | "apply";
  actor: string;
  planHash: string;
  counts: RemoteIdentityCleanupCounts;
}): string {
  return cleanupPlanHash({
    schema: REMOTE_IDENTITY_CLEANUP_SCHEMA,
    idempotency_key: value.idempotencyKey,
    version: value.version,
    mode: value.mode,
    actor: value.actor,
    plan_hash: value.planHash,
    counts: Object.fromEntries(CLEANUP_COUNT_FIELDS.map((field) => [field, value.counts[field]])),
  });
}

function validateCleanupAuditRow(
  row: Record<string, unknown>,
  expected: {
    idempotencyKey: string;
    version: number;
    mode: "dry_run" | "apply";
    actor: string;
    planHash?: string;
    counts?: RemoteIdentityCleanupCounts;
  },
): { planHash: string; counts: RemoteIdentityCleanupCounts } {
  try {
    const planHash = typeof row["plan_hash"] === "string" ? row["plan_hash"] : "";
    const integrityHash = typeof row["integrity_hash"] === "string" ? row["integrity_hash"] : "";
    const counts = parseCleanupCounts(row["counts_json"]);
    const expectedIntegrityHash = cleanupAuditIntegrityHash({
      idempotencyKey: expected.idempotencyKey,
      version: expected.version,
      mode: expected.mode,
      actor: expected.actor,
      planHash,
      counts,
    });
    if (
      row["idempotency_key"] !== expected.idempotencyKey
      || row["version"] !== expected.version
      || row["mode"] !== expected.mode
      || row["actor"] !== expected.actor
      || !/^[0-9a-f]{64}$/.test(planHash)
      || !/^[0-9a-f]{64}$/.test(integrityHash)
      || integrityHash !== expectedIntegrityHash
      || (expected.planHash !== undefined && planHash !== expected.planHash)
      || (expected.counts !== undefined && !cleanupCountsEqual(counts, expected.counts))
    ) {
      throw cleanupFailure("remote identity cleanup persisted audit is invalid");
    }
    return { planHash, counts };
  } catch (error) {
    if (error instanceof RemoteIdentityCleanupFailure) throw error;
    throw cleanupFailure("remote identity cleanup persisted audit is invalid");
  }
}

export async function cleanupRemoteIdentities(
  options: RemoteIdentityCleanupOptions,
): Promise<RemoteIdentityCleanupSummary> {
  const version = options.version ?? 1;
  const actor = typeof options.actor === "string" ? options.actor.trim() : "";
  const idempotencyKey = typeof options.idempotencyKey === "string" ? options.idempotencyKey.trim() : "";
  if (version !== 1 || !actor || !idempotencyKey) {
    throw cleanupFailure("remote identity cleanup request is invalid");
  }
  if (options.apply && !options.expectedPlanHash) {
    throw cleanupFailure("remote identity cleanup apply requires an expected plan hash");
  }
  if (options.apply && !/^[0-9a-f]{64}$/.test(options.expectedPlanHash!)) {
    throw cleanupFailure("remote identity cleanup expected plan hash is invalid");
  }

  const databaseUrl = options.databaseUrl
    ?? process.env["HASNA_REPOS_DATABASE_URL"]
    ?? process.env["REPOS_DATABASE_URL"]
    ?? null;
  if (!databaseUrl && !options.remoteClient) {
    throw cleanupFailure("remote identity cleanup requires an explicit remote database");
  }
  let remote: ReposRemoteSyncClient;
  try {
    remote = options.remoteClient ?? createRemoteSyncClient(databaseUrl!);
  } catch {
    throw new Error("remote identity cleanup failed");
  }
  const ownsRemote = !options.remoteClient;
  let transactionOpen = false;
  let schemaLockHeld = false;
  try {
    if (ownsRemote) await remote.connect?.();
    await remote.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      "open-repos.remote-identity-cleanup.schema.v1",
    ]);
    schemaLockHeld = true;
    await remote.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await prepareRemoteSearchPath(remote, getReposDatabaseSchema(options));
    await remote.query(`
      CREATE TABLE IF NOT EXISTS repos_remote_identity_cleanup_audit (
        id BIGSERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
        actor TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        counts_json JSONB NOT NULL,
        integrity_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await remote.query(`
      ALTER TABLE repos_remote_identity_cleanup_audit
      ADD COLUMN IF NOT EXISTS integrity_hash TEXT
    `);
    await remote.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_remote_identity_cleanup_idempotency
      ON repos_remote_identity_cleanup_audit(idempotency_key)
    `);
    await remote.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
    const existing = await remote.query(`
      SELECT idempotency_key, version, mode, actor, plan_hash, counts_json, integrity_hash
      FROM repos_remote_identity_cleanup_audit
      WHERE idempotency_key = $1
    `, [idempotencyKey]);
    if (existing.rows.length > 1) {
      throw cleanupFailure("remote identity cleanup persisted audit is invalid");
    }
    if (existing.rows[0]) {
      const mode = options.apply ? "apply" : "dry_run";
      const validatedAudit = validateCleanupAuditRow(existing.rows[0]!, {
        idempotencyKey,
        version,
        mode,
        actor,
        planHash: options.expectedPlanHash,
      });
      await remote.query("COMMIT");
      transactionOpen = false;
      return {
        schema: REMOTE_IDENTITY_CLEANUP_SCHEMA,
        version: 1,
        applied: Boolean(options.apply),
        replayed: true,
        idempotency_key: idempotencyKey,
        plan_hash: validatedAudit.planHash,
        counts: validatedAudit.counts,
      };
    }

    const schema = await remote.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('repos', 'remotes')
      ORDER BY table_name, ordinal_position
    `);
    const columns = new Map<string, Set<string>>();
    for (const row of schema.rows) {
      const table = String(row["table_name"]);
      const set = columns.get(table) ?? new Set<string>();
      set.add(String(row["column_name"]));
      columns.set(table, set);
    }
    const required = [
      ["repos", ["id", "name", "org", "description", "remote_url", "search_vector"]],
      ["remotes", ["id", "url", "fetch_url"]],
    ] as const;
    if (required.some(([table, names]) => names.some((name) => !columns.get(table)?.has(name)))) {
      throw cleanupFailure("remote identity cleanup schema mismatch");
    }

    if (options.apply) {
      await remote.query("LOCK TABLE repos, remotes IN SHARE ROW EXCLUSIVE MODE");
    }
    const lockClause = options.apply ? " FOR UPDATE" : "";
    const repos = await remote.query(`SELECT id, name, org, description, remote_url,
      search_vector::text AS search_vector FROM repos ORDER BY id${lockClause}`);
    const remotes = await remote.query(`SELECT id, url, fetch_url FROM remotes ORDER BY id${lockClause}`);
    const repoChanges = repos.rows.flatMap((row) => {
      const target = sanitizeRemoteIdentity(row["remote_url"]);
      return target === row["remote_url"] ? [] : [{ id: Number(row["id"]), before: row["remote_url"], target }];
    });
    const remotePlanRows: Array<Record<string, unknown>> = [];
    const expectedRemoteRows: Array<Record<string, unknown>> = [];
    const remoteChanges: RemoteCleanupChange[] = [];
    for (const row of remotes.rows) {
      const id = Number(row["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw cleanupFailure("remote identity cleanup found an invalid remote identity");
      }
      const url = sanitizeRemoteIdentity(row["url"]);
      const fetchUrl = sanitizeRemoteIdentity(row["fetch_url"]);
      remotePlanRows.push({
        id,
        before_digest: cleanupValueDigest({
          url: row["url"] ?? null,
          fetch_url: row["fetch_url"] ?? null,
        }),
        target_url: url,
        target_fetch_url: fetchUrl,
        action: url ? (url === row["url"] && fetchUrl === row["fetch_url"] ? "keep" : "update") : "delete",
      });
      if (!url) {
        remoteChanges.push({
          id,
          beforeUrl: row["url"],
          beforeFetchUrl: row["fetch_url"],
          delete: true,
        });
      } else {
        expectedRemoteRows.push({ id, url, fetch_url: fetchUrl });
        if (url !== row["url"] || fetchUrl !== row["fetch_url"]) {
          remoteChanges.push({
            id,
            beforeUrl: row["url"],
            beforeFetchUrl: row["fetch_url"],
            url,
            fetchUrl,
            delete: false,
          });
        }
      }
    }
    const searchVectorChanges: RemoteCleanupSearchVectorChange[] = [];
    const repoPlanRows: Array<Record<string, unknown>> = [];
    const expectedRepoRows: Array<Record<string, unknown>> = [];
    for (const row of repos.rows) {
      const id = Number(row["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw cleanupFailure("remote identity cleanup found an invalid repository identity");
      }
      const targetRemote = sanitizeRemoteIdentity(row["remote_url"]);
      const targetSearch = await remote.query(`SELECT to_tsvector('english',
        coalesce($1::text, '') || ' ' || coalesce($2::text, '') || ' ' ||
        coalesce($3::text, '') || ' ' || coalesce($4::text, ''))::text AS target_search_vector`, [
        row["name"],
        row["org"],
        row["description"],
        targetRemote,
      ]);
      const rawTarget = targetSearch.rows[0]?.["target_search_vector"];
      if (typeof rawTarget !== "string") {
        throw cleanupFailure("remote identity cleanup search planning failed");
      }
      const target = rawTarget;
      repoPlanRows.push({
        id,
        before_digest: cleanupValueDigest({
          name: row["name"] ?? null,
          org: row["org"] ?? null,
          description: row["description"] ?? null,
          remote_url: row["remote_url"] ?? null,
          search_vector: row["search_vector"] ?? null,
        }),
        target_remote_url: targetRemote,
        target_search_vector_digest: cleanupValueDigest(target),
      });
      expectedRepoRows.push({
        id,
        name: row["name"] ?? null,
        org: row["org"] ?? null,
        description: row["description"] ?? null,
        remote_url: targetRemote,
        search_vector: target,
      });
      if (row["search_vector"] !== target) {
        searchVectorChanges.push({ id, before: row["search_vector"], target });
      }
    }
    const expectedRepos = exactCleanupState(expectedRepoRows, cleanupRepoState);
    const expectedRemotes = exactCleanupState(expectedRemoteRows, cleanupRemoteState);
    const counts: RemoteIdentityCleanupCounts = {
      repos_scanned: repos.rows.length,
      repos_update: repoChanges.length,
      remotes_scanned: remotes.rows.length,
      remotes_update: remoteChanges.filter((change) => !change.delete).length,
      remotes_delete: remoteChanges.filter((change) => change.delete).length,
      search_vectors_repaired: searchVectorChanges.length,
    };
    const planHash = cleanupPlanHash({
      version,
      counts,
      repos: repoPlanRows,
      remotes: remotePlanRows,
    });
    if (options.apply && options.expectedPlanHash !== planHash) {
      throw cleanupFailure("remote identity cleanup plan mismatch");
    }

    const verifyAppliedState = async (): Promise<void> => {
      const verifiedRepos = await remote.query(`SELECT id, name, org, description, remote_url,
        search_vector::text AS search_vector FROM repos ORDER BY id`);
      const verifiedRemotes = await remote.query("SELECT id, url, fetch_url FROM remotes ORDER BY id");
      if (
        verifiedRepos.rows.length !== expectedRepos.size
        || verifiedRemotes.rows.length !== expectedRemotes.size
      ) {
        throw cleanupFailure("remote identity cleanup count verification failed");
      }
      const actualRepos = exactCleanupState(verifiedRepos.rows, cleanupRepoState);
      const actualRemotes = exactCleanupState(verifiedRemotes.rows, cleanupRemoteState);
      if (
        !cleanupStatesEqual(expectedRepos, actualRepos)
        || !cleanupStatesEqual(expectedRemotes, actualRemotes)
      ) {
        throw cleanupFailure("remote identity cleanup verification failed");
      }
    };
    if (options.apply) {
      for (const change of repoChanges) {
        const result = await remote.query(
          "UPDATE repos SET remote_url = $1 WHERE id = $2 AND remote_url IS NOT DISTINCT FROM $3",
          [change.target, change.id, change.before],
        );
        if ((result.rowCount ?? 0) !== 1) {
          throw cleanupFailure("remote identity cleanup concurrent change detected");
        }
      }
      for (const change of remoteChanges) {
        if (change.delete) {
          const result = await remote.query(
            "DELETE FROM remotes WHERE id = $1 AND url IS NOT DISTINCT FROM $2 AND fetch_url IS NOT DISTINCT FROM $3",
            [change.id, change.beforeUrl, change.beforeFetchUrl],
          );
          if ((result.rowCount ?? 0) !== 1) {
            throw cleanupFailure("remote identity cleanup concurrent change detected");
          }
        } else {
          const result = await remote.query(
            "UPDATE remotes SET url = $1, fetch_url = $2 WHERE id = $3 AND url IS NOT DISTINCT FROM $4 AND fetch_url IS NOT DISTINCT FROM $5",
            [change.url, change.fetchUrl, change.id, change.beforeUrl, change.beforeFetchUrl],
          );
          if ((result.rowCount ?? 0) !== 1) {
            throw cleanupFailure("remote identity cleanup concurrent change detected");
          }
        }
      }
      for (const change of searchVectorChanges) {
        const repaired = await remote.query(
          `UPDATE repos SET search_vector = $1::tsvector
           WHERE id = $2 AND search_vector::text IS NOT DISTINCT FROM $3`,
          [change.target, change.id, change.before],
        );
        if ((repaired.rowCount ?? 0) !== 1) {
          throw cleanupFailure("remote identity cleanup concurrent change detected");
        }
      }
      await verifyAppliedState();
    }
    const mode = options.apply ? "apply" : "dry_run";
    const integrityHash = cleanupAuditIntegrityHash({
      idempotencyKey,
      version,
      mode,
      actor,
      planHash,
      counts,
    });
    await remote.query(`
      INSERT INTO repos_remote_identity_cleanup_audit
        (idempotency_key, version, mode, actor, plan_hash, counts_json, integrity_hash)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `, [idempotencyKey, version, mode, actor, planHash, JSON.stringify(counts), integrityHash]);
    const persistedAudit = await remote.query(`
      SELECT idempotency_key, version, mode, actor, plan_hash, counts_json, integrity_hash
      FROM repos_remote_identity_cleanup_audit
      WHERE idempotency_key = $1
    `, [idempotencyKey]);
    if (persistedAudit.rows.length !== 1) {
      throw cleanupFailure("remote identity cleanup persisted audit is invalid");
    }
    validateCleanupAuditRow(persistedAudit.rows[0]!, {
      idempotencyKey,
      version,
      mode,
      actor,
      planHash,
      counts,
    });
    if (options.apply) {
      // The audit insert is still inside the serializable transaction. Verify
      // the complete post-state again so triggers cannot contaminate or change
      // row cardinality between the first verification and COMMIT.
      await verifyAppliedState();
    }
    await remote.query("COMMIT");
    transactionOpen = false;
    return {
      schema: REMOTE_IDENTITY_CLEANUP_SCHEMA,
      version: 1,
      applied: Boolean(options.apply),
      replayed: false,
      idempotency_key: idempotencyKey,
      plan_hash: planHash,
      counts,
    };
  } catch (error) {
    if (transactionOpen) {
      try { await remote.query("ROLLBACK"); } catch { /* retain the safe cleanup failure */ }
    }
    if (error instanceof RemoteIdentityCleanupFailure) {
      throw error;
    }
    throw new Error("remote identity cleanup failed");
  } finally {
    if (schemaLockHeld) {
      try {
        await remote.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          "open-repos.remote-identity-cleanup.schema.v1",
        ]);
      } catch {
        // Never replace a closed cleanup result with raw driver output.
      }
    }
    if (ownsRemote) {
      try { await remote.end?.(); } catch { /* connection close cannot change the closed result */ }
    }
  }
}

function getLocalRows(spec: SyncTableSpec): Array<Record<string, unknown>> {
  const db = getDb();
  return db.query(`SELECT ${spec.columns.join(", ")} FROM ${spec.table}`).all() as Array<Record<string, unknown>>;
}

async function pushLocalSyncRecords(remote: ReposRemoteSyncClient): Promise<number> {
  let rowsSynced = 0;
  const sourceMachineId = getSourceMachineId();
  for (const spec of SYNC_TABLES) {
    for (const row of getLocalRows(spec)) {
      const payload = normalizePayload(row, spec);
      const result = spec.remoteMode === "direct"
        ? await pushDirectRemoteRow(remote, spec, payload, sourceMachineId)
        : await pushRecordRemoteRow(remote, spec, payload, sourceMachineId);
      rowsSynced += result.rowCount ?? 0;
    }
  }
  return rowsSynced;
}

async function pushDirectRemoteRow(
  remote: ReposRemoteSyncClient,
  spec: SyncTableSpec,
  payload: Record<string, unknown>,
  sourceMachineId: string,
): Promise<QueryResultLike> {
  const columns = [...spec.columns, "source_machine_id"];
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const updateColumns = spec.columns.filter((column) => column !== spec.idColumn && column !== "created_at");
  const assignments = [
    ...updateColumns.map((column) => `${column} = EXCLUDED.${column}`),
    "source_machine_id = EXCLUDED.source_machine_id",
  ].join(", ");
  return remote.query(`
    INSERT INTO ${spec.table} (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (${spec.idColumn}) DO UPDATE SET ${assignments}
    WHERE ${spec.table}.updated_at < EXCLUDED.updated_at
      OR (
        ${spec.table}.updated_at = EXCLUDED.updated_at
        AND coalesce(${spec.table}.source_machine_id, '') < EXCLUDED.source_machine_id
      )
  `, [
    ...spec.columns.map((column) => payload[column] ?? null),
    sourceMachineId,
  ]);
}

async function pushRecordRemoteRow(
  remote: ReposRemoteSyncClient,
  spec: SyncTableSpec,
  payload: Record<string, unknown>,
  sourceMachineId: string,
): Promise<QueryResultLike> {
  return remote.query(`
    INSERT INTO ${SYNC_RECORD_TABLE} (table_name, record_id, payload, updated_at, source_machine_id)
    VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5)
    ON CONFLICT (table_name, record_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at,
      source_machine_id = EXCLUDED.source_machine_id
    WHERE ${SYNC_RECORD_TABLE}.updated_at < EXCLUDED.updated_at
      OR (
        ${SYNC_RECORD_TABLE}.updated_at = EXCLUDED.updated_at
        AND coalesce(${SYNC_RECORD_TABLE}.source_machine_id, '') < EXCLUDED.source_machine_id
      )
  `, [
    spec.table,
    recordId(payload, spec),
    JSON.stringify(payload),
    normalizeTimestamp(payload["updated_at"]),
    sourceMachineId,
  ]);
}

function upsertLocalPayload(spec: SyncTableSpec, payload: Record<string, unknown>): void {
  const db = getDb();
  const normalized = normalizePayload(payload, spec);
  const placeholders = spec.columns.map(() => "?").join(", ");
  const updateColumns = spec.columns.filter((column) => column !== spec.idColumn);
  const assignments = updateColumns.map((column) => `${column} = excluded.${column}`).join(", ");
  db.query(`
    INSERT INTO ${spec.table} (${spec.columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(${spec.idColumn}) DO UPDATE SET ${assignments}
  `).run(...spec.columns.map((column) => toSqliteBinding(normalized[column])));
}

async function pullRemoteSyncRecords(remote: ReposRemoteSyncClient): Promise<number> {
  const db = getDb();
  let rowsSynced = 0;
  const sourceMachineId = getSourceMachineId();
  for (const spec of SYNC_TABLES) {
    const result = spec.remoteMode === "direct"
      ? await remote.query(`SELECT ${spec.columns.join(", ")}, source_machine_id FROM ${spec.table}`)
      : await remote.query(
          `SELECT table_name, record_id, payload, updated_at, source_machine_id FROM ${SYNC_RECORD_TABLE} WHERE table_name = $1`,
          [spec.table],
        );
    for (const row of result.rows) {
      const payload = spec.remoteMode === "direct" ? row : parsePayload(row["payload"]);
      const id = recordId(payload, spec);
      const local = db.query(`SELECT updated_at FROM ${spec.table} WHERE ${spec.idColumn} = ?`).get(id) as {
        updated_at: string | null;
      } | null;
      const remoteUpdatedAt = row["updated_at"] ?? payload["updated_at"];
      if (local && timestampMs(local.updated_at) > timestampMs(remoteUpdatedAt)) continue;
      if (
        local
        && timestampMs(local.updated_at) === timestampMs(remoteUpdatedAt)
        && String(row["source_machine_id"] ?? "") <= sourceMachineId
      ) {
        continue;
      }
      payload["updated_at"] = normalizeTimestamp(remoteUpdatedAt);
      upsertLocalPayload(spec, payload);
      rowsSynced += 1;
    }
  }
  return rowsSynced;
}

function resolveRepoPathFromWatchEvent(root: string, filename: string): string | null {
  const normalized = filename.replace(/\\/g, "/");
  const gitMarkerIndex = normalized.indexOf("/.git");
  if (gitMarkerIndex === -1) return null;
  const repoRelativePath = normalized.slice(0, gitMarkerIndex);
  if (!repoRelativePath) return null;
  return resolve(root, repoRelativePath);
}

export async function syncRepoCatalog(
  direction: "pull" | "push",
  onProgress?: (msg: string) => void,
  options: SyncRepoCatalogOptions = {},
): Promise<RemoteSyncSummary> {
  const databaseUrl = getReposDatabaseUrl(options);
  const storageMode = options.storageMode ?? (databaseUrl ? "hybrid" : getReposStorageMode());
  if (storageMode === "local") {
    return {
      direction,
      enabled: false,
      rowsSynced: 0,
      errors: [],
      skippedReason: "local_mode",
    };
  }

  const sqlitePath = getDbPath();
  if (sqlitePath === ":memory:") {
    return {
      direction,
      enabled: false,
      rowsSynced: 0,
      errors: [],
      skippedReason: "memory_db",
    };
  }

  if (!databaseUrl && !options.remoteClient) {
    return {
      direction,
      enabled: false,
      rowsSynced: 0,
      errors: [],
      skippedReason: "missing_hasna_repos_database_url",
    };
  }

  const ownsRemote = !options.remoteClient;
  let remote: ReposRemoteSyncClient | null = options.remoteClient ?? null;
  let transactionOpen = false;
  let result: RemoteSyncSummary;
  try {
    // Construct app-owned clients inside the closed error boundary. Some
    // connection-string parsers fail synchronously before connect().
    remote = remote ?? (options.remoteClientFactory ?? createRemoteSyncClient)(databaseUrl!);
    if (ownsRemote) await remote.connect?.();
    await remote.query("BEGIN");
    transactionOpen = true;
    await prepareRemoteSearchPath(remote, getReposDatabaseSchema(options));
    await applyPostgresMigrations(remote);
    await ensureRemoteSyncSchema(remote);
    onProgress?.(`[sync] ${direction} repo catalog`);
    const rowsSynced = direction === "push"
      ? await pushLocalSyncRecords(remote)
      : await pullRemoteSyncRecords(remote);
    await remote.query("COMMIT");
    transactionOpen = false;
    result = {
      direction,
      enabled: true,
      rowsSynced,
      errors: [],
    };
  } catch {
    if (transactionOpen && remote) {
      try { await remote.query("ROLLBACK"); } catch { /* preserve closed output */ }
    }
    result = {
      direction,
      enabled: true,
      rowsSynced: 0,
      errors: [redactErrorMessage(null, databaseUrl)],
    };
  }
  if (ownsRemote && remote) {
    try {
      await remote.end?.();
    } catch {
      result = {
        ...result,
        // COMMIT already succeeded. Report only the closed teardown condition;
        // never rewrite a durable synchronization result as a failed sync.
        teardownStatus: "failed",
      };
    }
  }
  return result;
}

export async function ensureWorkspaceBootstrap(
  rootDirs?: string[],
  opts: {
    force?: boolean;
    full?: boolean;
    onProgress?: (msg: string) => void;
    syncRemote?: boolean;
    workers?: number;
  } = {},
): Promise<WorkspaceBootstrapResult> {
  const roots = getWorkspaceRoots(rootDirs).map((root) => resolve(root));
  const shouldSyncRemote = opts.syncRemote ?? true;
  const state = getAutomationState<{ roots: string[] }>(WORKSPACE_BOOTSTRAP_STATE_KEY);
  const repoCount = getRepoCount();
  const expectedRoots = JSON.stringify(roots);
  const currentRoots = state ? JSON.stringify(state.value.roots) : null;

  const shouldBootstrap = opts.force || repoCount === 0 || currentRoots !== expectedRoots;
  if (!shouldBootstrap) {
    return {
      bootstrapped: false,
      roots,
      hooks: emptyHookSummary(),
    };
  }

  const remotePull = shouldSyncRemote ? await syncRepoCatalog("pull", opts.onProgress) : undefined;

  const repoPaths = discoverRepos(roots);
  const hooks = installPostCommitHooks(repoPaths, getHookQueuePath());
  opts.onProgress?.(appendDanglingWarning(
    `Bootstrapping repo index from ${roots.join(", ")}`,
    hooks,
  ));
  const scan = await scanRepoPaths(repoPaths, {
    full: opts.full,
    onProgress: opts.onProgress,
    workers: opts.workers,
  });

  setAutomationState(WORKSPACE_BOOTSTRAP_STATE_KEY, {
    roots,
    repoCount: scan.repos_found,
    queuePath: getHookQueuePath(),
    bootstrappedAt: new Date().toISOString(),
  });

  const remotePush = shouldSyncRemote ? await syncRepoCatalog("push", opts.onProgress) : undefined;

  return {
    bootstrapped: true,
    roots,
    hooks,
    scan,
    remotePull,
    remotePush,
  };
}

export async function startAutoIndexWorker(
  rootDirs?: string[],
  opts: {
    full?: boolean;
    onProgress?: (msg: string) => void;
    syncRemote?: boolean;
    workers?: number;
  } = {},
): Promise<AutoIndexWorker> {
  const roots = getWorkspaceRoots(rootDirs).map((root) => resolve(root));
  const cfg = getConfig();

  await ensureWorkspaceBootstrap(roots, {
    full: opts.full,
    onProgress: opts.onProgress,
    syncRemote: opts.syncRemote,
    workers: opts.workers,
  });

  const knownRepos = new Set(discoverRepos(roots));
  const pendingScans = new Map<string, ReturnType<typeof setTimeout>>();
  const rootWatchers: Array<ReturnType<typeof watch>> = [];

  const scheduleScan = (repoPath: string, source: string) => {
    const normalizedRepoPath = resolve(repoPath);
    if (pendingScans.has(normalizedRepoPath)) return;

    const timeout = setTimeout(() => {
      pendingScans.delete(normalizedRepoPath);
      void (async () => {
        if (!existsSync(join(normalizedRepoPath, ".git"))) return;
        opts.onProgress?.(`[${source}] indexing ${basename(normalizedRepoPath)}`);
        const result = await scanRepoPaths([normalizedRepoPath], {
          full: opts.full,
          workers: 1,
        });
        opts.onProgress?.(
          `[${source}] ${basename(normalizedRepoPath)} indexed (${result.commits_indexed} commits, ${result.branches_indexed} branches, ${result.tags_indexed} tags)`,
        );
        if (opts.syncRemote ?? true) {
          const syncResult = await syncRepoCatalog("push", opts.onProgress);
          if (syncResult.errors.length > 0) {
            opts.onProgress?.(`[remote] push failed: ${syncResult.errors.join("; ")}`);
          }
        }
      })().catch((error) => {
        opts.onProgress?.(`[error] failed to index ${normalizedRepoPath}: ${(error as Error).message}`);
      });
    }, cfg.watchDebounceMs ?? 1500);

    pendingScans.set(normalizedRepoPath, timeout);
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;

    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const repoPath = resolveRepoPathFromWatchEvent(root, filename.toString());
        if (!repoPath || knownRepos.has(repoPath) || !existsSync(join(repoPath, ".git"))) return;

        knownRepos.add(repoPath);
        const hooks = installPostCommitHooks([repoPath], getHookQueuePath());
        opts.onProgress?.(appendDanglingWarning(
          `[new] discovered ${basename(repoPath)} (${hooks.installed} hook installed, ${hooks.updated} updated)`,
          hooks,
        ));
        scheduleScan(repoPath, "workspace-watch");
      });
      rootWatchers.push(watcher);
    } catch (error) {
      opts.onProgress?.(`[watch] unable to watch ${root}: ${(error as Error).message}`);
    }
  }

  const hookQueueTimer = setInterval(() => {
    const queuedRepos = drainHookQueue(getHookQueuePath());
    for (const repoPath of queuedRepos) {
      knownRepos.add(repoPath);
      scheduleScan(repoPath, "post-commit");
    }
  }, cfg.hookPollIntervalMs ?? 2000);

  const workspaceRescanTimer = setInterval(() => {
    for (const repoPath of discoverRepos(roots)) {
      if (knownRepos.has(repoPath)) continue;
      knownRepos.add(repoPath);
      const hooks = installPostCommitHooks([repoPath], getHookQueuePath());
      opts.onProgress?.(appendDanglingWarning(
        `[new] found ${basename(repoPath)} during rescan (${hooks.installed} hook installed, ${hooks.updated} updated)`,
        hooks,
      ));
      scheduleScan(repoPath, "workspace-rescan");
    }
  }, cfg.workspaceRescanIntervalMs ?? 30000);

  opts.onProgress?.(`Auto-index worker watching ${roots.join(", ")}`);

  return {
    roots,
    stop: () => {
      clearInterval(hookQueueTimer);
      clearInterval(workspaceRescanTimer);
      for (const watcher of rootWatchers) {
        watcher.close();
      }
      for (const timeout of pendingScans.values()) {
        clearTimeout(timeout);
      }
      pendingScans.clear();
      opts.onProgress?.("Auto-index worker stopped");
    },
  };
}
