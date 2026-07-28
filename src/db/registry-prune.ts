/**
 * Remove registry rows whose path no longer exists.
 *
 * The registry had no prune, forget, remove or delete verb at all. `repos scan`
 * exits 0 without retiring anything, and `repos registry` exposed only
 * `relocate-primary` and `adjudicate-branches`. So 291 rows on this machine
 * pointing at absent paths — including `open-browserplan`, whose stale
 * `github.com/hasna/browserplan` remote still *works* because GitHub redirects it
 * to `hasnastudio/platform-browserplan`, so any tool resolving that row operates
 * on the live repo believing it is the old one — had no supported way to be
 * removed. The registry is fail-closed SQLite and was deliberately not
 * hand-edited, which was the right call and left no path forward.
 *
 * ## Why this refuses by default
 *
 * A prune verb on a registry is a deletion primitive. This workspace has already
 * lost 139 artifacts to a deletion path that resolved to a **production default
 * while the operator believed it was pointed somewhere else**. So the failure to
 * design against is not "the operator deleted the wrong rows", it is "the operator
 * deleted the right rows in the wrong database".
 *
 * Four independent things must therefore be true before anything is deleted, and
 * three of them are things only a caller who has *seen the plan* can supply:
 *
 *   - `apply` — absent, this is a dry run that writes nothing;
 *   - `expectedDatabasePath` — the caller states which database they believe they
 *     are pruning, and it is compared against the resolved path. This is the
 *     specific guard for the 139-artifact failure: a default that resolves
 *     elsewhere now aborts instead of proceeding;
 *   - `expectedPlanHash` — binds the exact set of rows from the dry run. A row
 *     added, removed or changed in between aborts the whole operation;
 *   - `actor` and `idempotencyKey` — so the deletion is attributable and a retry
 *     replays the receipt rather than deleting a second, different set.
 *
 * ## Why only missing paths
 *
 * Deliberately the single narrowest class. `git worktree` rows whose parent
 * repository was deleted still have directories on disk, and some of those
 * directories are the only surviving copy of a deleted repository. Removing such
 * a row does not delete the files, but it destroys the record of *where that data
 * is* — which is the harm, one step removed. When the path does not exist there is
 * nothing on disk to lose, which is the only case where a registry deletion is
 * information-preserving.
 *
 * Pruning gutted-but-present checkouts is a separate decision needing a separate
 * verb and a separate argument. It is not smuggled in behind a flag here.
 *
 * ## What it never does
 *
 * It never touches the filesystem. There is no `rm`, no `unlink`, no `git` call in
 * this module, and a test asserts the directories and files under a pruned tree
 * still exist afterwards.
 *
 * It also never discards audit history. `repo_relocation_audit` records a
 * `repo_id` but carries no foreign key to `repos` (migration 7 removed it), so
 * relocation receipts survive a prune of the row they describe — which is the
 * behaviour you want from a receipt, and is asserted rather than assumed.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { getDb, getDbPath } from "./database.js";

export const REGISTRY_PRUNE_SCHEMA = "open-repos.registry-prune.v1" as const;
export const REGISTRY_PRUNE_RECEIPT_SCHEMA = "open-repos.registry-prune-receipt.v1" as const;
const OPERATION = "registry_prune" as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

/**
 * Tables whose rows reference `repos(id)` and whose behaviour on delete is
 * therefore already decided by the schema.
 *
 * Checked at run time against the live foreign keys. A table added later that
 * this list does not know about aborts the prune instead of being deleted or
 * orphaned by accident — the same guard `relocate-primary` applies, for the same
 * reason: the set of things attached to a repo row grows, and a delete that
 * silently keeps up with it is a delete nobody is reviewing.
 */
const KNOWN_REPO_FK_TABLES = new Set([
  "commits",
  "branches",
  "tags",
  "remotes",
  "pull_requests",
  "worktree_leases",
]);

export type RegistryPruneErrorCode =
  | "INVALID_REQUEST"
  | "CONFIRMATION_REQUIRED"
  | "DATABASE_MISMATCH"
  | "PLAN_HASH_REQUIRED"
  | "PLAN_HASH_MISMATCH"
  | "PATH_REAPPEARED"
  | "UNKNOWN_REPO_FOREIGN_KEY"
  | "IDEMPOTENCY_CONFLICT";

export interface RegistryPruneErrorDetails {
  expected_database?: string;
  actual_database?: string;
  expected_plan_hash?: string;
  actual_plan_hash?: string;
  missing_confirmations?: string[];
  rows?: Array<{ id: number; name: string; path: string }>;
  tables?: string[];
}

export class RegistryPruneError extends Error {
  constructor(
    public readonly code: RegistryPruneErrorCode,
    message: string,
    public readonly details?: RegistryPruneErrorDetails,
  ) {
    super(message);
    this.name = "RegistryPruneError";
  }
}

export interface PrunableRow {
  id: number;
  name: string;
  path: string;
  org: string | null;
  remote_url: string | null;
  last_scanned: string | null;
  updated_at: string | null;
  /** Rows in child tables that a delete would cascade away, per table. */
  cascade_counts: Record<string, number>;
}

export interface RegistryPrunePlan {
  schema: typeof REGISTRY_PRUNE_SCHEMA;
  operation: typeof OPERATION;
  database: string;
  /** Rows whose stored path does not exist. */
  rows: PrunableRow[];
  row_count: number;
  /** Total child rows that would cascade away, by table. */
  cascade_totals: Record<string, number>;
  plan_hash: string;
}

export interface RegistryPruneRequest {
  apply?: boolean;
  expectedDatabasePath?: string;
  expectedPlanHash?: string;
  actor?: string;
  idempotencyKey?: string;
  /** Cap on rows pruned in one operation. Absent means no cap. */
  limit?: number;
}

export interface RegistryPruneResult {
  schema: typeof REGISTRY_PRUNE_SCHEMA;
  applied: boolean;
  replayed: boolean;
  plan: RegistryPrunePlan;
  receipt: {
    id: string;
    schema: typeof REGISTRY_PRUNE_RECEIPT_SCHEMA;
    actor: string;
    idempotency_key: string;
    plan_hash: string;
    row_count: number;
    created_at: string;
  } | null;
}

/** Deterministic hash over exactly what the operator was shown. */
function planHash(database: string, rows: PrunableRow[]): string {
  const canonical = JSON.stringify({
    schema: REGISTRY_PRUNE_SCHEMA,
    operation: OPERATION,
    database,
    rows: rows
      .map((row) => ({ id: row.id, path: row.path, updated_at: row.updated_at }))
      .sort((a, b) => a.id - b.id),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface ForeignKeyRow { table: string; on_delete: string }

function repoForeignKeys(db: Database): ForeignKeyRow[] {
  const tables = (db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>).map((row) => row.name);
  const found: ForeignKeyRow[] = [];
  for (const table of tables) {
    const keys = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; on_delete: string }>;
    for (const key of keys) {
      if (key.table === "repos") found.push({ table, on_delete: (key.on_delete ?? "").toUpperCase() });
    }
  }
  return found;
}

/**
 * Refuse when something now references `repos(id)` that this module has not been
 * taught about. Deleting through an unknown relationship is exactly the kind of
 * quiet collateral damage a prune verb must not be capable of.
 */
function assertKnownForeignKeys(db: Database): ForeignKeyRow[] {
  const keys = repoForeignKeys(db);
  const unknown = [...new Set(keys.map((key) => key.table))].filter((table) => !KNOWN_REPO_FK_TABLES.has(table)).sort();
  if (unknown.length > 0) {
    throw new RegistryPruneError(
      "UNKNOWN_REPO_FOREIGN_KEY",
      `these tables reference repos(id) and this prune has not been reviewed against them: ${unknown.join(", ")}`,
      { tables: unknown },
    );
  }
  return keys;
}

function countChildRows(db: Database, keys: ForeignKeyRow[], repoId: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [...new Set(keys.map((key) => key.table))].sort()) {
    const row = db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE repo_id = ?`).get(repoId) as { c: number } | null;
    if (row && row.c > 0) counts[table] = row.c;
  }
  return counts;
}

/**
 * Build the plan: every row whose stored path does not exist on this machine.
 *
 * `pathExists` is injectable so the selection rule itself can be tested without
 * needing the filesystem to be in a particular state.
 */
export function planRegistryPrune(
  opts: { db?: Database; databasePath?: string; limit?: number; pathExists?: (path: string) => boolean } = {},
): RegistryPrunePlan {
  const db = opts.db ?? getDb();
  const database = opts.databasePath ?? getDbPath();
  const pathExists = opts.pathExists ?? existsSync;
  const keys = assertKnownForeignKeys(db);

  const all = db
    .query("SELECT id, name, path, org, remote_url, last_scanned, updated_at FROM repos ORDER BY id ASC")
    .all() as Array<{
      id: number; name: string; path: string; org: string | null;
      remote_url: string | null; last_scanned: string | null; updated_at: string | null;
    }>;

  const rows: PrunableRow[] = [];
  for (const row of all) {
    if (!row.path || pathExists(row.path)) continue;
    rows.push({ ...row, cascade_counts: countChildRows(db, keys, row.id) });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }

  const cascadeTotals: Record<string, number> = {};
  for (const row of rows) {
    for (const [table, count] of Object.entries(row.cascade_counts)) {
      cascadeTotals[table] = (cascadeTotals[table] ?? 0) + count;
    }
  }

  return {
    schema: REGISTRY_PRUNE_SCHEMA,
    operation: OPERATION,
    database,
    rows,
    row_count: rows.length,
    cascade_totals: cascadeTotals,
    plan_hash: planHash(database, rows),
  };
}

function samePath(left: string, right: string): boolean {
  // `:memory:` and other non-filesystem handles compare literally.
  const normalize = (value: string) => (isAbsolute(value) ? resolve(value) : value);
  return normalize(left) === normalize(right);
}

function assertConfirmations(request: RegistryPruneRequest, database: string): {
  expectedPlanHash: string; actor: string; idempotencyKey: string;
} {
  const missing: string[] = [];
  if (!request.expectedDatabasePath) missing.push("expectedDatabasePath");
  if (!request.expectedPlanHash) missing.push("expectedPlanHash");
  if (!request.actor) missing.push("actor");
  if (!request.idempotencyKey) missing.push("idempotencyKey");
  if (missing.length > 0) {
    throw new RegistryPruneError(
      "CONFIRMATION_REQUIRED",
      `refusing to prune registry rows without explicit confirmation; missing: ${missing.join(", ")}`,
      { missing_confirmations: missing },
    );
  }
  // The guard for the 139-artifact failure: the operator names the database they
  // believe they are pruning, and a default that resolved elsewhere aborts.
  if (!samePath(request.expectedDatabasePath!, database)) {
    throw new RegistryPruneError(
      "DATABASE_MISMATCH",
      "the resolved registry database is not the one this prune was confirmed against",
      { expected_database: request.expectedDatabasePath, actual_database: database },
    );
  }
  if (!HASH_PATTERN.test(request.expectedPlanHash!)) {
    throw new RegistryPruneError("INVALID_REQUEST", "expectedPlanHash must be a 64-character lowercase sha256 hex digest");
  }
  if (!SAFE_KEY_PATTERN.test(request.actor!)) {
    throw new RegistryPruneError("INVALID_REQUEST", "actor must be a short printable identity");
  }
  if (!SAFE_KEY_PATTERN.test(request.idempotencyKey!)) {
    throw new RegistryPruneError("INVALID_REQUEST", "idempotencyKey must be a short printable key");
  }
  return {
    expectedPlanHash: request.expectedPlanHash!,
    actor: request.actor!,
    idempotencyKey: request.idempotencyKey!,
  };
}

export function pruneRegistryRows(
  request: RegistryPruneRequest = {},
  opts: { db?: Database; databasePath?: string; pathExists?: (path: string) => boolean } = {},
): RegistryPruneResult {
  const db = opts.db ?? getDb();
  const database = opts.databasePath ?? getDbPath();
  const pathExists = opts.pathExists ?? existsSync;

  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1)) {
    throw new RegistryPruneError("INVALID_REQUEST", "limit must be a positive integer");
  }

  const plan = planRegistryPrune({ db, databasePath: database, limit: request.limit, pathExists });
  if (!request.apply) {
    return { schema: REGISTRY_PRUNE_SCHEMA, applied: false, replayed: false, plan, receipt: null };
  }

  const confirmed = assertConfirmations(request, database);

  const existing = db
    .query("SELECT id, plan_hash, actor, idempotency_key, row_count, created_at FROM registry_prune_audit WHERE idempotency_key = ?")
    .get(confirmed.idempotencyKey) as
      { id: string; plan_hash: string; actor: string; idempotency_key: string; row_count: number; created_at: string } | null;
  if (existing) {
    // A retry must replay its receipt, never delete a second, different set under
    // the same key.
    if (existing.plan_hash !== confirmed.expectedPlanHash) {
      throw new RegistryPruneError(
        "IDEMPOTENCY_CONFLICT",
        "this idempotency key was already used for a different plan",
        { expected_plan_hash: confirmed.expectedPlanHash, actual_plan_hash: existing.plan_hash },
      );
    }
    return {
      schema: REGISTRY_PRUNE_SCHEMA,
      applied: true,
      replayed: true,
      plan,
      receipt: { ...existing, schema: REGISTRY_PRUNE_RECEIPT_SCHEMA },
    };
  }

  if (plan.plan_hash !== confirmed.expectedPlanHash) {
    throw new RegistryPruneError(
      "PLAN_HASH_MISMATCH",
      "the registry changed since the dry run; re-run the dry run and review the new plan",
      { expected_plan_hash: confirmed.expectedPlanHash, actual_plan_hash: plan.plan_hash },
    );
  }
  if (plan.row_count === 0) {
    return { schema: REGISTRY_PRUNE_SCHEMA, applied: true, replayed: false, plan, receipt: null };
  }

  const receiptId = randomUUID();
  const createdAt = new Date().toISOString();
  // Cascades are declared on the foreign keys, so they only fire with the pragma
  // on. Without this the child rows would be orphaned rather than removed.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check inside the transaction. A path that reappeared between the dry run
    // and now means someone re-cloned, and that row is no longer stale.
    const reappeared = plan.rows.filter((row) => pathExists(row.path));
    if (reappeared.length > 0) {
      throw new RegistryPruneError(
        "PATH_REAPPEARED",
        "some paths exist again since the dry run; those rows are no longer stale",
        { rows: reappeared.map((row) => ({ id: row.id, name: row.name, path: row.path })) },
      );
    }
    // Optimistic concurrency by re-reading, not by counting affected rows.
    // `repos` carries after-insert/update/delete triggers that maintain the search
    // index, so `run().changes` reports the trigger's writes too — it returned 7
    // for a single-row delete — and can never be compared against 1. Inside
    // BEGIN IMMEDIATE no other writer can intervene between the check and the
    // delete.
    const readRow = db.prepare("SELECT updated_at FROM repos WHERE id = ?");
    const deleteRow = db.prepare("DELETE FROM repos WHERE id = ?");
    for (const row of plan.rows) {
      const current = readRow.get(row.id) as { updated_at: string | null } | null;
      if (!current || current.updated_at !== row.updated_at) {
        throw new RegistryPruneError(
          "PLAN_HASH_MISMATCH",
          `row ${row.id} changed since the dry run; nothing was pruned`,
          { rows: [{ id: row.id, name: row.name, path: row.path }] },
        );
      }
      deleteRow.run(row.id);
    }
    db.query(
      `INSERT INTO registry_prune_audit (id, idempotency_key, plan_hash, operation, actor, row_count, rows_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      confirmed.idempotencyKey,
      plan.plan_hash,
      OPERATION,
      confirmed.actor,
      plan.row_count,
      JSON.stringify(plan.rows),
      createdAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    schema: REGISTRY_PRUNE_SCHEMA,
    applied: true,
    replayed: false,
    plan,
    receipt: {
      id: receiptId,
      schema: REGISTRY_PRUNE_RECEIPT_SCHEMA,
      actor: confirmed.actor,
      idempotency_key: confirmed.idempotencyKey,
      plan_hash: plan.plan_hash,
      row_count: plan.row_count,
      created_at: createdAt,
    },
  };
}
