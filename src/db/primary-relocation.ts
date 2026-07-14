import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "./database.js";
import type { Repo } from "../types/index.js";

const SCHEMA = "open-repos.primary-relocation.v1" as const;
const OPERATION = "primary_relocation" as const;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
type SourceCheckoutState = "matched" | "missing";

export type PrimaryRelocationErrorCode =
  | "INVALID_REQUEST"
  | "REPO_NOT_FOUND"
  | "STALE_CURRENT_PATH"
  | "AMBIGUOUS_REPO_NAME"
  | "TARGET_MISSING"
  | "TARGET_NOT_CANONICAL"
  | "TARGET_OUTSIDE_ROOT"
  | "TARGET_ALREADY_REGISTERED"
  | "TARGET_NOT_GIT_CHECKOUT"
  | "TARGET_DIRTY"
  | "SOURCE_NOT_GIT_CHECKOUT"
  | "SOURCE_REMOTE_MISMATCH"
  | "SOURCE_HEAD_MISMATCH"
  | "SOURCE_DIRTY"
  | "SOURCE_STATE_CHANGED"
  | "REMOTE_MISMATCH"
  | "HEAD_MISMATCH"
  | "TRANSACTION_CONFLICT";

export class PrimaryRelocationError extends Error {
  constructor(
    public readonly code: PrimaryRelocationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrimaryRelocationError";
  }
}

export interface PrimaryRelocationRequest {
  repoId: number;
  expectedCurrentPath: string;
  targetPath: string;
  expectedRemote: string;
  expectedHead: string;
  actor: string;
  apply?: boolean;
}

export interface PrimaryRelocationReceipt {
  id: string;
  operation: typeof OPERATION;
  actor: string;
  repo_id: number;
  expected_current_path: string;
  target_path: string;
  expected_remote: string;
  expected_head: string;
  source_state: SourceCheckoutState;
  created_at: string;
}

export interface PrimaryRelocationResult {
  schema: typeof SCHEMA;
  ok: true;
  applied: boolean;
  repo_id: number;
  validation: {
    source_row: "matched";
    source_checkout: SourceCheckoutState;
    exact_name: "unique";
    target_path: "canonical";
    target_registration: "unclaimed";
    target_checkout: "matched";
    remote: string;
    head: string;
  };
  before: Repo;
  after: Repo;
  receipt: PrimaryRelocationReceipt | null;
}

function fail(code: PrimaryRelocationErrorCode, message: string, cause?: unknown): never {
  throw new PrimaryRelocationError(code, message, cause === undefined ? undefined : { cause });
}

function normalizeAbsolutePath(
  path: string,
  label: string,
  code: PrimaryRelocationErrorCode = "INVALID_REQUEST",
): string {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    fail(code, `${label} must be a non-empty absolute path`);
  }
  const resolved = resolve(path);
  if (resolved !== path) {
    fail(code, `${label} must already be canonical (no dot segments or trailing separators)`);
  }
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Return a credential-free repository identity in host/owner/name form.
 * Raw remote values are never included in errors or receipts.
 */
export function sanitizeGitRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  if (
    !trimmed
    || trimmed.includes("\0")
    || trimmed.includes("\\")
    || trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return "";
  }

  let host = "";
  let pathname = "";
  const scpMatch = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);

  try {
    if (trimmed.includes("://")) {
      const url = new URL(trimmed);
      if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol)) return "";
      host = url.hostname.toLowerCase();
      pathname = url.pathname;
    } else if (scpMatch) {
      host = scpMatch[1]!.toLowerCase();
      pathname = scpMatch[2]!;
    } else {
      const parts = trimmed.replace(/^\/+/, "").split("/");
      host = (parts.shift() || "").toLowerCase();
      pathname = parts.join("/");
    }
  } catch {
    return "";
  }

  const segments = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (!isSafeRemoteHost(host) || segments.length !== 2 || !segments.every(isSafeRemoteSegment)) {
    return "";
  }
  return `${host}/${segments[0]}/${segments[1]}`;
}

function isSafeRemoteHost(host: string): boolean {
  if (!host || host.length > 253 || host === "." || host === "..") return false;
  return host.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function isSafeRemoteSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment);
}

function isSafeRemoteIdentity(remote: string): boolean {
  const [host, owner, name, extra] = remote.split("/");
  return extra === undefined
    && host !== undefined
    && owner !== undefined
    && name !== undefined
    && isSafeRemoteHost(host)
    && isSafeRemoteSegment(owner)
    && isSafeRemoteSegment(name);
}

function sanitizeCheckoutRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  const isNetworkUrl = trimmed.includes("://");
  const isScpSsh = /^(?:[^@/:]+@)?[^/:]+:.+$/.test(trimmed);
  return isNetworkUrl || isScpSsh ? sanitizeGitRemoteUrl(trimmed) : "";
}

function runGit(targetPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", targetPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target path is not a readable Git checkout/worktree", error);
  }
}

function validateExpectedRemote(remote: string): string {
  const sanitized = sanitizeGitRemoteUrl(remote);
  if (!sanitized || sanitized !== remote || !isSafeRemoteIdentity(remote)) {
    fail("INVALID_REQUEST", "expected remote must already be sanitized as host/owner/name");
  }
  return sanitized;
}

function validateSource(
  sourcePath: string,
  expectedRemote: string,
  expectedHead: string,
): SourceCheckoutState {
  let sourceStat;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    fail("SOURCE_NOT_GIT_CHECKOUT", "source path exists but cannot be inspected safely", error);
  }
  if (!sourceStat.isDirectory()) {
    fail("SOURCE_NOT_GIT_CHECKOUT", "existing source path is not a directory");
  }
  const realSource = realpathSync(sourcePath);
  if (realSource !== sourcePath) {
    fail("SOURCE_NOT_GIT_CHECKOUT", "existing source path is not canonical");
  }

  let topLevel = "";
  let sourceRemote = "";
  let sourceHead = "";
  let sourceStatus = "";
  try {
    topLevel = execFileSync("git", ["-C", realSource, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    sourceRemote = execFileSync("git", ["-C", realSource, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    sourceHead = execFileSync("git", ["-C", realSource, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    sourceStatus = execFileSync("git", ["-C", realSource, "status", "--porcelain=v1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    fail("SOURCE_NOT_GIT_CHECKOUT", "existing source path is not a readable Git checkout/worktree", error);
  }
  if (realpathSync(topLevel) !== realSource) {
    fail("SOURCE_NOT_GIT_CHECKOUT", "existing source path must be the Git checkout/worktree top-level");
  }
  if (sanitizeCheckoutRemoteUrl(sourceRemote) !== expectedRemote) {
    fail("SOURCE_REMOTE_MISMATCH", "existing source origin does not match the expected remote");
  }
  if (sourceHead !== expectedHead) {
    fail("SOURCE_HEAD_MISMATCH", "existing source HEAD does not match the expected exact object ID");
  }
  if (sourceStatus) {
    fail("SOURCE_DIRTY", "existing source has dirty or untracked changes that must be preserved before relocation");
  }
  return "matched";
}

function validateRequest(request: PrimaryRelocationRequest): {
  expectedCurrentPath: string;
  targetPath: string;
  expectedRemote: string;
  expectedHead: string;
  actor: string;
  canonicalRoot: string;
} {
  if (!Number.isSafeInteger(request.repoId) || request.repoId <= 0) {
    fail("INVALID_REQUEST", "repo ID must be a positive safe integer");
  }
  const actor = request.actor.trim();
  if (!SAFE_ACTOR_PATTERN.test(actor)) {
    fail("INVALID_REQUEST", "actor must be a safe 1-200 character audit identity");
  }
  const expectedHead = request.expectedHead.trim();
  if (!SHA_PATTERN.test(expectedHead)) {
    fail("INVALID_REQUEST", "expected HEAD must be a lowercase 40-64 character hexadecimal object ID");
  }
  return {
    expectedCurrentPath: normalizeAbsolutePath(request.expectedCurrentPath, "expected current path"),
    targetPath: normalizeAbsolutePath(request.targetPath, "target path", "TARGET_NOT_CANONICAL"),
    expectedRemote: validateExpectedRemote(request.expectedRemote),
    expectedHead,
    actor,
    canonicalRoot: normalizeAbsolutePath(
      join(process.env["HOME"] || homedir(), ".hasna", "repos", "worktrees"),
      "canonical root",
    ),
  };
}

function getRepoById(repoId: number): Repo | null {
  return getDb().query("SELECT * FROM repos WHERE id = ?").get(repoId) as Repo | null;
}

function storedPath(path: string): string | null {
  if (!path || path.includes("\0") || !isAbsolute(path)) return null;
  return resolve(path);
}

function storedPathMatchesTarget(path: string, targetPath: string): boolean {
  const normalized = storedPath(path);
  if (!normalized) return false;
  if (normalized === targetPath) return true;
  if (!existsSync(normalized)) return false;
  try {
    return realpathSync(normalized) === targetPath;
  } catch {
    return false;
  }
}

function sanitizedRepoSnapshot(repo: Repo): Repo {
  return {
    ...repo,
    remote_url: sanitizeGitRemoteUrl(repo.remote_url || "") || null,
  };
}

function validateDatabaseIdentity(
  repo: Repo,
  expectedCurrentPath: string,
  targetPath: string,
): void {
  if (storedPath(repo.path) !== expectedCurrentPath) {
    fail("STALE_CURRENT_PATH", "stored repo path does not match the expected current path");
  }
  if (expectedCurrentPath === targetPath) {
    fail("INVALID_REQUEST", "target path must differ from the current repo path");
  }

  const sameName = getDb()
    .query("SELECT id FROM repos WHERE name = ? ORDER BY id LIMIT 2")
    .all(repo.name) as Array<{ id: number }>;
  if (sameName.length !== 1 || sameName[0]!.id !== repo.id) {
    fail("AMBIGUOUS_REPO_NAME", "repo exact name is ambiguous; resolve duplicate rows before relocation");
  }

  const registeredPaths = getDb()
    .query("SELECT id, path FROM repos WHERE id <> ?")
    .all(repo.id) as Array<{ id: number; path: string }>;
  if (registeredPaths.some((candidate) => storedPathMatchesTarget(candidate.path, targetPath))) {
    fail("TARGET_ALREADY_REGISTERED", "target path is already registered to another repo row");
  }
}

function validateTarget(
  repo: Repo,
  targetPath: string,
  canonicalRoot: string,
  expectedRemote: string,
  expectedHead: string,
): void {
  if (!existsSync(canonicalRoot) || !statSync(canonicalRoot).isDirectory()) {
    fail("TARGET_OUTSIDE_ROOT", "canonical worktree root does not exist or is not a directory");
  }
  const realRoot = realpathSync(canonicalRoot);
  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    fail("TARGET_MISSING", "target path does not exist or is not a directory");
  }
  const realTarget = realpathSync(targetPath);
  if (realTarget !== targetPath) {
    fail("TARGET_NOT_CANONICAL", "target path must be canonical and contain no symlink aliases");
  }
  if (!isWithin(realRoot, realTarget)) {
    fail("TARGET_OUTSIDE_ROOT", "target path is outside the canonical worktree root");
  }

  const topLevel = runGit(realTarget, ["rev-parse", "--show-toplevel"]);
  let realTopLevel = "";
  try {
    realTopLevel = realpathSync(topLevel);
  } catch (error) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target Git top-level is not readable", error);
  }
  if (realTopLevel !== realTarget) {
    fail("TARGET_NOT_GIT_CHECKOUT", "target path must be the Git checkout/worktree top-level");
  }

  const registeredRemote = sanitizeCheckoutRemoteUrl(repo.remote_url || "");
  const checkoutRemote = sanitizeCheckoutRemoteUrl(runGit(realTarget, ["remote", "get-url", "origin"]));
  if (!registeredRemote || registeredRemote !== expectedRemote || checkoutRemote !== expectedRemote) {
    fail("REMOTE_MISMATCH", "registered row, expected remote, and target origin do not match");
  }

  const checkoutHead = runGit(realTarget, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (checkoutHead !== expectedHead) {
    fail("HEAD_MISMATCH", "target HEAD does not match the expected exact object ID");
  }
  if (runGit(realTarget, ["status", "--porcelain=v1"])) {
    fail("TARGET_DIRTY", "target checkout has dirty or untracked state and is not an exact-SHA worktree");
  }
}

export function relocatePrimaryRepo(request: PrimaryRelocationRequest): PrimaryRelocationResult {
  const validated = validateRequest(request);
  const beforeRow = getRepoById(request.repoId);
  if (!beforeRow) {
    fail("REPO_NOT_FOUND", `repo ID ${request.repoId} does not exist`);
  }

  validateDatabaseIdentity(beforeRow, validated.expectedCurrentPath, validated.targetPath);
  const sourceState = validateSource(
    validated.expectedCurrentPath,
    validated.expectedRemote,
    validated.expectedHead,
  );
  validateTarget(
    beforeRow,
    validated.targetPath,
    validated.canonicalRoot,
    validated.expectedRemote,
    validated.expectedHead,
  );

  const before = sanitizedRepoSnapshot(beforeRow);
  const after = sanitizedRepoSnapshot({ ...beforeRow, path: validated.targetPath });
  const validation = {
    source_row: "matched" as const,
    source_checkout: sourceState,
    exact_name: "unique" as const,
    target_path: "canonical" as const,
    target_registration: "unclaimed" as const,
    target_checkout: "matched" as const,
    remote: validated.expectedRemote,
    head: validated.expectedHead,
  };
  if (!request.apply) {
    return {
      schema: SCHEMA,
      ok: true,
      applied: false,
      repo_id: before.id,
      validation,
      before,
      after,
      receipt: null,
    };
  }

  const receipt: PrimaryRelocationReceipt = {
    id: randomUUID(),
    operation: OPERATION,
    actor: validated.actor,
    repo_id: before.id,
    expected_current_path: validated.expectedCurrentPath,
    target_path: validated.targetPath,
    expected_remote: validated.expectedRemote,
    expected_head: validated.expectedHead,
    source_state: sourceState,
    created_at: new Date().toISOString(),
  };

  const db = getDb();
  try {
    const transaction = db.transaction(() => {
      const current = db.query("SELECT * FROM repos WHERE id = ?").get(beforeRow.id) as Repo | null;
      if (!current || current.path !== beforeRow.path) {
        fail("TRANSACTION_CONFLICT", "repo row changed after validation; relocation was not applied");
      }
      validateDatabaseIdentity(current, validated.expectedCurrentPath, validated.targetPath);
      const currentSourceState = validateSource(
        validated.expectedCurrentPath,
        validated.expectedRemote,
        validated.expectedHead,
      );
      if (currentSourceState !== sourceState) {
        fail("SOURCE_STATE_CHANGED", "source checkout state changed after validation; relocation was not applied");
      }
      validateTarget(
        current,
        validated.targetPath,
        validated.canonicalRoot,
        validated.expectedRemote,
        validated.expectedHead,
      );

      const updated = db
        .query("UPDATE repos SET path = ? WHERE id = ? AND path = ?")
        .run(validated.targetPath, beforeRow.id, beforeRow.path);
      // The repos FTS trigger adds its own SQLite changes; the primary-key
      // predicate guarantees at most one repos row, so zero is the conflict.
      if (updated.changes < 1) {
        fail("TRANSACTION_CONFLICT", "repo row changed during relocation; relocation was not applied");
      }

      const persistedAfter = db.query("SELECT * FROM repos WHERE id = ?").get(beforeRow.id) as Repo;
      const safeAfter = sanitizedRepoSnapshot(persistedAfter);
      db.query(`INSERT INTO repo_relocation_audit (
        id, repo_id, operation, actor, expected_current_path, target_path,
        expected_remote, expected_head, source_state, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receipt.id,
        receipt.repo_id,
        receipt.operation,
        receipt.actor,
        receipt.expected_current_path,
        receipt.target_path,
        receipt.expected_remote,
        receipt.expected_head,
        receipt.source_state,
        JSON.stringify(before),
        JSON.stringify(safeAfter),
        receipt.created_at,
      );
      return safeAfter;
    });
    const persistedAfter = transaction();
    return {
      schema: SCHEMA,
      ok: true,
      applied: true,
      repo_id: before.id,
      validation,
      before,
      after: persistedAfter,
      receipt,
    };
  } catch (error) {
    if (error instanceof PrimaryRelocationError) {
      throw error;
    }
    fail("TRANSACTION_CONFLICT", "relocation transaction failed and was rolled back", error);
  }
}
