import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { getDb } from "../db/database.js";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

export const TASK_WORKTREE_CAPABILITY = "repos.task-worktrees.v1" as const;
export const TASK_WORKTREE_CAPABILITY_SCHEMA = "repos.task-worktrees.capabilities.v1" as const;
export const TASK_WORKTREE_RECEIPT_SCHEMA = "repos.task-worktrees.receipt.v1" as const;
export const TASK_WORKTREE_ERROR_SCHEMA = "repos.task-worktrees.error.v1" as const;

const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,254}[A-Za-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_RECEIPT_DETAIL = 240;

export type TaskWorktreeOperation =
  | "create_or_adopt"
  | "status"
  | "heartbeat"
  | "transfer"
  | "recover"
  | "cleanup_eligibility"
  | "cleanup";

export type TaskWorktreeOutcome =
  | "reserved"
  | "created"
  | "adopted"
  | "status"
  | "heartbeat"
  | "transferred"
  | "recovered"
  | "eligible"
  | "blocked"
  | "cleaned"
  | "collision"
  | "failed";

export type TaskWorktreeStatus =
  | "provisioning"
  | "active"
  | "cleanup_pending"
  | "cleanup_blocked"
  | "cleanup_failed"
  | "cleaned"
  | "failed";

export type TaskWorktreeErrorCode =
  | "INVALID_REQUEST"
  | "CAPABILITY_OPERATION_FAILED"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "PATH_OUTSIDE_CANONICAL_ROOT"
  | "PATH_SYMLINK"
  | "WORKTREE_COLLISION"
  | "BRANCH_COLLISION"
  | "LEASE_NOT_FOUND"
  | "LEASE_NOT_ACTIVE"
  | "LEASE_NOT_EXPIRED"
  | "STALE_WRITER"
  | "GIT_STATE_INVALID"
  | "PROVIDER_UNREACHABLE"
  | "CLEANUP_BLOCKED"
  | "CLEANUP_FAILED"
  | "CONCURRENT_MUTATION";

export interface CleanupPolicy {
  pullRequest?: "none" | "closed-or-merged" | "merged";
}

export interface TaskWorktreeIdentity {
  lease_id: string;
  repository: string;
  repo_catalog_id: number;
  task_id: string;
  pr_group: string | null;
  leaf: string | null;
  branch: string;
  worktree_path: string;
  machine_id: string;
  writer_generation: string;
  attempt: string;
  status: TaskWorktreeStatus;
  head_sha: string | null;
  cleanup_policy: CleanupPolicy;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
}

export interface TaskWorktreeGate {
  id:
    | "path_contained"
    | "writer_retired"
    | "worktree_clean"
    | "branch_pushed"
    | "provider_reachable"
    | "pull_request_policy";
  passed: boolean;
  detail: string;
}

export interface TaskWorktreeReceipt {
  schema: typeof TASK_WORKTREE_RECEIPT_SCHEMA;
  capability: typeof TASK_WORKTREE_CAPABILITY;
  available: true;
  ok: boolean;
  receipt_id: string;
  sequence: number;
  operation: TaskWorktreeOperation;
  outcome: TaskWorktreeOutcome;
  at: string;
  lease: TaskWorktreeIdentity | null;
  gates?: TaskWorktreeGate[];
  transition?: {
    from_generation: string;
    from_attempt: string;
    to_generation: string;
    to_attempt: string;
    from_machine: string;
    to_machine: string;
  };
}

export interface TaskWorktreeErrorEnvelope {
  schema: typeof TASK_WORKTREE_ERROR_SCHEMA;
  capability: typeof TASK_WORKTREE_CAPABILITY;
  available: true;
  ok: false;
  error: {
    code: TaskWorktreeErrorCode;
    message: string;
  };
  receipt?: TaskWorktreeReceipt;
}

export interface CreateOrAdoptTaskWorktreeOptions {
  repository: string;
  taskId: string;
  taskWorktreeName: string;
  branch: string;
  machineId?: string;
  writerGeneration: string;
  attempt: string;
  prGroup?: string;
  leaf?: string;
  baseBranch?: string;
  worktreePath?: string;
  ttlSeconds?: number;
  cleanupPolicy?: CleanupPolicy;
}

export interface TaskWorktreeSelector {
  leaseId?: string;
  worktreePath?: string;
  taskId?: string;
  repository?: string;
  branch?: string;
}

export interface FencedTaskWorktreeOptions extends TaskWorktreeSelector {
  writerGeneration: string;
  attempt: string;
  machineId?: string;
}

export interface TransferTaskWorktreeOptions extends FencedTaskWorktreeOptions {
  newWriterGeneration: string;
  newAttempt: string;
  newMachineId: string;
  ttlSeconds?: number;
}

export interface RecoverTaskWorktreeOptions extends TaskWorktreeSelector {
  observedWriterGeneration: string;
  observedAttempt: string;
  newWriterGeneration: string;
  newAttempt: string;
  newMachineId: string;
  ttlSeconds?: number;
}

export interface CleanupTaskWorktreeOptions extends FencedTaskWorktreeOptions {
  eligibilityOnly?: boolean;
}

export interface TaskWorktreeCapabilities {
  schema: typeof TASK_WORKTREE_CAPABILITY_SCHEMA;
  capability: typeof TASK_WORKTREE_CAPABILITY;
  available: true;
  storage: "repos-sqlite";
  canonical_path: "$HOME/.hasna/repos/worktrees/<repo-name>/<task-worktree-name>";
  fallback: {
    allowed_when: "capability_absent";
    forbidden_when: "capability_failed";
  };
  operations: TaskWorktreeOperation[];
  receipt_schema: typeof TASK_WORKTREE_RECEIPT_SCHEMA;
  error_schema: typeof TASK_WORKTREE_ERROR_SCHEMA;
}

interface RepoRow {
  id: number;
  path: string;
  name: string;
  org: string | null;
  remote_url: string | null;
  default_branch: string;
}

interface LeaseRow {
  lease_id: string;
  repository: string;
  repo_catalog_id: number;
  task_id: string;
  pr_group: string | null;
  leaf: string | null;
  branch: string;
  worktree_path: string;
  machine_id: string;
  writer_generation: string;
  attempt: string;
  status: TaskWorktreeStatus;
  head_sha: string | null;
  cleanup_policy: string;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  receipt_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface TaskWorktreeGitState {
  root: string;
  repository: string;
  branch: string;
  head: string;
  clean: boolean;
  upstream: string | null;
  upstreamHead: string | null;
}

export interface TaskWorktreeGitAdapter {
  create(input: {
    repository: string;
    branch: string;
    baseBranch: string;
    target: string;
  }): TaskWorktreeGitState;
  inspect(path: string): TaskWorktreeGitState;
  providerHead(repository: string, branch: string): string | null;
  pullRequestState(
    repository: string,
    branch: string,
  ): "open" | "closed" | "merged" | "absent" | "unreachable";
  cleanup(path: string): void;
}

export interface TaskWorktreeServiceOptions {
  db?: Database;
  root?: string;
  now?: () => Date;
  machineId?: () => string;
  git?: TaskWorktreeGitAdapter;
}

export class TaskWorktreeError extends Error {
  constructor(
    public readonly code: TaskWorktreeErrorCode,
    message: string,
    public readonly receipt?: TaskWorktreeReceipt,
  ) {
    super(message);
    this.name = "TaskWorktreeError";
  }

  toJSON(): TaskWorktreeErrorEnvelope {
    return {
      schema: TASK_WORKTREE_ERROR_SCHEMA,
      capability: TASK_WORKTREE_CAPABILITY,
      available: true,
      ok: false,
      error: { code: this.code, message: bounded(this.message) },
      ...(this.receipt ? { receipt: this.receipt } : {}),
    };
  }
}

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : "task worktree operation failed";
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_RECEIPT_DETAIL);
}

function fail(code: TaskWorktreeErrorCode, message: string, receipt?: TaskWorktreeReceipt): never {
  throw new TaskWorktreeError(code, bounded(message), receipt);
}

function safeValue(value: string | undefined, name: string): string {
  if (!value || !SAFE_ID.test(value) || value.includes("..") || value.startsWith("/")) {
    fail("INVALID_REQUEST", `${name} is invalid`);
  }
  return value;
}

function safeSegment(value: string, name: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    fail("INVALID_REQUEST", `${name} is invalid`);
  }
  return value;
}

function safeBranch(value: string): string {
  if (
    !value
    || value.length > 240
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value)
    || value.startsWith("-")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.endsWith(".lock")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
  ) {
    fail("INVALID_REQUEST", "branch is invalid");
  }
  return value;
}

function canonicalRepository(value: string): string {
  const direct = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(value);
  if (direct) return `${direct[1]}/${direct[2]!.replace(/\.git$/i, "")}`;
  const sanitized = sanitizeRemoteIdentity(value);
  if (!sanitized?.startsWith("github.com/")) {
    fail("INVALID_REQUEST", "repository must be a GitHub owner/name identity");
  }
  return sanitized.slice("github.com/".length);
}

function repositoryIdentity(value: string | null): string | null {
  const sanitized = sanitizeRemoteIdentity(value);
  return sanitized?.startsWith("github.com/") ? sanitized.slice("github.com/".length) : null;
}

function machineIdentity(value?: string): string {
  return safeValue(
    value
      ?? process.env["HASNA_MACHINE_ID"]
      ?? process.env["OPEN_MACHINES_ID"]
      ?? process.env["MACHINE_ID"]
      ?? hostname(),
    "machine identity",
  );
}

function ttl(value?: number): number {
  const result = value ?? 900;
  if (!Number.isSafeInteger(result) || result < 30 || result > 86_400) {
    fail("INVALID_REQUEST", "ttlSeconds must be an integer between 30 and 86400");
  }
  return result;
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) fail("INVALID_REQUEST", "clock returned an invalid timestamp");
  return date.toISOString();
}

function expiresAt(date: Date, ttlSeconds: number): string {
  return new Date(date.getTime() + ttlSeconds * 1_000).toISOString();
}

function cleanupPolicy(value?: CleanupPolicy): string {
  const pullRequest = value?.pullRequest ?? "none";
  if (!["none", "closed-or-merged", "merged"].includes(pullRequest)) {
    fail("INVALID_REQUEST", "cleanup pull-request policy is invalid");
  }
  return JSON.stringify({ pullRequest });
}

function readCleanupPolicy(value: string): CleanupPolicy {
  try {
    const parsed = JSON.parse(value) as CleanupPolicy;
    if (["none", "closed-or-merged", "merged"].includes(parsed.pullRequest ?? "none")) {
      return { pullRequest: parsed.pullRequest ?? "none" };
    }
  } catch {
    // Corrupt policy state is interpreted as the strictest supported policy.
  }
  return { pullRequest: "merged" };
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function assertNotSymlink(path: string): void {
  let symbolic = false;
  try {
    symbolic = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("PATH_SYMLINK", "canonical worktree path could not be verified");
  }
  if (symbolic) {
    fail("PATH_SYMLINK", "canonical worktree path contains a symbolic link");
  }
}

function canonicalRoot(input: string): string {
  const root = resolve(input);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNotSymlink(root);
  if (realpathSync(root) !== root) fail("PATH_SYMLINK", "canonical worktree root is aliased");
  return root;
}

function resolveCanonicalPath(
  rootInput: string,
  repository: string,
  taskWorktreeName: string,
  supplied?: string,
): string {
  const repoName = safeSegment(repository.split("/")[1]!, "repository name");
  const taskName = safeSegment(taskWorktreeName, "task worktree name");
  const unresolvedRoot = resolve(rootInput);
  const unresolvedExpected = join(unresolvedRoot, repoName, taskName);
  if (supplied && resolve(supplied) !== unresolvedExpected) {
    fail("PATH_OUTSIDE_CANONICAL_ROOT", "supplied worktree path does not match the canonical resolver");
  }
  const root = canonicalRoot(rootInput);
  const repoRoot = join(root, repoName);
  assertNotSymlink(repoRoot);
  if (!existsSync(repoRoot)) mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
  assertNotSymlink(repoRoot);
  if (realpathSync(repoRoot) !== repoRoot || !isContained(root, repoRoot)) {
    fail("PATH_OUTSIDE_CANONICAL_ROOT", "repository worktree root escaped the canonical root");
  }
  const expected = join(repoRoot, taskName);
  if (!isContained(root, expected)) fail("PATH_OUTSIDE_CANONICAL_ROOT", "worktree path escaped the canonical root");
  assertNotSymlink(expected);
  if (existsSync(expected) && realpathSync(expected) !== expected) {
    fail("PATH_SYMLINK", "worktree path is aliased");
  }
  return expected;
}

function validatePersistedPath(rootInput: string, repository: string, path: string): void {
  const root = resolve(rootInput);
  const repoName = safeSegment(repository.split("/")[1]!, "repository name");
  const taskName = safeSegment(basename(path), "task worktree name");
  const expected = join(root, repoName, taskName);
  if (resolve(path) !== expected || !isContained(root, expected)) {
    fail("PATH_OUTSIDE_CANONICAL_ROOT", "persisted worktree path escaped the canonical resolver");
  }
  if (existsSync(root)) {
    assertNotSymlink(root);
    if (realpathSync(root) !== root) fail("PATH_SYMLINK", "canonical worktree root is aliased");
  }
  const repoRoot = join(root, repoName);
  assertNotSymlink(repoRoot);
  if (existsSync(repoRoot) && realpathSync(repoRoot) !== repoRoot) {
    fail("PATH_SYMLINK", "repository worktree root is aliased");
  }
  assertNotSymlink(expected);
  if (existsSync(expected) && realpathSync(expected) !== expected) {
    fail("PATH_SYMLINK", "worktree path is aliased");
  }
}

function leaseIdentity(row: LeaseRow): TaskWorktreeIdentity {
  return {
    lease_id: row.lease_id,
    repository: row.repository,
    repo_catalog_id: row.repo_catalog_id,
    task_id: row.task_id,
    pr_group: row.pr_group,
    leaf: row.leaf,
    branch: row.branch,
    worktree_path: row.worktree_path,
    machine_id: row.machine_id,
    writer_generation: row.writer_generation,
    attempt: row.attempt,
    status: row.status,
    head_sha: row.head_sha,
    cleanup_policy: readCleanupPolicy(row.cleanup_policy),
    heartbeat_at: row.heartbeat_at,
    lease_expires_at: row.lease_expires_at,
  };
}

function leaseId(input: {
  repository: string;
  taskId: string;
  prGroup: string | null;
  leaf: string | null;
  branch: string;
  path: string;
}): string {
  return `tw_${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32)}`;
}

function withImmediate<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function readLease(
  db: Database,
  input: TaskWorktreeSelector,
  root: string,
): LeaseRow | null {
  let row: LeaseRow | null;
  if (input.leaseId) {
    row = db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(input.leaseId) as LeaseRow | null;
  } else if (input.worktreePath) {
    row = db.query("SELECT * FROM task_worktree_leases WHERE worktree_path = ?").get(resolve(input.worktreePath)) as LeaseRow | null;
  } else if (input.taskId) {
    row = db.query(`SELECT * FROM task_worktree_leases
      WHERE task_id = ?
      ORDER BY CASE WHEN status = 'cleaned' THEN 1 ELSE 0 END, updated_at DESC, lease_id DESC
      LIMIT 1`).get(input.taskId) as LeaseRow | null;
  } else {
    fail("INVALID_REQUEST", "leaseId, worktreePath, or taskId is required");
  }
  if (row) {
    if (input.taskId && safeValue(input.taskId, "task id") !== row.task_id) {
      fail("INVALID_REQUEST", "task selector contradicts the authoritative lease binding");
    }
    if (input.worktreePath && resolve(input.worktreePath) !== row.worktree_path) {
      fail("INVALID_REQUEST", "path selector contradicts the authoritative lease binding");
    }
    if (input.repository && canonicalRepository(input.repository) !== row.repository) {
      fail("INVALID_REQUEST", "repository selector contradicts the authoritative lease binding");
    }
    if (input.branch && safeBranch(input.branch) !== row.branch) {
      fail("INVALID_REQUEST", "branch selector contradicts the authoritative lease binding");
    }
    const repo = db.query("SELECT remote_url FROM repos WHERE id = ?").get(row.repo_catalog_id) as {
      remote_url: string | null;
    } | null;
    if (!repo) fail("REPOSITORY_NOT_FOUND", "lease repository registration no longer exists");
    if (repositoryIdentity(repo.remote_url) !== row.repository) {
      fail("REPOSITORY_IDENTITY_MISMATCH", "lease repository registration diverged from its stored identity");
    }
    validatePersistedPath(root, row.repository, row.worktree_path);
  }
  return row;
}

function receipt(
  db: Database,
  now: string,
  operation: TaskWorktreeOperation,
  outcome: TaskWorktreeOutcome,
  row: LeaseRow | null,
  ok = true,
  extras: Pick<TaskWorktreeReceipt, "gates" | "transition"> = {},
): TaskWorktreeReceipt {
  const sequence = row ? row.receipt_sequence + 1 : 1;
  const result: TaskWorktreeReceipt = {
    schema: TASK_WORKTREE_RECEIPT_SCHEMA,
    capability: TASK_WORKTREE_CAPABILITY,
    available: true,
    ok,
    receipt_id: randomUUID(),
    sequence,
    operation,
    outcome,
    at: now,
    lease: row ? leaseIdentity({ ...row, receipt_sequence: sequence }) : null,
    ...extras,
  };
  if (row) {
    db.query("UPDATE task_worktree_leases SET receipt_sequence = ?, updated_at = ? WHERE lease_id = ?")
      .run(sequence, now, row.lease_id);
    row.receipt_sequence = sequence;
    row.updated_at = now;
  }
  db.query(`INSERT INTO task_worktree_receipts
    (receipt_id, lease_id, sequence, operation, outcome, ok, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      result.receipt_id,
      row?.lease_id ?? null,
      sequence,
      operation,
      outcome,
      ok ? 1 : 0,
      JSON.stringify(result),
      now,
    );
  return result;
}

function fenced(
  row: LeaseRow,
  input: FencedTaskWorktreeOptions,
  now: string,
  allow: TaskWorktreeStatus[] = ["active"],
): void {
  const machine = machineIdentity(input.machineId);
  if (
    row.writer_generation !== safeValue(input.writerGeneration, "writer generation")
    || row.attempt !== safeValue(input.attempt, "attempt")
    || row.machine_id !== machine
  ) {
    fail("STALE_WRITER", "writer generation, attempt, or machine does not own this lease");
  }
  if (!allow.includes(row.status)) fail("LEASE_NOT_ACTIVE", `lease is ${row.status}`);
  if (row.lease_expires_at != null && row.lease_expires_at <= now) {
    fail("STALE_WRITER", "writer lease expired and requires recovery");
  }
}

function exactIdentity(
  row: LeaseRow,
  input: {
    repository: string;
    taskId: string;
    prGroup: string | null;
    leaf: string | null;
    branch: string;
    path: string;
    machineId: string;
    writerGeneration: string;
    attempt: string;
    cleanupPolicy: string;
  },
): boolean {
  return row.repository === input.repository
    && row.task_id === input.taskId
    && row.pr_group === input.prGroup
    && row.leaf === input.leaf
    && row.branch === input.branch
    && row.worktree_path === input.path
    && row.machine_id === input.machineId
    && row.writer_generation === input.writerGeneration
    && row.attempt === input.attempt
    && row.cleanup_policy === input.cleanupPolicy;
}

function appendGeneration(
  db: Database,
  row: LeaseRow,
  transition: "create_or_adopt" | "transfer" | "recover",
  now: string,
): void {
  const used = db.query(`SELECT 1 FROM task_worktree_generations
    WHERE lease_id = ? AND writer_generation = ?`)
    .get(row.lease_id, row.writer_generation);
  if (used) {
    fail("STALE_WRITER", "writer generation was already active and cannot be reused");
  }
  const latest = db.query(`SELECT COALESCE(MAX(generation_sequence), 0) AS sequence
    FROM task_worktree_generations WHERE lease_id = ?`)
    .get(row.lease_id) as { sequence: number };
  db.query(`INSERT INTO task_worktree_generations
    (lease_id, generation_sequence, writer_generation, attempt, machine_id, transition, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.lease_id,
      latest.sequence + 1,
      row.writer_generation,
      row.attempt,
      row.machine_id,
      transition,
      now,
    );
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
    "GIT_REPLACE_REF_BASE",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PROXY_COMMAND",
  ]) delete env[key];
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

function run(command: string, args: string[], cwd?: string, allowFailure = false): string | null {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: safeGitEnvironment(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail("CAPABILITY_OPERATION_FAILED", `${command} operation failed`);
  }
  return (result.stdout || "").trim();
}

function inspectGit(path: string): TaskWorktreeGitState {
  assertNotSymlink(path);
  if (!existsSync(path)) fail("GIT_STATE_INVALID", "worktree path does not exist");
  const root = run("git", ["rev-parse", "--show-toplevel"], path);
  if (!root || realpathSync(root) !== realpathSync(path)) fail("GIT_STATE_INVALID", "path is not an exact git worktree root");
  const branch = run("git", ["branch", "--show-current"], path);
  const head = run("git", ["rev-parse", "HEAD"], path);
  const remote = run("git", ["config", "--local", "--get", "remote.origin.url"], path);
  const repository = repositoryIdentity(remote);
  if (!branch || !head || !SHA.test(head) || !repository) fail("GIT_STATE_INVALID", "git identity is incomplete");
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], path);
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], path, true);
  const upstreamHead = upstream ? run("git", ["rev-parse", "@{u}"], path, true) : null;
  return {
    root: realpathSync(root),
    repository,
    branch,
    head,
    clean: status === "",
    upstream,
    upstreamHead: upstreamHead && SHA.test(upstreamHead) ? upstreamHead : null,
  };
}

export const defaultTaskWorktreeGitAdapter: TaskWorktreeGitAdapter = {
  create(input) {
    if (this.providerHead(input.repository, input.branch)) {
      fail("BRANCH_COLLISION", "provider branch already exists");
    }
    const temporary = `${input.target}.provisioning-${process.pid}-${randomUUID()}`;
    try {
      run("git", [
        "clone",
        "--origin",
        "origin",
        "--no-tags",
        "--single-branch",
        "--branch",
        input.baseBranch,
        `https://github.com/${input.repository}.git`,
        temporary,
      ]);
      run("git", ["switch", "-c", input.branch], temporary);
      assertNotSymlink(dirname(input.target));
      if (existsSync(input.target)) fail("WORKTREE_COLLISION", "worktree path became occupied during creation");
      try {
        renameSync(temporary, input.target);
      } catch {
        fail("CONCURRENT_MUTATION", "atomic worktree placement failed");
      }
      return inspectGit(input.target);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
  },
  inspect: inspectGit,
  providerHead(repository, branch) {
    const result = spawnSync(
      "git",
      ["ls-remote", "--heads", `https://github.com/${repository}.git`, `refs/heads/${branch}`],
      {
        encoding: "utf8",
        env: safeGitEnvironment(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status !== 0) fail("PROVIDER_UNREACHABLE", "provider branch lookup failed");
    const output = (result.stdout || "").trim();
    if (!output) return null;
    const head = output.split(/\s+/)[0] ?? "";
    if (!SHA.test(head)) fail("PROVIDER_UNREACHABLE", "provider branch lookup returned an invalid response");
    return head;
  },
  pullRequestState(repository, branch) {
    const output = run(
      "gh",
      ["pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--limit", "2", "--json", "state,mergedAt"],
      undefined,
      true,
    );
    if (output == null) return "unreachable";
    try {
      const rows = JSON.parse(output) as Array<{ state?: string; mergedAt?: string | null }>;
      if (!Array.isArray(rows) || rows.length === 0) return "absent";
      if (rows.length !== 1) return "unreachable";
      if (rows[0]?.mergedAt) return "merged";
      if (rows[0]?.state === "OPEN") return "open";
      if (rows[0]?.state === "CLOSED") return "closed";
      return "unreachable";
    } catch {
      return "unreachable";
    }
  },
  cleanup(path) {
    const gitFile = join(path, ".git");
    if (existsSync(gitFile) && !lstatSync(gitFile).isDirectory()) {
      run("git", ["worktree", "remove", "--", path], path);
      return;
    }
    rmSync(path, { recursive: true, force: false });
  },
};

export function getTaskWorktreeCapabilities(): TaskWorktreeCapabilities {
  return {
    schema: TASK_WORKTREE_CAPABILITY_SCHEMA,
    capability: TASK_WORKTREE_CAPABILITY,
    available: true,
    storage: "repos-sqlite",
    canonical_path: "$HOME/.hasna/repos/worktrees/<repo-name>/<task-worktree-name>",
    fallback: {
      allowed_when: "capability_absent",
      forbidden_when: "capability_failed",
    },
    operations: [
      "create_or_adopt",
      "status",
      "heartbeat",
      "transfer",
      "recover",
      "cleanup_eligibility",
      "cleanup",
    ],
    receipt_schema: TASK_WORKTREE_RECEIPT_SCHEMA,
    error_schema: TASK_WORKTREE_ERROR_SCHEMA,
  };
}

export class TaskWorktreeService {
  private readonly db: Database;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly defaultMachine: () => string;
  private readonly git: TaskWorktreeGitAdapter;

  constructor(options: TaskWorktreeServiceOptions = {}) {
    this.db = options.db ?? getDb();
    this.root = options.root ?? join(homedir(), ".hasna", "repos", "worktrees");
    this.now = options.now ?? (() => new Date());
    this.defaultMachine = options.machineId ?? (() => machineIdentity());
    this.git = options.git ?? defaultTaskWorktreeGitAdapter;
  }

  capabilities(): TaskWorktreeCapabilities {
    return getTaskWorktreeCapabilities();
  }

  createOrAdopt(options: CreateOrAdoptTaskWorktreeOptions): TaskWorktreeReceipt {
    const repository = canonicalRepository(options.repository);
    const taskId = safeValue(options.taskId, "task id");
    const prGroup = options.prGroup ? safeValue(options.prGroup, "PR group") : null;
    const leaf = options.leaf ? safeValue(options.leaf, "leaf") : null;
    const branch = safeBranch(options.branch);
    const machineId = machineIdentity(options.machineId ?? this.defaultMachine());
    const writerGeneration = safeValue(options.writerGeneration, "writer generation");
    const attempt = safeValue(options.attempt, "attempt");
    const path = resolveCanonicalPath(this.root, repository, options.taskWorktreeName, options.worktreePath);
    const now = iso(this.now());
    const leaseExpires = expiresAt(new Date(now), ttl(options.ttlSeconds));
    const persistedCleanupPolicy = cleanupPolicy(options.cleanupPolicy);
    const repositoryParts = repository.split("/");
    const owner = repositoryParts[0]!;
    const name = repositoryParts[1]!;
    const repos = this.db.query(
      `SELECT id, path, name, org, remote_url, default_branch FROM repos
       WHERE (org = ? AND name = ?) OR remote_url IN (?, ?, ?)
       ORDER BY CASE WHEN org = ? AND name = ? THEN 0 ELSE 1 END, id
       LIMIT 2`,
    ).all(
      owner,
      name,
      `github.com/${repository}`,
      `https://github.com/${repository}`,
      `https://github.com/${repository}.git`,
      owner,
      name,
    ) as RepoRow[];
    if (repos.length > 1) {
      fail("REPOSITORY_IDENTITY_MISMATCH", "repository registration is ambiguous");
    }
    const repo = repos[0] ?? null;
    if (!repo) fail("REPOSITORY_NOT_FOUND", "repository is not registered in Repos");
    if (repositoryIdentity(repo.remote_url) !== repository) {
      fail("REPOSITORY_IDENTITY_MISMATCH", "registered repository remote does not match the requested repository");
    }
    const id = leaseId({ repository, taskId, prGroup, leaf, branch, path });
    const desired = {
      repository,
      taskId,
      prGroup,
      leaf,
      branch,
      path,
      machineId,
      writerGeneration,
      attempt,
      cleanupPolicy: persistedCleanupPolicy,
    };

    let reservation: {
      collision: TaskWorktreeReceipt | null;
      stale: TaskWorktreeReceipt | null;
      row: LeaseRow | null;
      idempotent: boolean;
      reservationReceipt?: TaskWorktreeReceipt;
    };
    try {
      reservation = withImmediate(this.db, () => {
        const existing = this.db.query("SELECT * FROM task_worktree_leases WHERE worktree_path = ? OR lease_id = ? ORDER BY lease_id LIMIT 1")
          .get(path, id) as LeaseRow | null;
        const branchOwner = this.db.query(
          `SELECT * FROM task_worktree_leases
           WHERE repository = ? AND branch = ? AND status <> 'cleaned'
           LIMIT 1`,
        ).get(repository, branch) as LeaseRow | null;
        const taskOwner = this.db.query(
          `SELECT * FROM task_worktree_leases
           WHERE task_id = ? AND status <> 'cleaned'
           LIMIT 1`,
        ).get(taskId) as LeaseRow | null;
        const collision = existing && !exactIdentity(existing, desired)
          ? existing
          : branchOwner && branchOwner.lease_id !== existing?.lease_id
            ? branchOwner
            : taskOwner && taskOwner.lease_id !== existing?.lease_id
              ? taskOwner
            : null;
        if (collision) {
          const collisionReceipt = receipt(this.db, now, "create_or_adopt", "collision", collision, false);
          return {
            collision: collisionReceipt,
            stale: null,
            row: null as LeaseRow | null,
            idempotent: false,
          };
        }
        if (existing) {
          if (existing.status === "active") {
            if (existing.lease_expires_at != null && existing.lease_expires_at <= now) {
              const staleReceipt = receipt(this.db, now, "create_or_adopt", "collision", existing, false);
              return {
                collision: null,
                stale: staleReceipt,
                row: null as LeaseRow | null,
                idempotent: false,
              };
            }
            return {
              collision: null,
              stale: null,
              row: existing,
              idempotent: true,
            };
          }
          if (existing.status === "provisioning") {
            fail("CONCURRENT_MUTATION", "matching worktree creation is already in progress");
          }
          if (!["failed", "cleaned"].includes(existing.status)) {
            const collisionReceipt = receipt(this.db, now, "create_or_adopt", "collision", existing, false);
            return {
              collision: collisionReceipt,
              stale: null,
              row: null as LeaseRow | null,
              idempotent: false,
            };
          }
          if (this.db.query(`SELECT 1 FROM task_worktree_generations
            WHERE lease_id = ? AND writer_generation = ?`)
            .get(existing.lease_id, writerGeneration)) {
            const staleReceipt = receipt(this.db, now, "create_or_adopt", "collision", existing, false);
            return {
              collision: null,
              stale: staleReceipt,
              row: null as LeaseRow | null,
              idempotent: false,
            };
          }
          this.db.query(`UPDATE task_worktree_leases SET
            repo_catalog_id = ?, machine_id = ?, writer_generation = ?, attempt = ?,
            status = 'provisioning', head_sha = NULL, cleanup_policy = ?,
            heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
            WHERE lease_id = ?`)
            .run(repo.id, machineId, writerGeneration, attempt, persistedCleanupPolicy, now, leaseExpires, now, existing.lease_id);
          const reserved = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?")
            .get(existing.lease_id) as LeaseRow;
          const reservationReceipt = receipt(this.db, now, "create_or_adopt", "reserved", reserved);
          return {
            collision: null,
            stale: null,
            row: reserved,
            idempotent: false,
            reservationReceipt,
          };
        }
        this.db.query(`INSERT INTO task_worktree_leases (
          lease_id, repository, repo_catalog_id, task_id, pr_group, leaf, branch,
          worktree_path, machine_id, writer_generation, attempt, status, head_sha,
          cleanup_policy, heartbeat_at, lease_expires_at, receipt_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?, ?, 0, ?, ?)`)
          .run(
            id,
            repository,
            repo.id,
            taskId,
            prGroup,
            leaf,
            branch,
            path,
            machineId,
            writerGeneration,
            attempt,
            persistedCleanupPolicy,
            now,
            leaseExpires,
            now,
            now,
          );
        const reserved = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?")
          .get(id) as LeaseRow;
        const reservationReceipt = receipt(this.db, now, "create_or_adopt", "reserved", reserved);
        return {
          collision: null,
          stale: null,
          row: reserved,
          idempotent: false,
          reservationReceipt,
        };
      });
    } catch (error) {
      if (error instanceof TaskWorktreeError) throw error;
      fail("CAPABILITY_OPERATION_FAILED", "task worktree reservation failed");
    }
    if (reservation.collision) {
      fail("WORKTREE_COLLISION", "worktree identity collides with an existing or active writer", reservation.collision);
    }
    if (reservation.stale) {
      fail("STALE_WRITER", "writer lease expired and requires recovery", reservation.stale);
    }
    const row = reservation.row!;

    try {
      const existed = existsSync(path);
      let state: TaskWorktreeGitState;
      if (existed) {
        try {
          state = this.git.inspect(path);
        } catch {
          fail("WORKTREE_COLLISION", "occupied worktree path is not adoptable");
        }
      } else {
        state = this.git.create({
            repository,
            branch,
            baseBranch: safeBranch(options.baseBranch ?? repo.default_branch ?? "main"),
            target: path,
          });
      }
      assertNotSymlink(path);
      if (
        state.root !== realpathSync(path)
        || state.repository !== repository
        || state.branch !== branch
        || !SHA.test(state.head)
      ) {
        fail(
          existed ? "WORKTREE_COLLISION" : "GIT_STATE_INVALID",
          existed
            ? "occupied worktree path has a conflicting git identity"
            : "worktree git identity does not match the lease",
        );
      }
      return withImmediate(this.db, () => {
        const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow | null;
        if (!current || !exactIdentity(current, desired) || !["provisioning", "active"].includes(current.status)) {
          fail("CONCURRENT_MUTATION", "worktree lease changed during create or adopt");
        }
        if (current.status === "provisioning") {
          appendGeneration(this.db, current, "create_or_adopt", now);
        }
        this.db.query(`UPDATE task_worktree_leases SET
          status = 'active', head_sha = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE lease_id = ?`)
          .run(state.head, now, leaseExpires, now, current.lease_id);
        const active = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(current.lease_id) as LeaseRow;
        return receipt(
          this.db,
          now,
          "create_or_adopt",
          existed || reservation.idempotent ? "adopted" : "created",
          active,
        );
      });
    } catch (error) {
      let persistedReceipt: TaskWorktreeReceipt | undefined;
      try {
        persistedReceipt = withImmediate(this.db, () => {
          const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow | null;
          if (
            current
            && (
              current.status === "provisioning"
              || (reservation.idempotent && current.status === "active")
            )
          ) {
            this.db.query("UPDATE task_worktree_leases SET status = 'failed', lease_expires_at = NULL, updated_at = ? WHERE lease_id = ?")
              .run(now, current.lease_id);
            const failed = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(current.lease_id) as LeaseRow;
            return receipt(
              this.db,
              now,
              "create_or_adopt",
              error instanceof TaskWorktreeError
                && ["WORKTREE_COLLISION", "BRANCH_COLLISION"].includes(error.code)
                ? "collision"
                : "failed",
              failed,
              false,
            );
          }
          return undefined;
        });
      } catch {
        withImmediate(this.db, () => {
          const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow | null;
          if (
            current
            && (
              current.status === "provisioning"
              || (reservation.idempotent && current.status === "active")
            )
          ) {
            this.db.query("UPDATE task_worktree_leases SET status = 'failed', lease_expires_at = NULL, updated_at = ? WHERE lease_id = ?")
              .run(now, current.lease_id);
          }
        });
      }
      if (error instanceof TaskWorktreeError) {
        throw new TaskWorktreeError(
          error.code,
          error.message,
          error.receipt ?? persistedReceipt ?? reservation.reservationReceipt,
        );
      }
      fail(
        "CAPABILITY_OPERATION_FAILED",
        "create or adopt operation failed",
        persistedReceipt ?? reservation.reservationReceipt,
      );
    }
  }

  status(input: TaskWorktreeSelector): TaskWorktreeReceipt {
    const now = iso(this.now());
    return withImmediate(this.db, () => {
      const row = readLease(this.db, input, this.root);
      if (!row) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
      if (existsSync(row.worktree_path)) {
        const state = this.git.inspect(row.worktree_path);
        if (
          state.repository !== row.repository
          || state.branch !== row.branch
          || (row.head_sha && state.head !== row.head_sha && row.status !== "active")
        ) {
          fail("GIT_STATE_INVALID", "persisted lease and worktree identity diverged");
        }
        if (row.status === "active" && row.head_sha !== state.head) {
          this.db.query("UPDATE task_worktree_leases SET head_sha = ?, updated_at = ? WHERE lease_id = ?")
            .run(state.head, now, row.lease_id);
          row.head_sha = state.head;
          row.updated_at = now;
        }
      } else if (["provisioning", "active", "cleanup_pending", "cleanup_blocked", "cleanup_failed"].includes(row.status)) {
        fail("GIT_STATE_INVALID", "persisted worktree path is missing");
      }
      return receipt(this.db, now, "status", "status", row);
    });
  }

  heartbeat(options: FencedTaskWorktreeOptions & { ttlSeconds?: number }): TaskWorktreeReceipt {
    const now = iso(this.now());
    const leaseExpires = expiresAt(new Date(now), ttl(options.ttlSeconds));
    return withImmediate(this.db, () => {
      const row = readLease(this.db, options, this.root);
      if (!row) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
      fenced(row, options, now);
      this.db.query("UPDATE task_worktree_leases SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE lease_id = ?")
        .run(now, leaseExpires, now, row.lease_id);
      const updated = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow;
      return receipt(this.db, now, "heartbeat", "heartbeat", updated);
    });
  }

  transfer(options: TransferTaskWorktreeOptions): TaskWorktreeReceipt {
    const now = iso(this.now());
    const leaseExpires = expiresAt(new Date(now), ttl(options.ttlSeconds));
    const toGeneration = safeValue(options.newWriterGeneration, "new writer generation");
    const toAttempt = safeValue(options.newAttempt, "new attempt");
    const toMachine = machineIdentity(options.newMachineId);
    return withImmediate(this.db, () => {
      const row = readLease(this.db, options, this.root);
      if (!row) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
      fenced(row, options, now);
      if (toGeneration === row.writer_generation) {
        fail("INVALID_REQUEST", "transfer target must use a new writer generation");
      }
      if (this.db.query(`SELECT 1 FROM task_worktree_generations
        WHERE lease_id = ? AND writer_generation = ?`).get(row.lease_id, toGeneration)) {
        fail("STALE_WRITER", "writer generation was already active and cannot be reused");
      }
      const transition = {
        from_generation: row.writer_generation,
        from_attempt: row.attempt,
        to_generation: toGeneration,
        to_attempt: toAttempt,
        from_machine: row.machine_id,
        to_machine: toMachine,
      };
      this.db.query(`UPDATE task_worktree_leases SET
        machine_id = ?, writer_generation = ?, attempt = ?, heartbeat_at = ?,
        lease_expires_at = ?, updated_at = ? WHERE lease_id = ?`)
        .run(toMachine, toGeneration, toAttempt, now, leaseExpires, now, row.lease_id);
      const updated = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow;
      appendGeneration(this.db, updated, "transfer", now);
      return receipt(this.db, now, "transfer", "transferred", updated, true, { transition });
    });
  }

  recover(options: RecoverTaskWorktreeOptions): TaskWorktreeReceipt {
    const now = iso(this.now());
    const leaseExpires = expiresAt(new Date(now), ttl(options.ttlSeconds));
    const observedGeneration = safeValue(options.observedWriterGeneration, "observed writer generation");
    const observedAttempt = safeValue(options.observedAttempt, "observed attempt");
    const toGeneration = safeValue(options.newWriterGeneration, "new writer generation");
    const toAttempt = safeValue(options.newAttempt, "new attempt");
    const toMachine = machineIdentity(options.newMachineId);
    return withImmediate(this.db, () => {
      const row = readLease(this.db, options, this.root);
      if (!row) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
      if (row.writer_generation !== observedGeneration || row.attempt !== observedAttempt) {
        fail("STALE_WRITER", "observed generation or attempt is stale");
      }
      const expired = row.lease_expires_at != null && row.lease_expires_at <= now;
      if (row.status === "active" && !expired) fail("LEASE_NOT_EXPIRED", "active writer lease has not expired");
      if (!["active", "cleanup_blocked", "cleanup_failed", "failed"].includes(row.status)) {
        fail("LEASE_NOT_ACTIVE", `lease cannot be recovered from ${row.status}`);
      }
      if (toGeneration === row.writer_generation) {
        fail("INVALID_REQUEST", "recovery must fence the previous writer generation");
      }
      if (this.db.query(`SELECT 1 FROM task_worktree_generations
        WHERE lease_id = ? AND writer_generation = ?`).get(row.lease_id, toGeneration)) {
        fail("STALE_WRITER", "writer generation was already active and cannot be reused");
      }
      const state = this.git.inspect(row.worktree_path);
      if (state.repository !== row.repository || state.branch !== row.branch) {
        fail("GIT_STATE_INVALID", "worktree identity changed before recovery");
      }
      const transition = {
        from_generation: row.writer_generation,
        from_attempt: row.attempt,
        to_generation: toGeneration,
        to_attempt: toAttempt,
        from_machine: row.machine_id,
        to_machine: toMachine,
      };
      this.db.query(`UPDATE task_worktree_leases SET
        status = 'active', machine_id = ?, writer_generation = ?, attempt = ?,
        head_sha = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE lease_id = ?`)
        .run(toMachine, toGeneration, toAttempt, state.head, now, leaseExpires, now, row.lease_id);
      const updated = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow;
      appendGeneration(this.db, updated, "recover", now);
      return receipt(this.db, now, "recover", "recovered", updated, true, { transition });
    });
  }

  cleanup(options: CleanupTaskWorktreeOptions): TaskWorktreeReceipt {
    const preflight = readLease(this.db, options, this.root);
    if (!preflight) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
    const preflightRoot = canonicalRoot(this.root);
    if (!isContained(preflightRoot, preflight.worktree_path)) {
      fail("PATH_OUTSIDE_CANONICAL_ROOT", "cleanup path escaped the canonical root");
    }
    assertNotSymlink(preflight.worktree_path);
    const now = iso(this.now());
    const prepared = withImmediate(this.db, () => {
      const row = readLease(this.db, options, this.root);
      if (!row) fail("LEASE_NOT_FOUND", "task worktree lease was not found");
      fenced(row, options, now);
      this.db.query("UPDATE task_worktree_leases SET status = 'cleanup_pending', lease_expires_at = NULL, updated_at = ? WHERE lease_id = ?")
        .run(now, row.lease_id);
      return this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(row.lease_id) as LeaseRow;
    });

    let state: TaskWorktreeGitState | null = null;
    let providerHead: string | null = null;
    let providerFailed = false;
    try {
      const root = canonicalRoot(this.root);
      if (!isContained(root, prepared.worktree_path)) fail("PATH_OUTSIDE_CANONICAL_ROOT", "cleanup path escaped the canonical root");
      assertNotSymlink(prepared.worktree_path);
      state = this.git.inspect(prepared.worktree_path);
      providerHead = this.git.providerHead(prepared.repository, prepared.branch);
    } catch (error) {
      providerFailed = true;
    }

    const policy = readCleanupPolicy(prepared.cleanup_policy);
    const prMode = policy.pullRequest ?? "none";
    const prState = prMode === "none"
      ? "absent"
      : this.git.pullRequestState(prepared.repository, prepared.branch);
    const prPass = prMode === "none"
      || (prMode === "merged" && prState === "merged")
      || (prMode === "closed-or-merged" && (prState === "closed" || prState === "merged"));
    const gates: TaskWorktreeGate[] = [
      { id: "path_contained", passed: !providerFailed, detail: providerFailed ? "path or git inspection failed" : "canonical path verified" },
      { id: "writer_retired", passed: true, detail: "fenced writer was atomically retired before cleanup checks" },
      { id: "worktree_clean", passed: state?.clean === true, detail: state?.clean ? "worktree and index are clean" : "worktree or index is dirty or unreadable" },
      {
        id: "branch_pushed",
        passed: Boolean(state && state.upstream === `origin/${prepared.branch}` && state.upstreamHead === state.head),
        detail: state && state.upstream === `origin/${prepared.branch}` && state.upstreamHead === state.head
          ? "local head equals its origin upstream"
          : "branch lacks an exact pushed origin upstream",
      },
      {
        id: "provider_reachable",
        passed: Boolean(state && providerHead === state.head),
        detail: state && providerHead === state.head
          ? "exact head is reachable from the provider branch"
          : "provider branch does not prove the exact head",
      },
      {
        id: "pull_request_policy",
        passed: prPass,
        detail: prPass ? `policy ${prMode} permits cleanup` : `policy ${prMode} rejected provider state ${prState}`,
      },
    ];
    let eligible = gates.every((gate) => gate.passed);
    const operation: TaskWorktreeOperation = options.eligibilityOnly ? "cleanup_eligibility" : "cleanup";
    if (eligible && !options.eligibilityOnly) {
      try {
        assertNotSymlink(prepared.worktree_path);
        const finalState = this.git.inspect(prepared.worktree_path);
        const finalProviderHead = this.git.providerHead(prepared.repository, prepared.branch);
        const finalPrState = prMode === "none"
          ? "absent"
          : this.git.pullRequestState(prepared.repository, prepared.branch);
        const finalPrPass = prMode === "none"
          || (prMode === "merged" && finalPrState === "merged")
          || (prMode === "closed-or-merged" && (finalPrState === "closed" || finalPrState === "merged"));
        gates[0] = {
          id: "path_contained",
          passed: finalState.root === realpathSync(prepared.worktree_path)
            && finalState.repository === prepared.repository
            && finalState.branch === prepared.branch,
          detail: "canonical identity revalidated immediately before cleanup",
        };
        gates[2] = {
          id: "worktree_clean",
          passed: finalState.clean,
          detail: finalState.clean
            ? "worktree and index remained clean at final check"
            : "worktree or index changed after initial cleanup check",
        };
        gates[3] = {
          id: "branch_pushed",
          passed: finalState.upstream === `origin/${prepared.branch}` && finalState.upstreamHead === finalState.head,
          detail: finalState.upstream === `origin/${prepared.branch}` && finalState.upstreamHead === finalState.head
            ? "pushed origin upstream remained exact at final check"
            : "branch or upstream changed after initial cleanup check",
        };
        gates[4] = {
          id: "provider_reachable",
          passed: finalProviderHead === finalState.head,
          detail: finalProviderHead === finalState.head
            ? "provider still reaches the exact final head"
            : "provider reachability changed after initial cleanup check",
        };
        gates[5] = {
          id: "pull_request_policy",
          passed: finalPrPass,
          detail: finalPrPass
            ? `policy ${prMode} still permits cleanup`
            : `policy ${prMode} rejected final provider state ${finalPrState}`,
        };
      } catch {
        gates[0] = {
          id: "path_contained",
          passed: false,
          detail: "path or git identity changed during final cleanup revalidation",
        };
      }
      eligible = gates.every((gate) => gate.passed);
    }
    if (options.eligibilityOnly || !eligible) {
      return withImmediate(this.db, () => {
        const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(prepared.lease_id) as LeaseRow | null;
        if (!current || current.status !== "cleanup_pending") {
          fail("CONCURRENT_MUTATION", "cleanup lease changed during gate evaluation");
        }
        this.db.query("UPDATE task_worktree_leases SET status = 'cleanup_blocked', updated_at = ? WHERE lease_id = ?")
          .run(now, current.lease_id);
        const blocked = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(current.lease_id) as LeaseRow;
        return receipt(
          this.db,
          now,
          operation,
          eligible ? "eligible" : "blocked",
          blocked,
          eligible,
          { gates },
        );
      });
    }

    try {
      assertNotSymlink(prepared.worktree_path);
      this.git.cleanup(prepared.worktree_path);
      if (existsSync(prepared.worktree_path)) fail("CLEANUP_FAILED", "cleanup left the worktree path present");
    } catch (error) {
      withImmediate(this.db, () => {
        const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(prepared.lease_id) as LeaseRow;
        this.db.query("UPDATE task_worktree_leases SET status = 'cleanup_failed', updated_at = ? WHERE lease_id = ?")
          .run(now, current.lease_id);
        const failed = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(current.lease_id) as LeaseRow;
        receipt(this.db, now, "cleanup", "failed", failed, false, { gates });
      });
      if (error instanceof TaskWorktreeError) throw error;
      fail("CLEANUP_FAILED", "worktree cleanup failed");
    }

    return withImmediate(this.db, () => {
      const current = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(prepared.lease_id) as LeaseRow | null;
      if (!current || current.status !== "cleanup_pending") {
        fail("CONCURRENT_MUTATION", "cleanup lease changed before completion");
      }
      this.db.query("UPDATE task_worktree_leases SET status = 'cleaned', updated_at = ? WHERE lease_id = ?")
        .run(now, current.lease_id);
      const cleaned = this.db.query("SELECT * FROM task_worktree_leases WHERE lease_id = ?").get(current.lease_id) as LeaseRow;
      return receipt(this.db, now, "cleanup", "cleaned", cleaned, true, { gates });
    });
  }
}

export function createTaskWorktreeService(options: TaskWorktreeServiceOptions = {}): TaskWorktreeService {
  return new TaskWorktreeService(options);
}
