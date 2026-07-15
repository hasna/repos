import { existsSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client } from "pg";
import { getDb, getDbPath } from "../db/database.js";
import type { ScanResult } from "../types/index.js";
import { getConfig, getHookQueuePath, getWorkspaceRoots } from "./config.js";
import { drainHookQueue, installPostCommitHooks } from "./repo-hooks.js";
import { discoverRepos, scanRepoPaths } from "./scanner.js";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

const WORKSPACE_BOOTSTRAP_STATE_KEY = "workspace_bootstrap";

export interface RemoteSyncSummary {
  direction: "pull" | "push";
  enabled: boolean;
  rowsSynced: number;
  errors: string[];
  skippedReason?: string;
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
  await remote.query(`SET search_path TO ${quoted}`);
}

function getSourceMachineId(): string {
  return process.env["HASNA_MACHINE_ID"] || process.env["OPEN_MACHINES_ID"] || process.env["MACHINE_ID"] || hostname();
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

function cleanupPlanHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanupValueDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ type: typeof value, value: value ?? null }))
    .digest("hex");
}

function parseCleanupCounts(value: unknown): RemoteIdentityCleanupCounts {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid cleanup audit");
  }
  const counts = parsed as Record<string, unknown>;
  const fields: Array<keyof RemoteIdentityCleanupCounts> = [
    "repos_scanned",
    "repos_update",
    "remotes_scanned",
    "remotes_update",
    "remotes_delete",
    "search_vectors_repaired",
  ];
  if (fields.some((field) => !Number.isSafeInteger(counts[field]) || Number(counts[field]) < 0)) {
    throw new Error("invalid cleanup audit");
  }
  return Object.fromEntries(fields.map((field) => [field, Number(counts[field])])) as unknown as RemoteIdentityCleanupCounts;
}

export async function cleanupRemoteIdentities(
  options: RemoteIdentityCleanupOptions,
): Promise<RemoteIdentityCleanupSummary> {
  const version = options.version ?? 1;
  const actor = options.actor.trim();
  const idempotencyKey = options.idempotencyKey.trim();
  if (version !== 1 || !actor || !idempotencyKey) {
    throw new Error("remote identity cleanup request is invalid");
  }
  if (options.apply && !options.expectedPlanHash) {
    throw new Error("remote identity cleanup apply requires an expected plan hash");
  }

  const databaseUrl = options.databaseUrl
    ?? process.env["HASNA_REPOS_DATABASE_URL"]
    ?? process.env["REPOS_DATABASE_URL"]
    ?? null;
  if (!databaseUrl && !options.remoteClient) {
    throw new Error("remote identity cleanup requires an explicit remote database");
  }
  const remote = options.remoteClient ?? createRemoteSyncClient(databaseUrl!);
  const ownsRemote = !options.remoteClient;
  let transactionOpen = false;
  try {
    if (ownsRemote) await remote.connect?.();
    await prepareRemoteSearchPath(remote, options.databaseSchema ?? null);
    await remote.query("BEGIN");
    transactionOpen = true;
    await remote.query(`
      CREATE TABLE IF NOT EXISTS repos_remote_identity_cleanup_audit (
        id BIGSERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
        actor TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        counts_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await remote.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_remote_identity_cleanup_idempotency
      ON repos_remote_identity_cleanup_audit(idempotency_key)
    `);
    const existing = await remote.query(`
      SELECT version, mode, actor, plan_hash, counts_json
      FROM repos_remote_identity_cleanup_audit
      WHERE idempotency_key = $1
    `, [idempotencyKey]);
    if (existing.rows[0]) {
      const row = existing.rows[0]!;
      const applied = row["mode"] === "apply";
      if (
        Number(row["version"]) !== version
        || String(row["actor"]) !== actor
        || applied !== Boolean(options.apply)
        || (options.expectedPlanHash && String(row["plan_hash"]) !== options.expectedPlanHash)
      ) {
        throw new Error("remote identity cleanup idempotency conflict");
      }
      await remote.query("COMMIT");
      transactionOpen = false;
      return {
        schema: REMOTE_IDENTITY_CLEANUP_SCHEMA,
        version: 1,
        applied,
        replayed: true,
        idempotency_key: idempotencyKey,
        plan_hash: String(row["plan_hash"]),
        counts: parseCleanupCounts(row["counts_json"]),
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
      throw new Error("remote identity cleanup schema mismatch");
    }

    const lockClause = options.apply ? " FOR UPDATE" : "";
    const repos = await remote.query(`SELECT id, remote_url FROM repos ORDER BY id${lockClause}`);
    const remotes = await remote.query(`SELECT id, url, fetch_url FROM remotes ORDER BY id${lockClause}`);
    const repoChanges = repos.rows.flatMap((row) => {
      const target = sanitizeRemoteIdentity(row["remote_url"]);
      return target === row["remote_url"] ? [] : [{ id: Number(row["id"]), before: row["remote_url"], target }];
    });
    const remoteChanges: RemoteCleanupChange[] = [];
    for (const row of remotes.rows) {
      const url = sanitizeRemoteIdentity(row["url"]);
      const fetchUrl = sanitizeRemoteIdentity(row["fetch_url"]);
      if (!url) {
        remoteChanges.push({
          id: Number(row["id"]),
          beforeUrl: row["url"],
          beforeFetchUrl: row["fetch_url"],
          delete: true,
        });
      } else if (url !== row["url"] || fetchUrl !== row["fetch_url"]) {
        remoteChanges.push({
          id: Number(row["id"]),
          beforeUrl: row["url"],
          beforeFetchUrl: row["fetch_url"],
          url,
          fetchUrl,
          delete: false,
        });
      }
    }
    const planHash = cleanupPlanHash({
      version,
      repos: repoChanges.map(({ id, before, target }) => ({
        id,
        before_digest: cleanupValueDigest(before),
        target,
      })),
      remotes: remoteChanges.map((change) => change.delete
        ? {
            id: change.id,
            before_url_digest: cleanupValueDigest(change.beforeUrl),
            before_fetch_url_digest: cleanupValueDigest(change.beforeFetchUrl),
            delete: true,
          }
        : {
            id: change.id,
            before_url_digest: cleanupValueDigest(change.beforeUrl),
            before_fetch_url_digest: cleanupValueDigest(change.beforeFetchUrl),
            url: change.url,
            fetch_url: change.fetchUrl,
          }),
    });
    if (options.apply && options.expectedPlanHash !== planHash) {
      throw new Error("remote identity cleanup plan mismatch");
    }

    const counts: RemoteIdentityCleanupCounts = {
      repos_scanned: repos.rows.length,
      repos_update: repoChanges.length,
      remotes_scanned: remotes.rows.length,
      remotes_update: remoteChanges.filter((change) => !change.delete).length,
      remotes_delete: remoteChanges.filter((change) => change.delete).length,
      search_vectors_repaired: 0,
    };
    if (options.apply) {
      for (const change of repoChanges) {
        const result = await remote.query(
          "UPDATE repos SET remote_url = $1 WHERE id = $2 AND remote_url IS NOT DISTINCT FROM $3",
          [change.target, change.id, change.before],
        );
        if ((result.rowCount ?? 0) !== 1) {
          throw new Error("remote identity cleanup concurrent change detected");
        }
      }
      for (const change of remoteChanges) {
        if (change.delete) {
          const result = await remote.query(
            "DELETE FROM remotes WHERE id = $1 AND url IS NOT DISTINCT FROM $2 AND fetch_url IS NOT DISTINCT FROM $3",
            [change.id, change.beforeUrl, change.beforeFetchUrl],
          );
          if ((result.rowCount ?? 0) !== 1) {
            throw new Error("remote identity cleanup concurrent change detected");
          }
        } else {
          const result = await remote.query(
            "UPDATE remotes SET url = $1, fetch_url = $2 WHERE id = $3 AND url IS NOT DISTINCT FROM $4 AND fetch_url IS NOT DISTINCT FROM $5",
            [change.url, change.fetchUrl, change.id, change.beforeUrl, change.beforeFetchUrl],
          );
          if ((result.rowCount ?? 0) !== 1) {
            throw new Error("remote identity cleanup concurrent change detected");
          }
        }
      }
      const repaired = await remote.query(`
        UPDATE repos
        SET search_vector = to_tsvector('english',
          coalesce(name, '') || ' ' || coalesce(org, '') || ' ' ||
          coalesce(description, '') || ' ' || coalesce(remote_url, ''))
        WHERE search_vector IS DISTINCT FROM to_tsvector('english',
          coalesce(name, '') || ' ' || coalesce(org, '') || ' ' ||
          coalesce(description, '') || ' ' || coalesce(remote_url, ''))
      `);
      counts.search_vectors_repaired = repaired.rowCount ?? 0;
      const invalid = await remote.query(`
        SELECT COUNT(*)::int AS count
        FROM repos
        WHERE search_vector IS DISTINCT FROM to_tsvector('english',
          coalesce(name, '') || ' ' || coalesce(org, '') || ' ' ||
          coalesce(description, '') || ' ' || coalesce(remote_url, ''))
      `);
      if (Number(invalid.rows[0]?.["count"] ?? -1) !== 0) {
        throw new Error("remote identity cleanup search verification failed");
      }
      const verifiedRepos = await remote.query("SELECT id, remote_url FROM repos ORDER BY id");
      const verifiedRemotes = await remote.query("SELECT id, url, fetch_url FROM remotes ORDER BY id");
      const reposVerified = verifiedRepos.rows.every(
        (row) => row["remote_url"] === sanitizeRemoteIdentity(row["remote_url"]),
      );
      const remotesVerified = verifiedRemotes.rows.every((row) => {
        const url = sanitizeRemoteIdentity(row["url"]);
        return url !== null
          && row["url"] === url
          && row["fetch_url"] === sanitizeRemoteIdentity(row["fetch_url"]);
      });
      if (!reposVerified || !remotesVerified) {
        throw new Error("remote identity cleanup verification failed");
      }
    }
    const mode = options.apply ? "apply" : "dry_run";
    await remote.query(`
      INSERT INTO repos_remote_identity_cleanup_audit
        (idempotency_key, version, mode, actor, plan_hash, counts_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [idempotencyKey, version, mode, actor, planHash, JSON.stringify(counts)]);
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
    if (error instanceof Error && error.message.startsWith("remote identity cleanup ")) {
      throw error;
    }
    throw new Error("remote identity cleanup failed");
  } finally {
    if (ownsRemote) await remote.end?.();
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
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
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

  const remote = options.remoteClient ?? createRemoteSyncClient(databaseUrl!);
  const ownsRemote = !options.remoteClient;
  try {
    if (ownsRemote) await remote.connect?.();
    await prepareRemoteSearchPath(remote, getReposDatabaseSchema(options));
    await ensureRemoteSyncSchema(remote);
    onProgress?.(`[sync] ${direction} repo catalog`);
    const rowsSynced = direction === "push"
      ? await pushLocalSyncRecords(remote)
      : await pullRemoteSyncRecords(remote);
    return {
      direction,
      enabled: true,
      rowsSynced,
      errors: [],
    };
  } catch (error) {
    return {
      direction,
      enabled: true,
      rowsSynced: 0,
      errors: [redactErrorMessage(error, databaseUrl)],
    };
  } finally {
    if (ownsRemote) await remote.end?.();
  }
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
  opts.onProgress?.(`Bootstrapping repo index from ${roots.join(", ")}`);
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
        opts.onProgress?.(
          `[new] discovered ${basename(repoPath)} (${hooks.installed} hook installed, ${hooks.updated} updated)`,
        );
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
      opts.onProgress?.(
        `[new] found ${basename(repoPath)} during rescan (${hooks.installed} hook installed, ${hooks.updated} updated)`,
      );
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
