import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { getDb, openNonMigratingDb } from "./database.js";

const SCHEMA = "open-repos.branch-adjudication.v1" as const;
const AUDIT_SCHEMA = "open-repos.branch-adjudication-receipt.v1" as const;
const OPERATION = "branch_adjudication" as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ABBREVIATED_SHA_PATTERN = /^[0-9a-f]{4,64}$/;
const MAX_ROWS = 100;

export type BranchAdjudicationErrorCode =
  | "INVALID_REQUEST"
  | "PLAN_HASH_REQUIRED"
  | "PLAN_HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "ROW_NOT_FOUND"
  | "ROW_MISMATCH"
  | "REPO_NOT_FOUND"
  | "STALE_REPO_ROW"
  | "DUPLICATE_LOCAL_ROW"
  | "EVIDENCE_REF_MISMATCH"
  | "TARGET_NOT_GIT_CHECKOUT"
  | "TRANSACTION_CONFLICT";

export class BranchAdjudicationError extends Error {
  constructor(
    public readonly code: BranchAdjudicationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BranchAdjudicationError";
  }
}

export interface BranchAdjudicationRowSpec {
  id: number;
  repoId: number;
  name: string;
  action: "reclassify-local";
  expectedIsRemote?: number | boolean;
  expectedLastCommitSha: string;
  expectedRepoRevision?: string;
  evidenceRepoPath: string;
  /**
   * Exact ref that proves the stored commit is present. Defaults to
   * `refs/heads/<name>`. Legacy-source rows may intentionally use a preserved
   * evidence ref such as `refs/heads/legacy-preserved/<name>` while the row
   * itself remains named `<name>` for relocation's preservation logic.
   */
  evidenceRef?: string;
}

export interface BranchAdjudicationRequest {
  rows: BranchAdjudicationRowSpec[];
  actor: string;
  idempotencyKey: string;
  apply?: boolean;
  expectedPlanHash?: string;
  databasePath?: string;
}

export interface BranchAdjudicationPlannedRow {
  id: number;
  repo_id: number;
  name: string;
  action: "reclassify-local";
  before: {
    is_remote: number;
    last_commit_sha: string;
    ahead: number;
    behind: number;
  };
  after: {
    is_remote: 0;
    last_commit_sha: string;
    ahead: 0;
    behind: 0;
  };
  repo: {
    path: string;
    updated_at: string;
  };
  evidence: {
    repo_path: string;
    ref: string;
    expected_commit: string;
    actual_commit: string;
  };
}

export interface BranchAdjudicationReceipt {
  schema: typeof AUDIT_SCHEMA;
  id: string;
  idempotency_key: string;
  request_hash: string;
  plan_hash: string;
  operation: typeof OPERATION;
  actor: string;
  row_count: number;
  before: BranchAdjudicationPlannedRow[];
  after: BranchAdjudicationPlannedRow[];
  rows: BranchAdjudicationPlannedRow[];
  created_at: string;
}

export interface BranchAdjudicationResult {
  schema: typeof SCHEMA;
  ok: true;
  applied: boolean;
  replayed: boolean;
  plan: {
    request_hash: string;
    plan_hash: string;
    can_apply: boolean;
    rows: BranchAdjudicationPlannedRow[];
  };
  receipt: BranchAdjudicationReceipt | null;
}

interface BranchRow {
  id: number;
  repo_id: number;
  name: string;
  is_remote: number;
  last_commit_sha: string | null;
  ahead: number;
  behind: number;
}

interface RepoRow {
  id: number;
  path: string;
  updated_at: string;
}

interface AuditRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  plan_hash: string;
  operation: string;
  actor: string;
  row_count: number;
  before_json: string;
  after_json: string;
  rows_json: string;
  created_at: string;
}

interface ValidatedRowSpec {
  id: number;
  repoId: number;
  name: string;
  action: "reclassify-local";
  expectedIsRemote: 1;
  expectedLastCommitSha: string;
  expectedRepoRevision?: string;
  evidenceRepoPath: string;
  evidenceRef: string;
}

interface ValidatedRequest {
  rows: ValidatedRowSpec[];
  actor: string;
  idempotencyKey: string;
  apply: boolean;
  expectedPlanHash?: string;
  requestHash: string;
  databasePath?: string;
}

interface BranchAdjudicationPlan {
  requestHash: string;
  planHash: string;
  rows: BranchAdjudicationPlannedRow[];
}

let adjudicationDbContext: Database | null = null;
let gitEnvironmentForTests: Record<string, string | undefined> | null = null;

function adjudicationDb(): Database {
  return adjudicationDbContext ?? getDb();
}

/** Test seam intentionally omitted from the package root export. */
export function setBranchAdjudicationGitEnvironmentForTests(env: Record<string, string | undefined> | null): void {
  gitEnvironmentForTests = env;
}

function fail(
  code: BranchAdjudicationErrorCode,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new BranchAdjudicationError(
    code,
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function normalizeKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_KEY_PATTERN.test(value)) {
    fail("INVALID_REQUEST", `${label} must be a stable non-empty key`);
  }
  return value;
}

function normalizeSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !ABBREVIATED_SHA_PATTERN.test(value.toLowerCase())) {
    fail("INVALID_REQUEST", `${label} must be a lowercase hexadecimal commit prefix`);
  }
  return value.toLowerCase();
}

function normalizeAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) {
    fail("INVALID_REQUEST", `${label} must be a non-empty absolute path`);
  }
  return value;
}

function normalizeRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail("INVALID_REQUEST", `${label} must be a non-empty ref`);
  }
  if (!value.startsWith("refs/heads/")) {
    fail("INVALID_REQUEST", `${label} must be an exact refs/heads/* ref`);
  }
  return value;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail("INVALID_REQUEST", "branch name must be non-empty and single-line");
  }
  return value;
}

function parseBooleanRemote(value: unknown): 1 {
  if (value === undefined || value === true || value === 1) return 1;
  fail("INVALID_REQUEST", "reclassify-local requires expected_is_remote=1");
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail("INVALID_REQUEST", `${label} must be a positive integer`);
  }
  return value;
}

function validateRequest(request: BranchAdjudicationRequest): ValidatedRequest {
  const actor = normalizeKey(request.actor, "actor");
  const idempotencyKey = normalizeKey(request.idempotencyKey, "idempotency key");
  if (!Array.isArray(request.rows) || request.rows.length === 0 || request.rows.length > MAX_ROWS) {
    fail("INVALID_REQUEST", `rows must contain 1-${MAX_ROWS} entries`);
  }
  const seen = new Set<number>();
  const rows = request.rows.map((row, index): ValidatedRowSpec => {
    if (!row || typeof row !== "object") fail("INVALID_REQUEST", `row ${index} must be an object`);
    if (row.action !== "reclassify-local") fail("INVALID_REQUEST", `row ${index} action must be reclassify-local`);
    const id = normalizePositiveInteger(row.id, `row ${index} id`);
    if (seen.has(id)) fail("INVALID_REQUEST", `row ${id} is duplicated`);
    seen.add(id);
    const name = normalizeName(row.name);
    const expectedRepoRevision = row.expectedRepoRevision;
    if (expectedRepoRevision !== undefined && (typeof expectedRepoRevision !== "string" || expectedRepoRevision.length === 0)) {
      fail("INVALID_REQUEST", `row ${id} expected repo revision must be non-empty when supplied`);
    }
    return {
      id,
      repoId: normalizePositiveInteger(row.repoId, `row ${index} repo id`),
      name,
      action: "reclassify-local",
      expectedIsRemote: parseBooleanRemote(row.expectedIsRemote),
      expectedLastCommitSha: normalizeSha(row.expectedLastCommitSha, `row ${id} expected last commit sha`),
      expectedRepoRevision,
      evidenceRepoPath: normalizeAbsolutePath(row.evidenceRepoPath, `row ${id} evidence repo path`),
      evidenceRef: normalizeRef(row.evidenceRef ?? `refs/heads/${name}`, `row ${id} evidence ref`),
    };
  }).sort((left, right) => left.id - right.id);
  const requestEnvelope = {
    operation: OPERATION,
    actor,
    idempotency_key: idempotencyKey,
    rows: rows.map((row) => ({
      id: row.id,
      repo_id: row.repoId,
      name: row.name,
      action: row.action,
      expected_is_remote: row.expectedIsRemote,
      expected_last_commit_sha: row.expectedLastCommitSha,
      expected_repo_revision: row.expectedRepoRevision ?? null,
      evidence_repo_path: row.evidenceRepoPath,
      evidence_ref: row.evidenceRef,
    })),
  };
  if (request.apply) {
    if (!request.expectedPlanHash) fail("PLAN_HASH_REQUIRED", "apply requires the exact reviewed dry-run plan hash");
    if (!HASH_PATTERN.test(request.expectedPlanHash)) fail("INVALID_REQUEST", "expected plan hash must be a lowercase sha256 digest");
  }
  return {
    rows,
    actor,
    idempotencyKey,
    apply: Boolean(request.apply),
    expectedPlanHash: request.expectedPlanHash,
    requestHash: hash(requestEnvelope),
    databasePath: request.databasePath,
  };
}

function runGit(
  path: string,
  args: string[],
  code: BranchAdjudicationErrorCode = "TARGET_NOT_GIT_CHECKOUT",
  message = "evidence repo path is not a readable Git checkout",
  details?: Record<string, unknown>,
): string {
  const env = Object.fromEntries(
    Object.entries(gitEnvironmentForTests ?? process.env)
      .filter(([key, value]) => !/^GIT_/i.test(key) && value !== undefined),
  ) as Record<string, string>;
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    return execFileSync("git", [
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      "-c", `core.excludesFile=${nullDevice}`,
      "-c", `core.hooksPath=${nullDevice}`,
      "-c", "protocol.allow=never",
      "-C", path,
      ...args,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...env,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  } catch (cause) {
    fail(code, message, details, cause);
  }
}

function resolveEvidenceCommit(spec: ValidatedRowSpec): string {
  runGit(
    spec.evidenceRepoPath,
    ["check-ref-format", spec.evidenceRef],
    "EVIDENCE_REF_MISMATCH",
    "evidence ref is not an exact Git ref name",
    { row_id: spec.id, evidence_ref: spec.evidenceRef },
  );
  const actual = runGit(
    spec.evidenceRepoPath,
    ["show-ref", "--verify", "--hash", spec.evidenceRef],
    "EVIDENCE_REF_MISMATCH",
    "evidence ref does not exist as an exact ref",
    { row_id: spec.id, evidence_ref: spec.evidenceRef },
  ).toLowerCase();
  const objectType = runGit(
    spec.evidenceRepoPath,
    ["cat-file", "-t", actual],
    "EVIDENCE_REF_MISMATCH",
    "evidence ref object is unreadable",
    { row_id: spec.id, evidence_ref: spec.evidenceRef, actual_commit: actual },
  );
  if (objectType !== "commit") {
    fail("EVIDENCE_REF_MISMATCH", "evidence ref does not point at a commit", {
      row_id: spec.id,
      evidence_ref: spec.evidenceRef,
      actual_commit: actual,
      object_type: objectType,
    });
  }
  const candidates = runGit(
    spec.evidenceRepoPath,
    ["rev-parse", `--disambiguate=${spec.expectedLastCommitSha}`],
    "EVIDENCE_REF_MISMATCH",
    "stored commit prefix cannot be resolved",
    { row_id: spec.id, expected_last_commit_sha: spec.expectedLastCommitSha },
  ).split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
  if (candidates.length !== 1 || candidates[0] !== actual) {
    fail("EVIDENCE_REF_MISMATCH", "evidence ref does not resolve to the expected stored commit", {
      row_id: spec.id,
      expected_last_commit_sha: spec.expectedLastCommitSha,
      evidence_ref: spec.evidenceRef,
      actual_commit: actual,
      matching_objects: candidates.length,
    });
  }
  return actual;
}

function getBranchRow(id: number): BranchRow | null {
  return adjudicationDb().query("SELECT * FROM branches WHERE id = ?").get(id) as BranchRow | null;
}

function getRepoRow(id: number): RepoRow | null {
  return adjudicationDb().query("SELECT id, path, updated_at FROM repos WHERE id = ?").get(id) as RepoRow | null;
}

function duplicateLocalRow(spec: ValidatedRowSpec): BranchRow | null {
  return adjudicationDb().query(`
    SELECT * FROM branches
    WHERE repo_id = ? AND name = ? AND is_remote = 0 AND id != ?
  `).get(spec.repoId, spec.name, spec.id) as BranchRow | null;
}

function buildPlan(request: ValidatedRequest): BranchAdjudicationPlan {
  const plannedRows: BranchAdjudicationPlannedRow[] = [];
  for (const spec of request.rows) {
    const repo = getRepoRow(spec.repoId);
    if (!repo) fail("REPO_NOT_FOUND", "repo row not found", { repo_id: spec.repoId, row_id: spec.id });
    if (spec.expectedRepoRevision !== undefined && repo.updated_at !== spec.expectedRepoRevision) {
      fail("STALE_REPO_ROW", "repo row revision changed", {
        repo_id: spec.repoId,
        row_id: spec.id,
        expected_repo_revision: spec.expectedRepoRevision,
        actual_repo_revision: repo.updated_at,
      });
    }
    const row = getBranchRow(spec.id);
    if (!row) fail("ROW_NOT_FOUND", "branch row not found", { row_id: spec.id });
    const actualSha = String(row.last_commit_sha ?? "").toLowerCase();
    const mismatches: Record<string, unknown> = {};
    if (row.repo_id !== spec.repoId) mismatches["repo_id"] = row.repo_id;
    if (row.name !== spec.name) mismatches["name"] = row.name;
    if (row.is_remote !== spec.expectedIsRemote) mismatches["is_remote"] = row.is_remote;
    if (actualSha !== spec.expectedLastCommitSha) mismatches["last_commit_sha"] = actualSha;
    if (Object.keys(mismatches).length > 0) {
      fail("ROW_MISMATCH", "branch row does not match exact guarded input", { row_id: spec.id, mismatches });
    }
    const duplicate = duplicateLocalRow(spec);
    if (duplicate) {
      fail("DUPLICATE_LOCAL_ROW", "a local branch row already exists for this repo/name", {
        row_id: spec.id,
        duplicate_row_id: duplicate.id,
        repo_id: spec.repoId,
        name: spec.name,
      });
    }
    const evidenceCommit = resolveEvidenceCommit(spec);
    plannedRows.push({
      id: row.id,
      repo_id: row.repo_id,
      name: row.name,
      action: "reclassify-local",
      before: { is_remote: row.is_remote, last_commit_sha: actualSha, ahead: row.ahead, behind: row.behind },
      after: { is_remote: 0, last_commit_sha: actualSha, ahead: 0, behind: 0 },
      repo: { path: repo.path, updated_at: repo.updated_at },
      evidence: {
        repo_path: spec.evidenceRepoPath,
        ref: spec.evidenceRef,
        expected_commit: spec.expectedLastCommitSha,
        actual_commit: evidenceCommit,
      },
    });
  }
  return {
    requestHash: request.requestHash,
    planHash: hash({ operation: OPERATION, request_hash: request.requestHash, rows: plannedRows }),
    rows: plannedRows,
  };
}

function receiptFromAudit(row: AuditRow): BranchAdjudicationReceipt {
  return {
    schema: AUDIT_SCHEMA,
    id: row.id,
    idempotency_key: row.idempotency_key,
    request_hash: row.request_hash,
    plan_hash: row.plan_hash,
    operation: OPERATION,
    actor: row.actor,
    row_count: row.row_count,
    before: JSON.parse(row.before_json) as BranchAdjudicationPlannedRow[],
    after: JSON.parse(row.after_json) as BranchAdjudicationPlannedRow[],
    rows: JSON.parse(row.rows_json) as BranchAdjudicationPlannedRow[],
    created_at: row.created_at,
  };
}

function existingAudit(idempotencyKey: string): AuditRow | null {
  const hasTable = adjudicationDb().query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branch_adjudication_audit'",
  ).get();
  if (!hasTable) return null;
  return adjudicationDb().query("SELECT * FROM branch_adjudication_audit WHERE idempotency_key = ?").get(idempotencyKey) as AuditRow | null;
}

function existingIdempotentResult(request: ValidatedRequest): BranchAdjudicationResult | null {
  const row = existingAudit(request.idempotencyKey);
  if (!row) return null;
  if (row.request_hash !== request.requestHash || row.plan_hash !== request.expectedPlanHash) {
    fail("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different branch adjudication", {
      idempotency_key: request.idempotencyKey,
    });
  }
  const receipt = receiptFromAudit(row);
  return {
    schema: SCHEMA,
    ok: true,
    applied: true,
    replayed: true,
    plan: { request_hash: row.request_hash, plan_hash: row.plan_hash, can_apply: true, rows: receipt.rows },
    receipt,
  };
}

export function adjudicateBranches(request: BranchAdjudicationRequest): BranchAdjudicationResult {
  const validated = validateRequest(request);
  if (validated.apply) {
    const db = getDb(validated.databasePath);
    adjudicationDbContext = db;
    try {
      const replay = existingIdempotentResult(validated);
      if (replay) return replay;
    } finally {
      adjudicationDbContext = null;
    }
  }

  const planningContext = validated.apply ? null : openNonMigratingDb(validated.databasePath);
  if (planningContext) adjudicationDbContext = planningContext.db;
  let plan: BranchAdjudicationPlan;
  try {
    plan = buildPlan(validated);
  } finally {
    adjudicationDbContext = null;
    planningContext?.close();
  }

  if (!validated.apply) {
    return {
      schema: SCHEMA,
      ok: true,
      applied: false,
      replayed: false,
      plan: { request_hash: plan.requestHash, plan_hash: plan.planHash, can_apply: true, rows: plan.rows },
      receipt: null,
    };
  }

  if (validated.expectedPlanHash !== plan.planHash) {
    fail("PLAN_HASH_MISMATCH", "live branch adjudication plan differs from the reviewed dry-run plan", {
      expected_plan_hash: validated.expectedPlanHash,
      actual_plan_hash: plan.planHash,
    });
  }

  const db = getDb(validated.databasePath);
  adjudicationDbContext = db;
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const replay = existingIdempotentResult(validated);
    if (replay) {
      db.exec("COMMIT");
      return replay;
    }
    const currentPlan = buildPlan(validated);
    if (currentPlan.planHash !== plan.planHash || currentPlan.planHash !== validated.expectedPlanHash) {
      fail("PLAN_HASH_MISMATCH", "registry state changed after dry-run review", {
        expected_plan_hash: validated.expectedPlanHash,
        actual_plan_hash: currentPlan.planHash,
      });
    }
    const update = db.query(`
      UPDATE branches
      SET is_remote = 0, ahead = 0, behind = 0
      WHERE id = ? AND repo_id = ? AND name = ? AND is_remote = 1 AND last_commit_sha = ?
    `);
    for (const row of currentPlan.rows) {
      const result = update.run(row.id, row.repo_id, row.name, row.before.last_commit_sha);
      if (result.changes !== 1) fail("TRANSACTION_CONFLICT", "exact branch row update failed", { row_id: row.id });
    }
    const afterRows = currentPlan.rows.map((row) => {
      const updated = getBranchRow(row.id);
      if (
        !updated
        || updated.repo_id !== row.repo_id
        || updated.name !== row.name
        || updated.is_remote !== 0
        || String(updated.last_commit_sha ?? "").toLowerCase() !== row.before.last_commit_sha
        || updated.ahead !== 0
        || updated.behind !== 0
      ) {
        fail("TRANSACTION_CONFLICT", "exact branch row verification failed", { row_id: row.id });
      }
      return {
        ...row,
        after: {
          is_remote: 0 as const,
          last_commit_sha: String(updated.last_commit_sha ?? "").toLowerCase(),
          ahead: 0 as const,
          behind: 0 as const,
        },
      };
    });
    const createdAt = new Date().toISOString();
    const receipt: BranchAdjudicationReceipt = {
      schema: AUDIT_SCHEMA,
      id: randomUUID(),
      idempotency_key: validated.idempotencyKey,
      request_hash: validated.requestHash,
      plan_hash: currentPlan.planHash,
      operation: OPERATION,
      actor: validated.actor,
      row_count: currentPlan.rows.length,
      before: currentPlan.rows,
      after: afterRows,
      rows: currentPlan.rows,
      created_at: createdAt,
    };
    db.query(`
      INSERT INTO branch_adjudication_audit (
        id, idempotency_key, request_hash, plan_hash, operation, actor,
        row_count, before_json, after_json, rows_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.idempotency_key,
      receipt.request_hash,
      receipt.plan_hash,
      receipt.operation,
      receipt.actor,
      receipt.row_count,
      JSON.stringify(receipt.before),
      JSON.stringify(receipt.after),
      JSON.stringify(receipt.rows),
      receipt.created_at,
    );
    db.exec("COMMIT");
    began = false;
    return {
      schema: SCHEMA,
      ok: true,
      applied: true,
      replayed: false,
      plan: { request_hash: currentPlan.requestHash, plan_hash: currentPlan.planHash, can_apply: true, rows: currentPlan.rows },
      receipt,
    };
  } catch (error) {
    if (began) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    }
    if (error instanceof BranchAdjudicationError) throw error;
    fail("TRANSACTION_CONFLICT", "branch adjudication failed", undefined, error);
  } finally {
    adjudicationDbContext = null;
  }
}
