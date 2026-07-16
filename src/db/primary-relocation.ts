import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDb, openNonMigratingDb } from "./database.js";
import { sanitizeGitRemoteUrl } from "../lib/remote-identity.js";
import type { Repo } from "../types/index.js";

export { sanitizeGitRemoteUrl } from "../lib/remote-identity.js";

const SCHEMA = "open-repos.primary-relocation.v2" as const;
// The receipt payload remains v6. Migration 7 changes only the storage FK so
// exact replays of already-issued receipts are not silently re-labelled.
const AUDIT_SCHEMA = "open-repos.primary-relocation-receipt.v6" as const;
const OPERATION = "primary_relocation" as const;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ABBREVIATED_SHA_PATTERN = /^[0-9a-f]{4,64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const BRANCH_PRESERVATION_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;
const MAX_PRESERVED_DIVERGENT_BRANCHES = 100;
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 10_000;
export const FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS = 120_000;

const CHILD_TABLES = [
  { table: "commits", key: ["sha"] },
  { table: "branches", key: ["name"] },
  { table: "tags", key: ["name"] },
  { table: "remotes", key: ["name"] },
  { table: "pull_requests", key: ["number"] },
] as const;

const KNOWN_REPO_FK_TABLES = new Set([
  ...CHILD_TABLES.map(({ table }) => table),
  "worktree_leases",
]);

export type PrimaryRelocationErrorCode =
  | "INVALID_REQUEST"
  | "REPO_NOT_FOUND"
  | "STALE_LEGACY_ROW"
  | "STALE_TARGET_ROW"
  | "REPO_ID_CONFLICT"
  | "REMOTE_MISMATCH"
  | "TARGET_MISSING"
  | "TARGET_NOT_CANONICAL"
  | "TARGET_OUTSIDE_ROOT"
  | "TARGET_UNTRUSTED_GIT_AUTHORITY"
  | "TRUSTED_HOME_UNAVAILABLE"
  | "TARGET_NOT_GIT_CHECKOUT"
  | "TARGET_DIRTY"
  | "HEAD_MISMATCH"
  | "THIRD_PATH_ALIAS"
  | "DIVERGENT_COLLISION"
  | "WORKTREE_LEASE_CONFLICT"
  | "UNKNOWN_REPO_FOREIGN_KEY"
  | "PLAN_HASH_REQUIRED"
  | "PLAN_HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "TRANSACTION_CONFLICT";

export interface SafeErrorDetails {
  collisions?: CollisionDecision[];
  tables?: string[];
  expected_plan_hash?: string;
  actual_plan_hash?: string;
}

export class PrimaryRelocationError extends Error {
  constructor(
    public readonly code: PrimaryRelocationErrorCode,
    message: string,
    public readonly details?: SafeErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrimaryRelocationError";
  }
}

export interface PrimaryRelocationRequest {
  repoId: number;
  expectedCurrentPath: string;
  expectedSourceRevision: string;
  targetRepoId: number;
  targetPath: string;
  expectedTargetRevision: string;
  expectedRemote: string;
  expectedHead: string;
  actor: string;
  idempotencyKey: string;
  apply?: boolean;
  expectedPlanHash?: string;
  /**
   * Explicit operator-supplied namespace for preserving divergent legacy
   * branches as `<namespace>/<branch>` while moving the canonical target branch
   * under its original name. The target checkout must already contain exact
   * refs for both names; relocation never creates Git refs.
   */
  preserveDivergentBranchesUnder?: string;
  /** Exact registry path used for a hermetic, read-only dry run. */
  databasePath?: string;
}

export interface CollisionDecision {
  table: string;
  key_hash: string;
  source_hash: string | null;
  target_hash: string;
  decision: "move" | "dedupe" | "block" | "preserve";
  preserved_name_hash?: string;
  preserved_ref_hash?: string;
  target_ref_hash?: string;
}

export interface TableReconcileCounts {
  legacy: number;
  target: number;
  move: number;
  dedupe: number;
  block: number;
}

export interface PrimaryRelocationReceipt {
  schema: typeof AUDIT_SCHEMA;
  id: string;
  idempotency_key: string;
  request_hash: string;
  plan_hash: string;
  repo_id: number;
  target_repo_id: number;
  operation: typeof OPERATION;
  actor: string;
  expected_current_path: string;
  target_path: string;
  expected_remote: string;
  expected_head: string;
  source_revision: string;
  target_revision: string;
  source: Repo;
  target: Repo;
  after: Repo;
  counts: Record<string, TableReconcileCounts>;
  collisions: CollisionDecision[];
  created_at: string;
}

export interface PrimaryRelocationResult {
  schema: typeof SCHEMA;
  ok: true;
  applied: boolean;
  replayed: boolean;
  repo_id: number;
  target_repo_id: number;
  before: Repo;
  target: Repo;
  after: Repo;
  plan: {
    request_hash: string;
    plan_hash: string;
    can_apply: boolean;
    counts: Record<string, TableReconcileCounts>;
    collisions: CollisionDecision[];
  };
  receipt: PrimaryRelocationReceipt | null;
}

interface ValidatedRequest {
  legacyRepoId: number;
  legacyPath: string;
  legacyRevision: string;
  targetRepoId: number;
  targetPath: string;
  targetRevision: string;
  remote: string;
  head: string;
  actor: string;
  idempotencyKey: string;
  expectedPlanHash?: string;
  preserveDivergentBranchesUnder?: string;
  apply: boolean;
  canonicalRoot: string;
  requestHash: string;
}

interface InternalDecision extends CollisionDecision {
  row_id: number;
  preserved_name?: string;
  resolved_last_commit_sha?: string;
}

interface StoredBranchCommitResolution {
  raw: string;
  resolved: string | null;
  status: "ok" | "invalid" | "missing" | "ambiguous" | "non_commit";
  candidate_count: number;
}

interface BranchRefResolution {
  ref: string | null;
  commit: string | null;
  status: "ok" | "invalid" | "missing" | "ambiguous";
  local_ref: string | null;
  local_commit: string | null;
  remote_ref: string | null;
  remote_commit: string | null;
}

interface ReconcilePlan {
  sourceRow: Repo;
  targetRow: Repo;
  after: Repo;
  counts: Record<string, TableReconcileCounts>;
  collisions: CollisionDecision[];
  decisions: InternalDecision[];
  tableDigests: Record<string, string>;
  leaseCount: number;
  canApply: boolean;
  planHash: string;
}

let canonicalRootForTests: string | null = null;
let relocationDbContext: Database | null = null;

function relocationDb(): Database {
  return relocationDbContext ?? getDb();
}

/** Test seam intentionally omitted from the package root export. */
export function setPrimaryRelocationCanonicalRootForTests(root: string | null): void {
  canonicalRootForTests = root;
}

function fail(
  code: PrimaryRelocationErrorCode,
  message: string,
  details?: SafeErrorDetails,
  cause?: unknown,
): never {
  throw new PrimaryRelocationError(
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

function earliestTimestamp(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime <= rightTime ? left : right;
  }
  return left <= right ? left : right;
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    fail("INVALID_REQUEST", `${label} must be a non-empty absolute path`);
  }
  const normalized = resolve(path);
  if (normalized !== path) fail("INVALID_REQUEST", `${label} must already be canonical`);
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sanitizeCheckoutRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  const isNetworkUrl = trimmed.includes("://");
  const isScpSsh = /^(?:[^@/:]+@)?[^/:]+:.+$/.test(trimmed);
  return isNetworkUrl || isScpSsh ? sanitizeGitRemoteUrl(trimmed) || "" : "";
}

function canonicalRoot(): string {
  return normalizeAbsolutePath(
    canonicalRootForTests || join(trustedAccountHome(), ".hasna", "repos", "worktrees"),
    "canonical worktree root",
  );
}

function isValidHeadRefName(name: string): boolean {
  if (!name || name.includes("\0") || name.startsWith("/") || name.endsWith("/")) return false;
  try {
    execFileSync("git", ["check-ref-format", `refs/heads/${name}`], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function validateBranchPreservationNamespace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const namespace = value.trim();
  if (
    !BRANCH_PRESERVATION_NAMESPACE_PATTERN.test(namespace)
    || namespace.startsWith("refs/")
    || namespace.includes("//")
    || namespace.endsWith("/")
    || !isValidHeadRefName(`${namespace}/__repos_preservation_probe__`)
  ) {
    fail("INVALID_REQUEST", "branch preservation namespace is not a safe Git branch namespace");
  }
  return namespace;
}

function trustedAccountHome(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && process.platform !== "win32") {
    try {
      const entry = readFileSync("/etc/passwd", "utf8")
        .split("\n")
        .map((line) => line.split(":"))
        .find((fields) => Number(fields[2]) === uid);
      const home = entry?.[5];
      if (home && isAbsolute(home)) return resolve(home);
    } catch {
      // macOS commonly keeps directory-service users out of /etc/passwd.
    }
    if (process.platform === "darwin") {
      try {
        const output = execFileSync("dscacheutil", ["-q", "user", "-a", "uid", String(uid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        const home = output.match(/^dir:\s*(\S.+)$/m)?.[1]?.trim();
        if (home && isAbsolute(home)) return resolve(home);
      } catch {
        try {
          const username = execFileSync("id", ["-nu", String(uid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5_000,
          }).trim();
          const output = execFileSync("dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5_000,
          });
          const home = output.match(/^NFSHomeDirectory:\s*(\S.+)$/m)?.[1]?.trim();
          if (home && isAbsolute(home)) return resolve(home);
        } catch {
          // Fail closed below rather than trusting process environment state.
        }
      }
    }
    fail(
      "TRUSTED_HOME_UNAVAILABLE",
      "trusted account home could not be resolved from the operating system account database",
    );
  }
  return resolve(userInfo().homedir);
}

function validateRequest(request: PrimaryRelocationRequest): ValidatedRequest {
  for (const [label, value] of [
    ["legacy repo ID", request.repoId],
    ["target repo ID", request.targetRepoId],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_REQUEST", `${label} must be positive`);
  }
  if (request.repoId === request.targetRepoId) fail("REPO_ID_CONFLICT", "legacy and target repo IDs must differ");
  const actor = request.actor.trim();
  const idempotencyKey = request.idempotencyKey.trim();
  if (!SAFE_KEY_PATTERN.test(actor)) fail("INVALID_REQUEST", "actor is not a safe audit identity");
  if (!SAFE_KEY_PATTERN.test(idempotencyKey)) fail("INVALID_REQUEST", "idempotency key is not safe");
  const head = request.expectedHead.trim();
  if (!SHA_PATTERN.test(head)) fail("INVALID_REQUEST", "expected HEAD must be an exact lowercase object ID");
  const remote = sanitizeGitRemoteUrl(request.expectedRemote);
  if (!remote || remote !== request.expectedRemote) fail("INVALID_REQUEST", "expected remote must be sanitized host/owner/name");
  const expectedPlanHash = request.expectedPlanHash?.trim();
  if (request.apply && (!expectedPlanHash || !HASH_PATTERN.test(expectedPlanHash))) {
    fail("PLAN_HASH_REQUIRED", "apply requires the exact reviewed dry-run plan hash");
  }
  const preserveDivergentBranchesUnder = validateBranchPreservationNamespace(
    request.preserveDivergentBranchesUnder,
  );
  const base = {
    legacyRepoId: request.repoId,
    legacyPath: normalizeAbsolutePath(request.expectedCurrentPath, "expected legacy path"),
    legacyRevision: request.expectedSourceRevision,
    targetRepoId: request.targetRepoId,
    targetPath: normalizeAbsolutePath(request.targetPath, "expected target path"),
    targetRevision: request.expectedTargetRevision,
    remote,
    head,
    actor,
    idempotencyKey,
  };
  const requestEnvelope = preserveDivergentBranchesUnder
    ? { ...base, branch_preservation: { namespace: preserveDivergentBranchesUnder } }
    : base;
  if (!base.legacyRevision || !base.targetRevision) fail("INVALID_REQUEST", "both row revisions are required");
  if (base.legacyPath === base.targetPath) fail("INVALID_REQUEST", "legacy and target paths must differ");
  return {
    ...base,
    expectedPlanHash,
    preserveDivergentBranchesUnder,
    apply: Boolean(request.apply),
    canonicalRoot: canonicalRoot(),
    requestHash: hash(requestEnvelope),
  };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(table: string): boolean {
  return Boolean(relocationDb().query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function getRepo(id: number): Repo | null {
  return relocationDb().query("SELECT * FROM repos WHERE id = ?").get(id) as Repo | null;
}

function safeRepo(repo: Repo): Repo {
  return {
    ...repo,
    remote_url: sanitizeGitRemoteUrl(repo.remote_url || "") || null,
    description: null,
  };
}

function gitExecutionOptions(path: string, args: string[], timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => !/^GIT_/i.test(key) && value !== undefined),
  ) as Record<string, string>;
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    cmd: [
      "-c", "core.fsmonitor=false",
      // Repository-local core.ignoreCase must not fold distinct filesystem
      // entries while inventorying a target. On case-insensitive filesystems
      // the colliding entry cannot exist independently; on case-sensitive
      // filesystems this forces Git to report it instead of hiding it behind a
      // tracked path with different casing.
      "-c", "core.ignoreCase=false",
      "-c", "core.untrackedCache=false",
      "-c", `core.excludesFile=${nullDevice}`,
      "-c", `core.hooksPath=${nullDevice}`,
      "-C", path,
      ...args,
    ],
    options: {
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...env,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  };
}

function runGitRaw(path: string, args: string[], timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS): Buffer {
  try {
    const { cmd, options } = gitExecutionOptions(path, args, timeoutMs);
    return execFileSync("git", cmd, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (cause) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target is not a readable Git checkout", undefined, cause);
  }
}

function tryRunGit(path: string, args: string[], timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS): string | null {
  try {
    const { cmd, options } = gitExecutionOptions(path, args, timeoutMs);
    return execFileSync("git", cmd, {
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).toString("utf8").trim();
  } catch {
    return null;
  }
}

function runGit(path: string, args: string[], timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS): string {
  return runGitRaw(path, args, timeoutMs).toString("utf8").trim();
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function reportedGitPath(path: string, args: string[], label: string): string {
  const reported = runGit(path, args);
  if (reported.includes("\n") || reported.includes("\r")) {
    fail("TARGET_NOT_GIT_CHECKOUT", `${label} is not a single absolute path`);
  }
  return normalizeAbsolutePath(reported, label);
}

function containedGitAuthorityPath(reported: string, root: string, label: string): string {
  if (!isWithin(root, reported)) {
    fail("TARGET_OUTSIDE_ROOT", `${label} is outside the trusted canonical root`);
  }
  try {
    const resolved = realpathSync(reported);
    if (!isWithin(root, resolved)) {
      fail("TARGET_OUTSIDE_ROOT", `${label} resolves outside the trusted canonical root`);
    }
    if (!statSync(resolved).isDirectory()) {
      fail("TARGET_NOT_GIT_CHECKOUT", `${label} is not a directory`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof PrimaryRelocationError) throw error;
    fail("TARGET_NOT_GIT_CHECKOUT", `${label} cannot be resolved safely`, undefined, error);
  }
}

function readAuthorityMetadata(path: string, label: string): Buffer | null {
  let expected: Stats;
  try {
    expected = lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    fail("TARGET_NOT_GIT_CHECKOUT", `${label} cannot be inspected safely`, undefined, error);
  }
  if (expected.isSymbolicLink()) {
    fail("TARGET_UNTRUSTED_GIT_AUTHORITY", `${label} cannot be a symbolic link`);
  }
  if (!expected.isFile() || (expected.mode & 0o444) === 0) {
    fail("TARGET_NOT_GIT_CHECKOUT", `${label} is not a readable regular file`);
  }

  let descriptor: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      fail("TARGET_NOT_GIT_CHECKOUT", `${label} changed during validation`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.mode !== after.mode
    ) fail("TARGET_NOT_GIT_CHECKOUT", `${label} changed during validation`);
    return content;
  } catch (error) {
    if (error instanceof PrimaryRelocationError) throw error;
    fail("TARGET_NOT_GIT_CHECKOUT", `${label} cannot be read safely`, undefined, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  throw new Error("unreachable");
}

function assertContainedAuthorityTree(path: string, root: string, label: string, required: boolean): void {
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let currentStat: Stats;
    try {
      currentStat = lstatSync(current);
    } catch (error) {
      if (!required && current === path && errnoCode(error) === "ENOENT") return;
      fail("TARGET_NOT_GIT_CHECKOUT", `${label} cannot be inspected safely`, undefined, error);
    }
    if (currentStat.isSymbolicLink()) {
      fail("TARGET_UNTRUSTED_GIT_AUTHORITY", `${label} cannot contain symbolic links`);
    }
    if (!isWithin(root, realpathSync(current))) {
      fail("TARGET_OUTSIDE_ROOT", `${label} resolves outside the trusted canonical root`);
    }
    if (currentStat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (error) {
        fail("TARGET_NOT_GIT_CHECKOUT", `${label} cannot be read safely`, undefined, error);
      }
      for (const entry of entries) pending.push(join(current, entry.name));
      continue;
    }
    if (!currentStat.isFile() || (currentStat.mode & 0o444) === 0) {
      fail("TARGET_NOT_GIT_CHECKOUT", `${label} contains an unreadable or unsupported entry`);
    }
  }
}

function assertSafeGitMetadataFiles(gitDir: string, common: string, root: string): void {
  if (!readAuthorityMetadata(join(common, "config"), "target common Git config")) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target common Git config is missing");
  }
  assertContainedAuthorityTree(join(common, "info"), root, "target common Git info", false);
  for (const [path, label] of [
    [join(gitDir, "HEAD"), "target Git HEAD"],
    [join(gitDir, "index"), "target Git index"],
    [join(gitDir, "commondir"), "target Git common-directory pointer"],
    [join(gitDir, "gitdir"), "target Git worktree pointer"],
    [join(gitDir, "config.worktree"), "target worktree Git config"],
    [join(common, "packed-refs"), "target packed refs"],
    [join(common, "info", "exclude"), "target Git exclude metadata"],
  ] as const) readAuthorityMetadata(path, label);
  assertContainedAuthorityTree(join(common, "refs"), root, "target Git refs", false);
}

function assertNoObjectAlternates(objects: string, root: string): void {
  const info = join(objects, "info");
  try {
    const infoStat = lstatSync(info);
    if (infoStat.isSymbolicLink() || !infoStat.isDirectory()) {
      fail("TARGET_NOT_GIT_CHECKOUT", "target object authority metadata directory is unsafe");
    }
    if (!isWithin(root, realpathSync(info))) {
      fail("TARGET_OUTSIDE_ROOT", "target object authority metadata resolves outside the trusted canonical root");
    }
  } catch (error) {
    if (error instanceof PrimaryRelocationError) throw error;
    if (errnoCode(error) === "ENOENT") return;
    fail("TARGET_NOT_GIT_CHECKOUT", "target object authority metadata cannot be inspected safely", undefined, error);
  }

  for (const name of ["alternates", "http-alternates"]) {
    const content = readAuthorityMetadata(join(info, name), `target object ${name} metadata`);
    if (content && content.length > 0) {
      fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target uses external Git object authority");
    }
  }
}

function assertCompleteLocalObjectGraph(path: string, common: string, objects: string): void {
  if (readAuthorityMetadata(join(common, "shallow"), "target shallow repository metadata") !== null) {
    fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target uses shallow Git history");
  }

  let packEntries: string[];
  try {
    packEntries = readdirSync(join(objects, "pack"));
  } catch (error) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target Git pack authority cannot be read safely", undefined, error);
  }
  if (packEntries.some((name) => name.endsWith(".promisor"))) {
    fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target uses promisor Git object authority");
  }

  // `fsck --full` inflates and hashes local loose and packed objects and walks
  // every ref-reachable commit/tree/blob edge. The sanitized Git environment
  // disables lazy fetches, inherited config, hooks, replacements and prompts;
  // object verification cannot run worktree conversion filters.
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  runGit(path, [
    "-c", `fsck.skipList=${nullDevice}`,
    "-c", `fetch.fsck.skipList=${nullDevice}`,
    "-c", `receive.fsck.skipList=${nullDevice}`,
    "fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", "--no-progress",
  ], FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS);
}

interface LocalConfigEntry {
  key: string;
  value: string;
}

function localConfigEntries(path: string, scope: "--local" | "--worktree"): LocalConfigEntry[] {
  return nulRecords(runGitRaw(path, ["config", scope, "--no-includes", "--null", "--list"]))
    .map((record) => {
      const separator = record.indexOf(0x0a);
      if (separator <= 0) fail("TARGET_NOT_GIT_CHECKOUT", "target local Git config is malformed");
      return {
        key: record.subarray(0, separator).toString("utf8").toLowerCase(),
        value: record.subarray(separator + 1).toString("utf8"),
      };
    });
}

function assertNoPromisorConfig(path: string): void {
  const local = localConfigEntries(path, "--local");
  const worktreeConfig = local.some(({ key, value }) => (
    key === "extensions.worktreeconfig"
    && ["", "1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  ));
  const entries = worktreeConfig ? [...local, ...localConfigEntries(path, "--worktree")] : local;
  for (const { key } of entries) {
    if (/^(?:fsck\.|fetch\.fsck\.|receive\.fsck\.)/.test(key)) {
      fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target local Git config overrides object verification policy");
    }
    if (
      key === "extensions.partialclone"
      || /^remote\..+\.promisor$/.test(key)
      || /^remote\..+\.partialclonefilter$/.test(key)
    ) fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target has repository-local partial-clone authority");
    if (key === "include.path" || /^includeif\..+\.path$/.test(key)) {
      fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target local Git config delegates to an external config authority");
    }
  }
}

function validateGitAuthority(path: string, root: string): void {
  const topLevel = containedGitAuthorityPath(
    reportedGitPath(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"], "target top-level"),
    root,
    "target top-level",
  );
  if (topLevel !== path) fail("TARGET_NOT_GIT_CHECKOUT", "target must be the checkout top-level");

  const gitDir = containedGitAuthorityPath(
    reportedGitPath(path, ["rev-parse", "--absolute-git-dir"], "target Git directory"),
    root,
    "target Git directory",
  );
  const common = containedGitAuthorityPath(
    reportedGitPath(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "target Git common directory"),
    root,
    "target Git common directory",
  );
  const objects = containedGitAuthorityPath(
    reportedGitPath(path, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], "target object directory"),
    root,
    "target object directory",
  );
  let expectedObjects: string;
  try {
    expectedObjects = realpathSync(join(common, "objects"));
  } catch (error) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target common object directory cannot be resolved safely", undefined, error);
  }
  if (objects !== expectedObjects) {
    fail("TARGET_UNTRUSTED_GIT_AUTHORITY", "target object authority differs from its Git common directory");
  }
  assertContainedAuthorityTree(objects, root, "target object authority", true);
  assertNoObjectAlternates(objects, root);
  assertSafeGitMetadataFiles(gitDir, common, root);
  assertNoPromisorConfig(path);
  assertCompleteLocalObjectGraph(path, common, objects);
}

interface GitInventoryEntry {
  mode: string;
  oid: string;
  path: Buffer;
}

function nulRecords(output: Buffer): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target Git inventory is not NUL terminated");
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function parseHeadInventory(output: Buffer): Map<string, GitInventoryEntry> {
  const entries = new Map<string, GitInventoryEntry>();
  for (const record of nulRecords(output)) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) {
      fail("TARGET_NOT_GIT_CHECKOUT", "target HEAD inventory is malformed");
    }
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
    if (!match) fail("TARGET_NOT_GIT_CHECKOUT", "target HEAD inventory is malformed");
    const path = Buffer.from(record.subarray(tab + 1));
    const key = path.toString("hex");
    if (entries.has(key)) fail("TARGET_NOT_GIT_CHECKOUT", "target HEAD has duplicate paths");
    entries.set(key, { mode: match[1]!, oid: match[3]!, path });
  }
  return entries;
}

function parseIndexInventory(output: Buffer): Map<string, GitInventoryEntry> {
  const entries = new Map<string, GitInventoryEntry>();
  for (const record of nulRecords(output)) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) {
      fail("TARGET_NOT_GIT_CHECKOUT", "target index inventory is malformed");
    }
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(header);
    if (!match) fail("TARGET_NOT_GIT_CHECKOUT", "target index inventory is malformed");
    if (match[3] !== "0") fail("TARGET_DIRTY", "target index contains unresolved entries");
    const path = Buffer.from(record.subarray(tab + 1));
    const key = path.toString("hex");
    if (entries.has(key)) fail("TARGET_DIRTY", "target index contains duplicate entries");
    entries.set(key, { mode: match[1]!, oid: match[2]!, path });
  }
  return entries;
}

function validateGitPath(path: Buffer): void {
  if (path.length === 0 || path[0] === 0x2f || path.includes(0) || path.includes(0x5c)) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target index contains an unsafe path");
  }
  for (const segment of path.toString("binary").split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git") {
      fail("TARGET_NOT_GIT_CHECKOUT", "target index contains an unsafe path");
    }
  }
}

function trackedPath(root: string, path: Buffer): Buffer {
  validateGitPath(path);
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), path]);
}

function assertTrackedParents(root: string, path: Buffer): void {
  const segments = path.toString("binary").split("/");
  let current = Buffer.from(root);
  for (const segment of segments.slice(0, -1)) {
    current = Buffer.concat([current, Buffer.from("/"), Buffer.from(segment, "binary")]);
    let parent;
    try {
      parent = lstatSync(current);
    } catch (cause) {
      fail("TARGET_DIRTY", "target checkout has a missing tracked parent", undefined, cause);
    }
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      fail("TARGET_DIRTY", "target checkout has an unsafe tracked parent");
    }
  }
}

function readRegularFile(path: Buffer, expected: Stats): Buffer {
  let descriptor: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      fail("TARGET_DIRTY", "target tracked file changed during validation");
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.mode !== after.mode
    ) fail("TARGET_DIRTY", "target tracked file changed during validation");
    return content;
  } catch (error) {
    if (error instanceof PrimaryRelocationError) throw error;
    fail("TARGET_DIRTY", "target tracked file cannot be read safely", undefined, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  throw new Error("unreachable");
}

function blobOid(content: Buffer, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat)
    .update(`blob ${content.length}\0`, "utf8")
    .update(content)
    .digest("hex");
}

function validateCleanCheckout(path: string): void {
  const objectFormat = runGit(path, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    fail("TARGET_NOT_GIT_CHECKOUT", "target uses an unsupported Git object format");
  }
  const headEntries = parseHeadInventory(runGitRaw(path, ["ls-tree", "--full-tree", "-r", "-z", "HEAD"]));
  const indexEntries = parseIndexInventory(runGitRaw(path, ["ls-files", "--stage", "-z"]));
  const supportedModes = new Set(["100644", "100755", "120000"]);

  if (headEntries.size !== indexEntries.size) fail("TARGET_DIRTY", "target index differs from HEAD");
  for (const [key, headEntry] of headEntries) {
    const indexEntry = indexEntries.get(key);
    if (
      !indexEntry
      || !supportedModes.has(headEntry.mode)
      || !supportedModes.has(indexEntry.mode)
      || headEntry.mode !== indexEntry.mode
      || headEntry.oid !== indexEntry.oid
    ) fail("TARGET_DIRTY", "target index differs from HEAD or contains an unsupported entry");
  }

  for (const entry of indexEntries.values()) {
    assertTrackedParents(path, entry.path);
    const worktreePath = trackedPath(path, entry.path);
    let worktreeStat;
    try {
      worktreeStat = lstatSync(worktreePath);
    } catch (cause) {
      fail("TARGET_DIRTY", "target checkout is missing a tracked entry", undefined, cause);
    }

    let content: Buffer;
    let worktreeMode: string;
    if (worktreeStat.isSymbolicLink()) {
      worktreeMode = "120000";
      content = readlinkSync(worktreePath, { encoding: "buffer" });
    } else if (worktreeStat.isFile()) {
      worktreeMode = (worktreeStat.mode & 0o111) === 0 ? "100644" : "100755";
      content = readRegularFile(worktreePath, worktreeStat);
    } else {
      fail("TARGET_DIRTY", "target checkout contains an unsupported tracked entry type");
    }
    if (worktreeMode !== entry.mode || blobOid(content, objectFormat) !== entry.oid) {
      fail("TARGET_DIRTY", "target tracked bytes or mode differ from the index");
    }
  }

  if (nulRecords(runGitRaw(path, ["ls-files", "--others", "--exclude-standard", "-z"])).length > 0) {
    fail("TARGET_DIRTY", "target checkout contains non-ignored untracked entries");
  }
}

function rawOriginUrl(path: string): string {
  const urls = runGit(path, [
    "config",
    "--local",
    "--no-includes",
    "--get-all",
    "remote.origin.url",
  ]).split("\n").map((url) => url.trim()).filter(Boolean);
  if (urls.length !== 1) fail("REMOTE_MISMATCH", "target must have exactly one raw origin URL");
  return urls[0]!;
}

function validateTarget(targetPath: string, root: string, remote: string, head: string): void {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) fail("TARGET_OUTSIDE_ROOT", "canonical root is unavailable");
    if (!existsSync(targetPath)) fail("TARGET_MISSING", "target checkout is missing");
    const targetStat = lstatSync(targetPath);
    if (targetStat.isSymbolicLink()) fail("TARGET_NOT_CANONICAL", "target path cannot be a symlink alias");
    if (!targetStat.isDirectory()) fail("TARGET_MISSING", "target checkout is not a directory");
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(targetPath);
    if (realTarget !== targetPath) fail("TARGET_NOT_CANONICAL", "target path cannot be a symlink alias");
    if (!isWithin(realRoot, realTarget)) fail("TARGET_OUTSIDE_ROOT", "target is outside the trusted canonical root");
    // Establish filesystem and object ownership before reading refs, objects, or
    // repository-controlled attributes. These plumbing calls cannot invoke
    // conversion filters, hooks, credential helpers, or lazy object fetches.
    validateGitAuthority(realTarget, realRoot);
    // Read the local config value directly: `remote get-url` applies url.*.insteadOf
    // rewrites and can make a different raw origin impersonate the expected one.
    if (sanitizeCheckoutRemoteUrl(rawOriginUrl(realTarget)) !== remote) {
      fail("REMOTE_MISMATCH", "target origin does not match the expected remote");
    }
    if (runGit(realTarget, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head) {
      fail("HEAD_MISMATCH", "target HEAD does not match the exact expected object ID");
    }
    validateCleanCheckout(realTarget);
  } catch (error) {
    if (error instanceof PrimaryRelocationError) throw error;
    fail("TARGET_NOT_GIT_CHECKOUT", "target cannot be inspected safely", undefined, error);
  }
}

function validateRows(request: ValidatedRequest, source: Repo, target: Repo): void {
  if (source.path !== request.legacyPath || source.updated_at !== request.legacyRevision) {
    fail("STALE_LEGACY_ROW", "legacy row path or revision changed");
  }
  if (target.path !== request.targetPath || target.updated_at !== request.targetRevision) {
    fail("STALE_TARGET_ROW", "target row path or revision changed");
  }
  if (
    sanitizeGitRemoteUrl(source.remote_url || "") !== request.remote
    || sanitizeGitRemoteUrl(target.remote_url || "") !== request.remote
  ) fail("REMOTE_MISMATCH", "both registry rows must match the expected sanitized remote");
}

function validateNoThirdAlias(request: ValidatedRequest): void {
  let targetReal = "";
  try { targetReal = realpathSync(request.targetPath); } catch { return; }
  const rows = relocationDb().query("SELECT id, path FROM repos WHERE id NOT IN (?, ?)").all(
    request.legacyRepoId,
    request.targetRepoId,
  ) as Array<{ id: number; path: string }>;
  for (const row of rows) {
    if (!row.path || !isAbsolute(row.path)) continue;
    const normalized = resolve(row.path);
    if (normalized === request.legacyPath || normalized === request.targetPath) {
      fail("THIRD_PATH_ALIAS", "a third registry row claims a relocation path");
    }
    try {
      if (existsSync(normalized) && realpathSync(normalized) === targetReal) {
        fail("THIRD_PATH_ALIAS", "a third registry row aliases the canonical target");
      }
    } catch (error) {
      if (error instanceof PrimaryRelocationError) throw error;
      fail("THIRD_PATH_ALIAS", "a third registry path cannot be checked safely", undefined, error);
    }
  }
}

function unknownRepoForeignKeys(): string[] {
  const tables = relocationDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const unknown: string[] = [];
  for (const { name } of tables) {
    const fks = relocationDb().query(`PRAGMA foreign_key_list(${quote(name)})`).all() as Array<{ table: string }>;
    if (fks.some((fk) => fk.table === "repos") && !KNOWN_REPO_FK_TABLES.has(name)) unknown.push(name);
  }
  return unknown.sort();
}

function rowWithout(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

function keyFor(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function exactRefCommit(path: string, ref: string): string | null {
  const commit = tryRunGit(path, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return commit && SHA_PATTERN.test(commit) ? commit : null;
}

function resolvePreservedBranchRef(path: string, branchName: string): BranchRefResolution {
  if (!isValidHeadRefName(branchName)) {
    return {
      ref: null,
      commit: null,
      status: "invalid",
      local_ref: null,
      local_commit: null,
      remote_ref: null,
      remote_commit: null,
    };
  }
  const ref = `refs/heads/${branchName}`;
  const commit = exactRefCommit(path, ref);
  return {
    ref,
    commit,
    status: commit ? "ok" : "missing",
    local_ref: ref,
    local_commit: commit,
    remote_ref: null,
    remote_commit: null,
  };
}

function resolveTargetBranchRef(path: string, branchName: string, isRemoteRow: boolean): BranchRefResolution {
  if (!isValidHeadRefName(branchName)) return resolvePreservedBranchRef(path, branchName);
  const localRef = `refs/heads/${branchName}`;
  const localCommit = exactRefCommit(path, localRef);
  const remoteOutput = tryRunGit(path, ["remote"]);
  if (remoteOutput === null) {
    return {
      ref: null,
      commit: null,
      status: "invalid",
      local_ref: localRef,
      local_commit: localCommit,
      remote_ref: null,
      remote_commit: null,
    };
  }
  const configuredRemotes = remoteOutput
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (isRemoteRow && configuredRemotes.includes(branchName)) {
    return {
      ref: null,
      commit: null,
      status: "invalid",
      local_ref: localRef,
      local_commit: localCommit,
      remote_ref: null,
      remote_commit: null,
    };
  }
  const configuredRemote = configuredRemotes.find((name) => branchName.startsWith(`${name}/`));
  if (!configuredRemote) {
    return {
      ref: localRef,
      commit: localCommit,
      status: localCommit ? "ok" : "missing",
      local_ref: localRef,
      local_commit: localCommit,
      remote_ref: null,
      remote_commit: null,
    };
  }

  const remoteRef = `refs/remotes/${branchName}`;
  const remoteCommit = exactRefCommit(path, remoteRef);
  const ambiguous = Boolean(localCommit && remoteCommit && localCommit !== remoteCommit);
  return {
    ref: remoteRef,
    commit: ambiguous ? null : remoteCommit,
    status: ambiguous ? "ambiguous" : remoteCommit ? "ok" : "missing",
    local_ref: localRef,
    local_commit: localCommit,
    remote_ref: remoteRef,
    remote_commit: remoteCommit,
  };
}

function resolveStoredBranchCommit(path: string, value: unknown): StoredBranchCommitResolution {
  const raw = String(value ?? "");
  const invalid = (status: StoredBranchCommitResolution["status"]): StoredBranchCommitResolution => ({
    raw,
    resolved: null,
    status,
    candidate_count: 0,
  });
  if (!ABBREVIATED_SHA_PATTERN.test(raw)) return invalid("invalid");

  const output = tryRunGit(path, ["rev-parse", `--disambiguate=${raw}`]);
  const candidates = Array.from(new Set(
    (output ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => SHA_PATTERN.test(line)),
  )).sort();
  if (candidates.length === 0) return invalid("missing");
  if (candidates.length > 1) {
    return {
      raw,
      resolved: null,
      status: "ambiguous",
      candidate_count: candidates.length,
    };
  }

  const objectType = tryRunGit(path, ["cat-file", "-t", candidates[0]!]);
  if (objectType !== "commit") {
    return {
      raw,
      resolved: null,
      status: "non_commit",
      candidate_count: 1,
    };
  }
  return {
    raw,
    resolved: candidates[0]!,
    status: "ok",
    candidate_count: 1,
  };
}

function targetRefEvidence(
  branch: string,
  stored: StoredBranchCommitResolution,
  resolution: BranchRefResolution,
): Record<string, unknown> {
  return {
    branch,
    ref: resolution.ref,
    ref_resolution: resolution.status,
    local_ref: resolution.local_ref,
    local_commit: resolution.local_commit,
    remote_ref: resolution.remote_ref,
    remote_commit: resolution.remote_commit,
    stored_commit: stored.raw,
    resolved_commit: stored.resolved,
    resolution: stored.status,
    candidate_count: stored.candidate_count,
    actual_commit: resolution.commit,
  };
}

function branchPreservationCollision(
  request: ValidatedRequest,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  logicalKey: Record<string, unknown>,
  sourcePayload: Record<string, unknown>,
  targetPayload: Record<string, unknown>,
): { collisions: CollisionDecision[]; decisions: InternalDecision[]; blocked: boolean } {
  const namespace = request.preserveDivergentBranchesUnder;
  if (!namespace) {
    const blocked: CollisionDecision = {
      table: "branches",
      key_hash: hash(logicalKey),
      source_hash: hash(sourcePayload),
      target_hash: hash(targetPayload),
      decision: "block",
    };
    return { collisions: [blocked], decisions: [{ ...blocked, row_id: Number(target.id) }], blocked: true };
  }

  const sourceName = String(source.name ?? "");
  const targetName = String(target.name ?? "");
  const preservedName = `${namespace}/${sourceName}`;
  const sourceCommit = resolveStoredBranchCommit(request.targetPath, source.last_commit_sha);
  const targetCommit = resolveStoredBranchCommit(request.targetPath, target.last_commit_sha);
  const preservedRef = resolvePreservedBranchRef(request.targetPath, preservedName);
  const targetRef = resolveTargetBranchRef(
    request.targetPath,
    targetName,
    Number(target.is_remote) === 1,
  );
  const preservedNameCollision = rows.some((row) => (
    Number(row.id) !== Number(source.id) && String(row.name ?? "") === preservedName
  ));
  const evidence = {
    preserved_name: preservedName,
    stored_preserved_commit: sourceCommit.raw,
    resolved_preserved_commit: sourceCommit.resolved,
    preserved_commit_resolution: sourceCommit.status,
    preserved_commit_candidate_count: sourceCommit.candidate_count,
    preserved_ref: preservedRef.ref,
    preserved_ref_resolution: preservedRef.status,
    actual_preserved_commit: preservedRef.commit,
    stored_target_commit: targetCommit.raw,
    resolved_target_commit: targetCommit.resolved,
    target_commit_resolution: targetCommit.status,
    target_commit_candidate_count: targetCommit.candidate_count,
    target_ref: targetRef.ref,
    target_ref_resolution: targetRef.status,
    actual_target_commit: targetRef.commit,
    preserved_name_collision: preservedNameCollision,
  };
  const evidenceOk = !preservedNameCollision
    && isValidHeadRefName(preservedName)
    && sourceCommit.status === "ok"
    && targetCommit.status === "ok"
    && preservedRef.status === "ok"
    && targetRef.status === "ok"
    && preservedRef.commit === sourceCommit.resolved
    && targetRef.commit === targetCommit.resolved;
  const targetEvidence = targetRefEvidence(targetName, targetCommit, targetRef);

  if (!evidenceOk) {
    const blocked: CollisionDecision = {
      table: "branches",
      key_hash: hash(logicalKey),
      source_hash: hash(sourcePayload),
      target_hash: hash(targetPayload),
      decision: "block",
      preserved_name_hash: hash(preservedName),
      preserved_ref_hash: hash(evidence),
      target_ref_hash: hash(targetEvidence),
    };
    return { collisions: [blocked], decisions: [{ ...blocked, row_id: Number(target.id) }], blocked: true };
  }

  const preserved: CollisionDecision = {
    table: "branches",
    key_hash: hash(logicalKey),
    source_hash: hash(sourcePayload),
    target_hash: hash(targetPayload),
    decision: "preserve",
    preserved_name_hash: hash(preservedName),
    preserved_ref_hash: hash(evidence),
    target_ref_hash: hash(targetEvidence),
  };
  const move: CollisionDecision = {
    table: "branches",
    key_hash: hash(logicalKey),
    source_hash: hash(sourcePayload),
    target_hash: hash(targetPayload),
    decision: "move",
    preserved_name_hash: hash(preservedName),
    preserved_ref_hash: hash(evidence),
    target_ref_hash: hash(targetEvidence),
  };
  return {
    collisions: [preserved, move],
    decisions: [
      { ...preserved, row_id: Number(source.id), preserved_name: preservedName, resolved_last_commit_sha: sourceCommit.resolved! },
      { ...move, row_id: Number(target.id), resolved_last_commit_sha: targetCommit.resolved! },
    ],
    blocked: false,
  };
}

function buildChildPlan(request: ValidatedRequest): {
  counts: Record<string, TableReconcileCounts>;
  collisions: CollisionDecision[];
  decisions: InternalDecision[];
  digests: Record<string, string>;
} {
  const counts: Record<string, TableReconcileCounts> = {};
  const collisions: CollisionDecision[] = [];
  const decisions: InternalDecision[] = [];
  const digests: Record<string, string> = {};
  let preservedDivergentBranchCount = 0;
  for (const spec of CHILD_TABLES) {
    const rawRows = relocationDb().query(`SELECT * FROM ${quote(spec.table)} WHERE repo_id IN (?, ?) ORDER BY id`).all(
      request.legacyRepoId,
      request.targetRepoId,
    ) as Array<Record<string, unknown>>;
    digests[spec.table] = hash(rawRows);
    const invalidRemoteIds = new Set<number>();
    const rows: Array<Record<string, unknown>> = spec.table === "remotes"
      ? rawRows.map((row) => {
          const url = sanitizeGitRemoteUrl(String(row.url ?? ""));
          if (!url) invalidRemoteIds.add(Number(row.id));
          return {
            ...row,
            url: url || null,
            fetch_url: sanitizeGitRemoteUrl(String(row.fetch_url ?? "")) || null,
          } as Record<string, unknown>;
        })
      : rawRows;
    const legacyRows = rows.filter((row) => row.repo_id === request.legacyRepoId);
    const targetRows = rows.filter((row) => row.repo_id === request.targetRepoId);
    const legacyByKey = new Map(legacyRows.map((row) => [stable(keyFor(row, spec.key)), row]));
    const tableCounts: TableReconcileCounts = {
      legacy: legacyRows.length,
      target: targetRows.length,
      move: 0,
      dedupe: 0,
      block: 0,
    };
    for (const row of rows.filter((candidate) => invalidRemoteIds.has(Number(candidate.id)))) {
      const logicalKey = keyFor(row, spec.key);
      const payload = rowWithout(row, ["id", "repo_id"]);
      const blocked: CollisionDecision = {
        table: spec.table,
        key_hash: hash(logicalKey),
        source_hash: row.repo_id === request.legacyRepoId ? hash(payload) : null,
        target_hash: hash(payload),
        decision: "block",
      };
      tableCounts.block++;
      collisions.push(blocked);
      decisions.push({ ...blocked, row_id: Number(row.id) });
    }
    for (const target of targetRows) {
      if (invalidRemoteIds.has(Number(target.id))) continue;
      const logicalKey = keyFor(target, spec.key);
      const source = legacyByKey.get(stable(logicalKey));
      if (source && invalidRemoteIds.has(Number(source.id))) continue;
      const targetPayload = rowWithout(target, ["id", "repo_id"]);
      const sourcePayload = source ? rowWithout(source, ["id", "repo_id"]) : null;
      if (
        spec.table === "branches"
        && source
        && sourcePayload
        && stable(sourcePayload) !== stable(targetPayload)
      ) {
        const preservation = branchPreservationCollision(
          request,
          source,
          target,
          rows,
          logicalKey,
          sourcePayload,
          targetPayload,
        );
        if (preservation.blocked) {
          tableCounts.block++;
        } else {
          preservedDivergentBranchCount++;
          if (preservedDivergentBranchCount > MAX_PRESERVED_DIVERGENT_BRANCHES) {
            const blocked: CollisionDecision = {
              table: spec.table,
              key_hash: hash(logicalKey),
              source_hash: hash(sourcePayload),
              target_hash: hash(targetPayload),
              decision: "block",
            };
            tableCounts.block++;
            collisions.push(blocked);
            decisions.push({ ...blocked, row_id: Number(target.id) });
            continue;
          }
          tableCounts.move++;
        }
        collisions.push(...preservation.collisions);
        decisions.push(...preservation.decisions);
        continue;
      }
      const decision: CollisionDecision["decision"] = !source
        ? "move"
        : stable(sourcePayload) === stable(targetPayload) ? "dedupe" : "block";
      tableCounts[decision]++;
      const safeDecision: CollisionDecision = {
        table: spec.table,
        key_hash: hash(logicalKey),
        source_hash: sourcePayload ? hash(sourcePayload) : null,
        target_hash: hash(targetPayload),
        decision,
      };
      collisions.push(safeDecision);
      decisions.push({ ...safeDecision, row_id: Number(target.id) });
    }
    counts[spec.table] = tableCounts;
  }
  return { counts, collisions, decisions, digests };
}

function normalizeRelocationRemotes(request: ValidatedRequest): void {
  const db = relocationDb();
  const rows = db.query("SELECT id, url, fetch_url FROM remotes WHERE repo_id IN (?, ?)").all(
    request.legacyRepoId,
    request.targetRepoId,
  ) as Array<{ id: number; url: string; fetch_url: string | null }>;
  const update = db.query("UPDATE remotes SET url = ?, fetch_url = ? WHERE id = ?");
  for (const row of rows) {
    const url = sanitizeGitRemoteUrl(row.url);
    if (!url) fail("TRANSACTION_CONFLICT", "remote identity changed after dry-run review");
    update.run(url, sanitizeGitRemoteUrl(row.fetch_url || "") || null, row.id);
  }
}

function buildEdgePlan(request: ValidatedRequest): {
  count: TableReconcileCounts;
  collisions: CollisionDecision[];
  decisions: InternalDecision[];
  digest: string;
} {
  const legacy = String(request.legacyRepoId);
  const target = String(request.targetRepoId);
  const rows = relocationDb().query(`SELECT * FROM edges
    WHERE (source_type = 'repo' AND source_id IN (?, ?))
       OR (target_type = 'repo' AND target_id IN (?, ?)) ORDER BY id`).all(
    legacy, target, legacy, target,
  ) as Array<Record<string, unknown>>;
  const mappedRows = rows.map((row) => {
    const containsTarget = (row.source_type === "repo" && row.source_id === target)
      || (row.target_type === "repo" && row.target_id === target);
    return {
      row,
      containsTarget,
      mapped: {
        ...row,
        source_id: row.source_type === "repo" && row.source_id === target ? legacy : row.source_id,
        target_id: row.target_type === "repo" && row.target_id === target ? legacy : row.target_id,
      },
    };
  });
  const targetRows = mappedRows.filter(({ containsTarget }) => containsTarget);
  const result: TableReconcileCounts = {
    legacy: mappedRows.length - targetRows.length,
    target: targetRows.length,
    move: 0,
    dedupe: 0,
    block: 0,
  };
  const collisions: CollisionDecision[] = [];
  const decisions: InternalDecision[] = [];
  const groups = new Map<string, typeof mappedRows>();
  for (const mappedRow of mappedRows) {
    const keyHash = stable(rowWithout(mappedRow.mapped, ["id", "weight", "metadata"]));
    const group = groups.get(keyHash) || [];
    group.push(mappedRow);
    groups.set(keyHash, group);
  }
  for (const group of groups.values()) {
    const affected = group.filter(({ containsTarget }) => containsTarget);
    if (!affected.length) continue;
    // Prefer a row that is already canonical. If every row contains the target
    // ID, deterministically move the lowest-ID row and converge the rest onto it.
    const anchor = group.find(({ containsTarget }) => !containsTarget) || affected[0]!;
    const key = rowWithout(anchor.mapped, ["id", "weight", "metadata"]);
    const anchorPayload = rowWithout(anchor.mapped, ["id"]);
    for (const candidate of affected) {
      const targetPayload = rowWithout(candidate.mapped, ["id"]);
      const isAnchor = candidate === anchor;
      const decision: CollisionDecision["decision"] = isAnchor
        ? "move"
        : stable(anchorPayload) === stable(targetPayload) ? "dedupe" : "block";
      result[decision]++;
      const safeDecision: CollisionDecision = {
        table: "edges",
        key_hash: hash(key),
        source_hash: isAnchor ? null : hash(anchorPayload),
        target_hash: hash(targetPayload),
        decision,
      };
      collisions.push(safeDecision);
      decisions.push({ ...safeDecision, row_id: Number(candidate.row.id) });
    }
  }
  return { count: result, collisions, decisions, digest: hash(rows) };
}

function buildPlan(request: ValidatedRequest): ReconcilePlan {
  const sourceRow = getRepo(request.legacyRepoId);
  const targetRow = getRepo(request.targetRepoId);
  if (!sourceRow || !targetRow) fail("REPO_NOT_FOUND", "both explicit registry rows must exist");
  validateRows(request, sourceRow, targetRow);
  validateTarget(request.targetPath, request.canonicalRoot, request.remote, request.head);
  validateNoThirdAlias(request);
  const unknown = unknownRepoForeignKeys();
  if (unknown.length) fail("UNKNOWN_REPO_FOREIGN_KEY", "unknown tables reference repos", { tables: unknown });

  const child = buildChildPlan(request);
  const edge = buildEdgePlan(request);
  const counts: Record<string, TableReconcileCounts> = { ...child.counts, edges: edge.count };
  const collisions = [...child.collisions, ...edge.collisions];
  const decisions = [...child.decisions, ...edge.decisions];
  const blocked = collisions.filter((collision) => collision.decision === "block");

  let leaseCount = 0;
  let leaseDigest = hash([]);
  if (tableExists("worktree_leases")) {
    const columns = relocationDb().query("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>;
    if (!["lease_id", "repo_catalog_id", "repo_path"].every((column) => columns.some(({ name }) => name === column))) {
      fail("UNKNOWN_REPO_FOREIGN_KEY", "worktree_leases has an unsupported schema", { tables: ["worktree_leases"] });
    }
    const leases = relocationDb().query(`SELECT * FROM worktree_leases
      WHERE repo_catalog_id IN (?, ?)
         OR repo_path IN (?, ?)
      ORDER BY lease_id`).all(
      request.legacyRepoId,
      request.targetRepoId,
      request.legacyPath,
      request.targetPath,
    );
    leaseCount = leases.length;
    leaseDigest = hash(leases);
    const leaseRows = leases as Array<Record<string, unknown>>;
    const conflictingLease = leaseRows.some((row) =>
      (row.repo_path === request.legacyPath || row.repo_path === request.targetPath)
      && row.repo_catalog_id !== null
      && row.repo_catalog_id !== request.legacyRepoId
      && row.repo_catalog_id !== request.targetRepoId);
    if (conflictingLease) {
      fail(
        "WORKTREE_LEASE_CONFLICT",
        "a relocation-path worktree lease belongs to a different registered repo",
        { tables: ["worktree_leases"] },
      );
    }
    const legacyLeases = leaseRows.filter((row) =>
      row.repo_catalog_id === request.legacyRepoId
      || (row.repo_catalog_id === null && row.repo_path === request.legacyPath)).length;
    const targetLeases = leaseCount - legacyLeases;
    const movedLeases = leaseRows.filter((row) =>
      row.repo_catalog_id !== request.legacyRepoId || row.repo_path !== request.targetPath).length;
    counts.worktree_leases = { legacy: legacyLeases, target: targetLeases, move: movedLeases, dedupe: 0, block: 0 };
  }
  const audits = relocationDb().query("SELECT * FROM repo_relocation_audit WHERE repo_id IN (?, ?) ORDER BY id").all(
    request.legacyRepoId,
    request.targetRepoId,
  );
  const targetAuditCount = (audits as Array<Record<string, unknown>>).filter((row) => row.repo_id === request.targetRepoId).length;
  counts.repo_relocation_audit = {
    legacy: audits.length - targetAuditCount,
    target: targetAuditCount,
    move: 0,
    dedupe: 0,
    block: 0,
  };
  const commitCount = counts.commits!.legacy + counts.commits!.move;
  const branchCount = counts.branches!.legacy + counts.branches!.move;
  const tagCount = counts.tags!.legacy + counts.tags!.move;
  const after = safeRepo({
    ...sourceRow,
    path: request.targetPath,
    name: targetRow.name,
    org: targetRow.org,
    remote_url: targetRow.remote_url,
    default_branch: targetRow.default_branch,
    description: targetRow.description,
    last_scanned: targetRow.last_scanned,
    commit_count: commitCount,
    branch_count: branchCount,
    tag_count: tagCount,
    created_at: earliestTimestamp(sourceRow.created_at, targetRow.created_at),
  });
  const planEnvelope = {
    request_hash: request.requestHash,
    source: safeRepo(sourceRow),
    target: safeRepo(targetRow),
    source_row_digest: hash(sourceRow),
    target_row_digest: hash(targetRow),
    after: { ...after, updated_at: "<apply-revision>" },
    counts,
    collisions,
    table_digests: { ...child.digests, edges: edge.digest, worktree_leases: leaseDigest, repo_relocation_audit: hash(audits) },
    lease_count: leaseCount,
  };
  return {
    sourceRow,
    targetRow,
    after,
    counts,
    collisions,
    decisions,
    tableDigests: planEnvelope.table_digests,
    leaseCount,
    canApply: blocked.length === 0,
    planHash: hash(planEnvelope),
  };
}

function receiptFromRow(row: Record<string, unknown>): PrimaryRelocationReceipt {
  return {
    schema: AUDIT_SCHEMA,
    id: String(row.id),
    idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash),
    plan_hash: String(row.plan_hash),
    repo_id: Number(row.repo_id),
    target_repo_id: Number(row.target_repo_id),
    operation: OPERATION,
    actor: String(row.actor),
    expected_current_path: String(row.expected_current_path),
    target_path: String(row.target_path),
    expected_remote: sanitizeGitRemoteUrl(String(row.expected_remote)),
    expected_head: String(row.expected_head),
    source_revision: String(row.source_revision),
    target_revision: String(row.target_revision),
    source: safeRepo(JSON.parse(String(row.source_json)) as Repo),
    target: safeRepo(JSON.parse(String(row.target_json)) as Repo),
    after: safeRepo(JSON.parse(String(row.after_json)) as Repo),
    counts: JSON.parse(String(row.counts_json)),
    collisions: JSON.parse(String(row.collisions_json)),
    created_at: String(row.created_at),
  };
}

function resultFromReceipt(receipt: PrimaryRelocationReceipt): PrimaryRelocationResult {
  return {
    schema: SCHEMA,
    ok: true,
    applied: true,
    replayed: true,
    repo_id: receipt.repo_id,
    target_repo_id: receipt.target_repo_id,
    before: receipt.source,
    target: receipt.target,
    after: receipt.after,
    plan: {
      request_hash: receipt.request_hash,
      plan_hash: receipt.plan_hash,
      can_apply: true,
      counts: receipt.counts,
      collisions: receipt.collisions,
    },
    receipt,
  };
}

function existingIdempotentResult(request: ValidatedRequest): PrimaryRelocationResult | null {
  const row = relocationDb().query("SELECT * FROM repo_relocation_audit WHERE idempotency_key = ?").get(
    request.idempotencyKey,
  ) as Record<string, unknown> | null;
  if (!row) return null;
  if (String(row.request_hash) !== request.requestHash) {
    fail("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different request");
  }
  if (request.expectedPlanHash && String(row.plan_hash) !== request.expectedPlanHash) {
    fail("PLAN_HASH_MISMATCH", "persisted receipt does not match the supplied plan hash", {
      expected_plan_hash: request.expectedPlanHash,
      actual_plan_hash: String(row.plan_hash),
    });
  }
  return resultFromReceipt(receiptFromRow(row));
}

function applyDecisions(request: ValidatedRequest, plan: ReconcilePlan): void {
  const db = relocationDb();
  // Remove converged duplicates before moving their surviving row. This avoids
  // transient UNIQUE violations when multiple target-bearing edges map to the
  // same canonical post-relocation key.
  const ordered = [...plan.decisions].sort((left, right) => {
    const rank = (decision: InternalDecision) => {
      if (decision.decision === "dedupe") return 0;
      if (decision.decision === "preserve") return 1;
      return 2;
    };
    return rank(left) - rank(right) || left.row_id - right.row_id;
  });
  for (const decision of ordered) {
    if (decision.decision === "dedupe") {
      if (decision.table === "edges") {
        db.query("DELETE FROM edges WHERE id = ?").run(decision.row_id);
      } else {
        db.query(`DELETE FROM ${quote(decision.table)} WHERE id = ? AND repo_id = ?`).run(
          decision.row_id,
          request.targetRepoId,
        );
      }
    } else if (decision.decision === "preserve") {
      if (decision.table !== "branches" || !decision.preserved_name || !decision.resolved_last_commit_sha) {
        fail("TRANSACTION_CONFLICT", "invalid branch preservation decision");
      }
      const updated = db.query(`UPDATE branches SET
        name = ?, is_remote = 0, last_commit_sha = ?, ahead = 0, behind = 0
        WHERE id = ? AND repo_id = ?`).run(
        decision.preserved_name,
        decision.resolved_last_commit_sha,
        decision.row_id,
        request.legacyRepoId,
      );
      if (updated.changes !== 1) fail("TRANSACTION_CONFLICT", "branch preservation row changed during reconciliation");
    } else if (decision.decision === "move") {
      if (decision.table === "edges") {
        db.query(`UPDATE edges SET
          source_id = CASE WHEN source_type = 'repo' AND source_id = ? THEN ? ELSE source_id END,
          target_id = CASE WHEN target_type = 'repo' AND target_id = ? THEN ? ELSE target_id END
          WHERE id = ?`).run(
          String(request.targetRepoId), String(request.legacyRepoId),
          String(request.targetRepoId), String(request.legacyRepoId),
          decision.row_id,
        );
      } else if (decision.table === "branches" && decision.resolved_last_commit_sha) {
        db.query("UPDATE branches SET repo_id = ?, last_commit_sha = ? WHERE id = ? AND repo_id = ?").run(
          request.legacyRepoId,
          decision.resolved_last_commit_sha,
          decision.row_id,
          request.targetRepoId,
        );
      } else {
        db.query(`UPDATE ${quote(decision.table)} SET repo_id = ? WHERE id = ? AND repo_id = ?`).run(
          request.legacyRepoId,
          decision.row_id,
          request.targetRepoId,
        );
      }
    }
  }
}

interface RelocationExactState {
  repos: Array<Record<string, unknown>>;
  children: Record<(typeof CHILD_TABLES)[number]["table"], Array<Record<string, unknown>>>;
  edges: Array<Record<string, unknown>>;
  worktree_leases: Array<Record<string, unknown>>;
  repo_relocation_audit: Array<Record<string, unknown>>;
}

function compareRowIds(left: Record<string, unknown>, right: Record<string, unknown>): number {
  if (typeof left.id === "number" && typeof right.id === "number") return left.id - right.id;
  return String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0;
}

function compareLeaseIds(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftId = String(left["lease_id"]);
  const rightId = String(right["lease_id"]);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function captureRelocationExactState(request: ValidatedRequest): RelocationExactState {
  const db = relocationDb();
  const children = Object.fromEntries(CHILD_TABLES.map(({ table }) => [
    table,
    db.query(`SELECT * FROM ${quote(table)} WHERE repo_id IN (?, ?) ORDER BY id`).all(
      request.legacyRepoId,
      request.targetRepoId,
    ) as Array<Record<string, unknown>>,
  ])) as RelocationExactState["children"];
  const edges = db.query(`SELECT * FROM edges
    WHERE (source_type = 'repo' AND source_id IN (?, ?))
       OR (target_type = 'repo' AND target_id IN (?, ?)) ORDER BY id`).all(
    String(request.legacyRepoId),
    String(request.targetRepoId),
    String(request.legacyRepoId),
    String(request.targetRepoId),
  ) as Array<Record<string, unknown>>;
  const worktreeLeases = (tableExists("worktree_leases")
    ? db.query(`SELECT * FROM worktree_leases
        WHERE repo_catalog_id IN (?, ?)
           OR repo_path IN (?, ?)
        ORDER BY lease_id`).all(
      request.legacyRepoId,
      request.targetRepoId,
      request.legacyPath,
      request.targetPath,
    ) as Array<Record<string, unknown>>
    : []).sort(compareLeaseIds);
  const audits = db.query(`SELECT * FROM repo_relocation_audit
    WHERE repo_id IN (?, ?)`).all(
    request.legacyRepoId,
    request.targetRepoId,
  ) as Array<Record<string, unknown>>;
  return {
    repos: db.query("SELECT * FROM repos WHERE id IN (?, ?) ORDER BY id").all(
      request.legacyRepoId,
      request.targetRepoId,
    ) as Array<Record<string, unknown>>,
    children,
    edges,
    worktree_leases: worktreeLeases,
    repo_relocation_audit: audits.sort(compareRowIds),
  };
}

function rawReceiptRow(receipt: PrimaryRelocationReceipt): Record<string, unknown> {
  return {
    id: receipt.id,
    idempotency_key: receipt.idempotency_key,
    request_hash: receipt.request_hash,
    plan_hash: receipt.plan_hash,
    repo_id: receipt.repo_id,
    target_repo_id: receipt.target_repo_id,
    operation: receipt.operation,
    actor: receipt.actor,
    expected_current_path: receipt.expected_current_path,
    target_path: receipt.target_path,
    expected_remote: receipt.expected_remote,
    expected_head: receipt.expected_head,
    source_revision: receipt.source_revision,
    target_revision: receipt.target_revision,
    source_json: JSON.stringify(receipt.source),
    target_json: JSON.stringify(receipt.target),
    after_json: JSON.stringify(receipt.after),
    counts_json: JSON.stringify(receipt.counts),
    collisions_json: JSON.stringify(receipt.collisions),
    created_at: receipt.created_at,
  };
}

function expectedRelocationExactState(
  before: RelocationExactState,
  request: ValidatedRequest,
  plan: ReconcilePlan,
  receipt: PrimaryRelocationReceipt,
): RelocationExactState {
  const decisionsByTable = new Map<string, InternalDecision[]>();
  for (const decision of plan.decisions) {
    const decisions = decisionsByTable.get(decision.table) ?? [];
    decisions.push(decision);
    decisionsByTable.set(decision.table, decisions);
  }
  const projectRows = (table: string, rows: Array<Record<string, unknown>>) => {
    let projected = rows.map((row) => {
      const copy = { ...row };
      if (table === "remotes") {
        copy.url = sanitizeGitRemoteUrl(String(copy.url ?? "")) || null;
        copy.fetch_url = sanitizeGitRemoteUrl(String(copy.fetch_url ?? "")) || null;
      }
      return copy;
    });
    for (const decision of decisionsByTable.get(table) ?? []) {
      if (decision.decision === "dedupe") {
        projected = projected.filter((row) => Number(row.id) !== decision.row_id);
      } else if (decision.decision === "preserve") {
        projected = projected.map((row) => Number(row.id) === decision.row_id
          ? {
              ...row,
              name: decision.preserved_name,
              is_remote: 0,
              last_commit_sha: decision.resolved_last_commit_sha ?? row.last_commit_sha,
              ahead: 0,
              behind: 0,
            }
          : row);
      } else if (decision.decision === "move") {
        projected = projected.map((row) => Number(row.id) === decision.row_id
          ? {
              ...row,
              repo_id: request.legacyRepoId,
              ...(table === "branches" && decision.resolved_last_commit_sha
                ? { last_commit_sha: decision.resolved_last_commit_sha }
                : {}),
            }
          : row);
      }
    }
    return projected.sort(compareRowIds);
  };
  const children = Object.fromEntries(CHILD_TABLES.map(({ table }) => [
    table,
    projectRows(table, before.children[table]),
  ])) as RelocationExactState["children"];
  let edges = before.edges.map((row) => ({ ...row }));
  for (const decision of decisionsByTable.get("edges") ?? []) {
    if (decision.decision === "dedupe") {
      edges = edges.filter((row) => Number(row.id) !== decision.row_id);
    } else if (decision.decision === "move") {
      edges = edges.map((row) => Number(row.id) === decision.row_id ? {
        ...row,
        source_id: row.source_type === "repo" && row.source_id === String(request.targetRepoId)
          ? String(request.legacyRepoId)
          : row.source_id,
        target_id: row.target_type === "repo" && row.target_id === String(request.targetRepoId)
          ? String(request.legacyRepoId)
          : row.target_id,
      } : row);
    }
  }
  const expectedRepo = {
    ...plan.sourceRow,
    path: request.targetPath,
    name: plan.targetRow.name,
    org: plan.targetRow.org,
    remote_url: request.remote,
    default_branch: plan.targetRow.default_branch,
    description: plan.targetRow.description,
    last_scanned: plan.targetRow.last_scanned,
    commit_count: plan.counts.commits!.legacy + plan.counts.commits!.move,
    branch_count: plan.counts.branches!.legacy + plan.counts.branches!.move,
    tag_count: plan.counts.tags!.legacy + plan.counts.tags!.move,
    created_at: earliestTimestamp(plan.sourceRow.created_at, plan.targetRow.created_at),
    updated_at: receipt.created_at,
  } as unknown as Record<string, unknown>;
  return {
    repos: [expectedRepo],
    children,
    edges: edges.sort(compareRowIds),
    worktree_leases: before.worktree_leases.map((row): Record<string, unknown> => ({
      ...row,
      repo_catalog_id: request.legacyRepoId,
      repo_path: request.targetPath,
    })).sort(compareLeaseIds),
    repo_relocation_audit: [
      ...before.repo_relocation_audit.map((row) => ({ ...row })),
      rawReceiptRow(receipt),
    ].sort(compareRowIds),
  };
}

function verifyRelocationExactState(expected: RelocationExactState, actual: RelocationExactState): void {
  const envelope = (state: RelocationExactState) => ({
    repos: { count: state.repos.length, digest: hash(state.repos), rows: state.repos },
    children: Object.fromEntries(Object.entries(state.children).map(([table, rows]) => [
      table,
      { count: rows.length, digest: hash(rows), rows },
    ])),
    edges: { count: state.edges.length, digest: hash(state.edges), rows: state.edges },
    worktree_leases: {
      count: state.worktree_leases.length,
      digest: hash(state.worktree_leases),
      rows: state.worktree_leases,
    },
    repo_relocation_audit: {
      count: state.repo_relocation_audit.length,
      digest: hash(state.repo_relocation_audit),
      rows: state.repo_relocation_audit,
    },
  });
  if (stable(envelope(actual)) !== stable(envelope(expected))) {
    fail("TRANSACTION_CONFLICT", "exact relocation receipt verification failed");
  }
}

export function relocatePrimaryRepo(request: PrimaryRelocationRequest): PrimaryRelocationResult {
  const validated = validateRequest(request);
  if (validated.apply) {
    const retry = existingIdempotentResult(validated);
    if (retry) return retry;
  }
  const planningContext = validated.apply ? null : openNonMigratingDb(request.databasePath);
  if (planningContext) relocationDbContext = planningContext.db;
  let plan: ReconcilePlan;
  try {
    plan = buildPlan(validated);
  } finally {
    relocationDbContext = null;
    planningContext?.close();
  }
  const source = safeRepo(plan.sourceRow);
  const target = safeRepo(plan.targetRow);
  if (!validated.apply) {
    return {
      schema: SCHEMA,
      ok: true,
      applied: false,
      replayed: false,
      repo_id: validated.legacyRepoId,
      target_repo_id: validated.targetRepoId,
      before: source,
      target,
      after: plan.after,
      plan: {
        request_hash: validated.requestHash,
        plan_hash: plan.planHash,
        can_apply: plan.canApply,
        counts: plan.counts,
        collisions: plan.collisions,
      },
      receipt: null,
    };
  }
  if (validated.expectedPlanHash !== plan.planHash) {
    fail("PLAN_HASH_MISMATCH", "live plan differs from the reviewed dry-run plan", {
      expected_plan_hash: validated.expectedPlanHash,
      actual_plan_hash: plan.planHash,
    });
  }
  if (!plan.canApply) {
    fail("DIVERGENT_COLLISION", "divergent logical-key collisions block relocation", {
      collisions: plan.collisions.filter((collision) => collision.decision === "block"),
    });
  }

  const db = getDb();
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const retry = existingIdempotentResult(validated);
    if (retry) {
      db.exec("COMMIT");
      return retry;
    }
    const currentPlan = buildPlan(validated);
    if (currentPlan.planHash !== plan.planHash || currentPlan.planHash !== validated.expectedPlanHash) {
      fail("PLAN_HASH_MISMATCH", "registry state changed after dry-run review", {
        expected_plan_hash: validated.expectedPlanHash,
        actual_plan_hash: currentPlan.planHash,
      });
    }
    const exactBefore = captureRelocationExactState(validated);

    normalizeRelocationRemotes(validated);
    applyDecisions(validated, currentPlan);
    if (tableExists("worktree_leases")) {
      db.query(`UPDATE worktree_leases SET repo_catalog_id = ?, repo_path = ?
        WHERE repo_catalog_id IN (?, ?)
           OR repo_path IN (?, ?)`).run(
        validated.legacyRepoId,
        validated.targetPath,
        validated.legacyRepoId,
        validated.targetRepoId,
        validated.legacyPath,
        validated.targetPath,
      );
    }
    const deleted = db.query("DELETE FROM repos WHERE id = ? AND path = ? AND updated_at = ?").run(
      validated.targetRepoId,
      validated.targetPath,
      validated.targetRevision,
    );
    // FTS triggers contribute to SQLite's change count. The guarded predicate
    // plus readback proves the one intended repos row was deleted.
    if (deleted.changes < 1 || getRepo(validated.targetRepoId)) {
      fail("TRANSACTION_CONFLICT", "target row changed during reconciliation");
    }

    const createdAt = new Date().toISOString();
    const survivorCreatedAt = earliestTimestamp(
      currentPlan.sourceRow.created_at,
      currentPlan.targetRow.created_at,
    );
    const updated = db.query(`UPDATE repos SET
      path = ?, name = ?, org = ?, remote_url = ?, default_branch = ?, description = ?, last_scanned = ?,
      commit_count = ?, branch_count = ?, tag_count = ?, created_at = ?, updated_at = ?
      WHERE id = ? AND path = ? AND updated_at = ?`).run(
      validated.targetPath,
      currentPlan.targetRow.name,
      currentPlan.targetRow.org,
      validated.remote,
      currentPlan.targetRow.default_branch,
      currentPlan.targetRow.description,
      currentPlan.targetRow.last_scanned,
      currentPlan.counts.commits!.legacy + currentPlan.counts.commits!.move,
      currentPlan.counts.branches!.legacy + currentPlan.counts.branches!.move,
      currentPlan.counts.tags!.legacy + currentPlan.counts.tags!.move,
      survivorCreatedAt,
      createdAt,
      validated.legacyRepoId,
      validated.legacyPath,
      validated.legacyRevision,
    );
    if (updated.changes < 1) fail("TRANSACTION_CONFLICT", "legacy row changed during reconciliation");
    const after = safeRepo(getRepo(validated.legacyRepoId)!);
    const receipt: PrimaryRelocationReceipt = {
      schema: AUDIT_SCHEMA,
      id: randomUUID(),
      idempotency_key: validated.idempotencyKey,
      request_hash: validated.requestHash,
      plan_hash: currentPlan.planHash,
      repo_id: validated.legacyRepoId,
      target_repo_id: validated.targetRepoId,
      operation: OPERATION,
      actor: validated.actor,
      expected_current_path: validated.legacyPath,
      target_path: validated.targetPath,
      expected_remote: validated.remote,
      expected_head: validated.head,
      source_revision: validated.legacyRevision,
      target_revision: validated.targetRevision,
      source,
      target,
      after,
      counts: currentPlan.counts,
      collisions: currentPlan.collisions,
      created_at: createdAt,
    };
    db.query(`INSERT INTO repo_relocation_audit (
      id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id, operation, actor,
      expected_current_path, target_path, expected_remote, expected_head, source_revision,
      target_revision, source_json, target_json, after_json, counts_json, collisions_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      receipt.id, receipt.idempotency_key, receipt.request_hash, receipt.plan_hash,
      receipt.repo_id, receipt.target_repo_id, receipt.operation, receipt.actor,
      receipt.expected_current_path, receipt.target_path, receipt.expected_remote,
      receipt.expected_head, receipt.source_revision, receipt.target_revision,
      JSON.stringify(receipt.source), JSON.stringify(receipt.target), JSON.stringify(receipt.after),
      JSON.stringify(receipt.counts), JSON.stringify(receipt.collisions), receipt.created_at,
    );
    verifyRelocationExactState(
      expectedRelocationExactState(exactBefore, validated, currentPlan, receipt),
      captureRelocationExactState(validated),
    );
    const fkErrors = db.query("PRAGMA foreign_key_check").all();
    if (fkErrors.length) fail("TRANSACTION_CONFLICT", "foreign-key verification failed");
    db.exec("COMMIT");
    began = false;
    return { ...resultFromReceipt(receipt), replayed: false };
  } catch (error) {
    if (began) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    }
    if (error instanceof PrimaryRelocationError) throw error;
    fail("TRANSACTION_CONFLICT", "reconciliation failed and was rolled back", undefined, error);
  }
}
