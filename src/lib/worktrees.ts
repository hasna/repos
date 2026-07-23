import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/database.js";

export type WorktreeLeaseStatus =
  | "preparing"
  | "creating"
  | "active"
  | "releasing"
  | "release_committing"
  | "quarantining"
  | "quarantine_finalizing"
  | "quarantine_committing"
  | "quarantine_compensating"
  | "quarantine_failed"
  | "worktree_failed"
  | "released"
  | "failed"
  | "quarantined";

export interface WorktreeLease {
  lease_id: string;
  canonical_repo: string;
  task_id: string;
  run_id: string;
  machine_id: string;
  canonical_path: string;
  branch: string;
  owner: string;
  status: WorktreeLeaseStatus;
  generation: number;
  fencing_token: string;
  idempotency_key: string | null;
  source: string | null;
  base_ref: string | null;
  head_sha: string | null;
  expires_at_ms: number;
  heartbeat_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  released_at_ms: number | null;
  metadata: Record<string, unknown>;
}

interface WorktreeLeaseRow extends Omit<WorktreeLease, "metadata"> {
  metadata_json: string;
}

export interface WorktreeIssue {
  code: string;
  severity: "info" | "warn" | "block";
  message: string;
  ref?: string;
}

export interface GitInspection {
  path: string;
  exists: boolean;
  is_git_worktree: boolean;
  top_level: string | null;
  branch: string | null;
  detached: boolean;
  head_sha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: {
    staged: number;
    modified: number;
    untracked: number;
  };
  issues: WorktreeIssue[];
}

export interface ClaimWorktreeOptions {
  repo: string;
  source?: string;
  taskId: string;
  runId: string;
  machineId: string;
  branch?: string;
  owner: string;
  root?: string;
  baseRef?: string;
  ttlSeconds?: number;
  idempotencyKey?: string;
}

interface ResolvedClaimWorktreeOptions extends Omit<ClaimWorktreeOptions, "branch"> {
  branch: string;
  source: string;
  verifiedDefaultBranch: string;
}

export interface ImportWorktreeOptions {
  repo: string;
  taskId: string;
  runId: string;
  machineId: string;
  branch: string;
  owner: string;
  path: string;
  root?: string;
  ttlSeconds?: number;
  idempotencyKey?: string;
}

export interface FencedLeaseOptions {
  leaseId?: string;
  path?: string;
  generation: number;
  fencingToken: string;
}

export interface WorktreeResult {
  ok: boolean;
  action: string;
  code?: string;
  message?: string;
  idempotent?: boolean;
  lease?: WorktreeLease;
  git?: GitInspection;
  issues?: WorktreeIssue[];
}

export interface InventoryOptions {
  root?: string;
  limit?: number;
}

const OWNERSHIP_PREDICATE = `(status NOT IN ('released', 'failed', 'quarantined')
  OR (status = 'released' AND NOT (
    COALESCE(json_type(metadata_json, '$.release_finalized'), '') = 'true'
    AND COALESCE(json_type(metadata_json, '$.release_verified_head_sha'), '') = 'text'
    AND length(json_extract(metadata_json, '$.release_verified_head_sha')) = 40
    AND json_extract(metadata_json, '$.release_verified_head_sha') NOT GLOB '*[^0-9a-f]*'
    AND json_extract(metadata_json, '$.release_verified_head_sha') = head_sha
    AND COALESCE(json_type(metadata_json, '$.release_finalized_at_ms'), '') = 'integer'
    AND json_extract(metadata_json, '$.release_finalized_at_ms') >= 0
  ))
  OR (status = 'quarantined' AND NOT (
    COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') = 'true'
    AND COALESCE(json_type(metadata_json, '$.verified_head_sha'), '') = 'text'
    AND length(json_extract(metadata_json, '$.verified_head_sha')) = 40
    AND json_extract(metadata_json, '$.verified_head_sha') NOT GLOB '*[^0-9a-f]*'
    AND json_extract(metadata_json, '$.verified_head_sha') = head_sha
    AND json_extract(metadata_json, '$.quarantine_path') = canonical_path
    AND json_extract(metadata_json, '$.backup_ref') = 'refs/hasna/worktrees/' || lease_id || '/' || generation
    AND COALESCE(json_type(metadata_json, '$.quarantine_finalized_at_ms'), '') = 'integer'
    AND json_extract(metadata_json, '$.quarantine_finalized_at_ms') >= 0
  )))`;
const DEFAULT_TTL_SECONDS = 60 * 60 * 6;
const PREPARING_COMPLETION_TIMEOUT_MS = 2 * 60 * 1000;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const DEFAULT_ROOT = () => process.env["HASNA_REPOS_WORKTREES_ROOT"]
  || join(process.env["HOME"] || "/home/hasna", ".hasna", "repos", "worktrees");

function safeJsonParse(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapLease(row: WorktreeLeaseRow | null | undefined): WorktreeLease | undefined {
  if (!row) return undefined;
  const { metadata_json, ...rest } = row;
  return { ...rest, metadata: safeJsonParse(metadata_json) };
}

function nowMs(): number {
  const db = getDb();
  const current = Date.now();
  const row = db.query("SELECT value FROM automation_state WHERE key = ?").get("worktree_leases.clock_ms") as { value: string } | null;
  const previous = row ? Number(row.value) || 0 : 0;
  const next = Math.max(current, previous + 1);
  db.query(`INSERT INTO automation_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run("worktree_leases.clock_ms", String(next));
  return next;
}

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return sanitized || fallback;
}

function stableHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function newLeaseId(): string {
  return `wt_${randomUUID().replaceAll("-", "")}`;
}

function githubRepoIdentity(input: string): string | null {
  const value = input.trim().replace(/^git\+/, "");
  const patterns = [
    /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return `${sanitizeSegment(match[1]!, "owner")}/${sanitizeSegment(match[2]!, "repo")}`;
  }
  return null;
}

function rawOriginUrl(path: string): string | null {
  const result = runGit(["config", "--local", "--no-includes", "--get-all", "remote.origin.url"], path);
  if (!result.ok) return null;
  const urls = result.stdout.split("\n").map((url) => url.trim()).filter(Boolean);
  return urls.length === 1 ? urls[0]! : null;
}

function rawOriginRepoIdentity(path: string): string | null {
  if (hasUnsafeLocalTransportConfig(path)) return null;
  const remote = rawOriginUrl(path);
  if (!remote) return null;
  const identity = githubRepoIdentity(remote);
  if (!identity) return null;
  const pushResult = runGit(["config", "--local", "--no-includes", "--get-all", "remote.origin.pushurl"], path);
  if (!pushResult.ok && pushResult.exitCode !== 1) return null;
  const pushUrls = pushResult.ok
    ? pushResult.stdout.split("\n").map((url) => url.trim()).filter(Boolean)
    : [];
  if (pushUrls.length > 1) return null;
  if (pushUrls.length === 1 && githubRepoIdentity(pushUrls[0]!) !== identity) return null;
  const effectiveFetch = runGit(["remote", "get-url", "origin"], path);
  if (!effectiveFetch.ok || effectiveFetch.stdout.trim() !== remote) return null;
  const effectivePush = runGit(["remote", "get-url", "--push", "--all", "origin"], path);
  const effectivePushUrls = effectivePush.ok
    ? effectivePush.stdout.split("\n").map((url) => url.trim()).filter(Boolean)
    : [];
  const rawPush = pushUrls[0] || remote;
  if (effectivePushUrls.length !== 1 || effectivePushUrls[0] !== rawPush) return null;
  return identity;
}

function hasUnsafeLocalTransportConfig(path: string): boolean {
  const result = runGit([
    "config",
    "--includes",
    "--get-regexp",
    "^(core\\.sshcommand|core\\.gitproxy|remote\\.origin\\.(uploadpack|receivepack|proxy|vcs)|url\\..*\\.(insteadof|pushinsteadof)|http\\..*)$",
  ], path);
  if (result.ok) return result.stdout.trim().length > 0;
  return result.exitCode !== 1;
}

export function canonicalizeRepo(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("repo is required");

  if ((trimmed.startsWith("/") || trimmed.startsWith(".")) && existsSync(trimmed)) {
    const identity = rawOriginRepoIdentity(trimmed);
    if (identity) return identity;
    throw new Error("repo path must have exactly one raw GitHub origin URL");
  }

  const github = githubRepoIdentity(trimmed);
  if (github) return github;
  const bare = trimmed.match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i);
  if (bare) {
    return `${sanitizeSegment(bare[1]!, "owner")}/${sanitizeSegment(bare[2]!, "repo")}`;
  }
  throw new Error("repo must be an owner/name or a GitHub HTTPS/SSH URL");
}

export function defaultWorktreeBranch(options: Pick<ClaimWorktreeOptions, "taskId" | "runId">): string {
  const task = sanitizeSegment(options.taskId, "task").slice(0, 12);
  return `codewith/worktree-${task}-${stableHash(options.runId, 8)}`;
}

export function defaultWorktreePath(
  options: Pick<ClaimWorktreeOptions, "repo" | "machineId" | "root">,
  leaseId: string,
): string {
  const root = options.root || DEFAULT_ROOT();
  const repo = canonicalizeRepo(options.repo);
  const repoName = sanitizeSegment(repo.split("/").pop() || repo, "repo");
  const machine = sanitizeSegment(options.machineId, "unknown-machine");
  const lease = /^wt_[0-9a-f]{16,64}$/i.test(leaseId) ? leaseId.toLowerCase() : `wt_${stableHash(leaseId, 24)}`;
  return join(root, machine, `${repoName}-${stableHash(repo)}`, lease, "repo");
}

function gitSourceFor(options: Pick<ClaimWorktreeOptions, "repo" | "source">): string {
  const source = options.source?.trim() || options.repo.trim();
  if (existsSync(source)) return resolve(source);
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(source)) return `https://github.com/${source}.git`;
  return source;
}

function resolvedClaimOptions(
  options: ClaimWorktreeOptions,
  source: string,
  verifiedDefaultBranch: string,
  persistedBaseRef?: string | null,
): ResolvedClaimWorktreeOptions {
  return {
    ...options,
    branch: options.branch?.trim() || defaultWorktreeBranch(options),
    source,
    baseRef: options.baseRef?.trim() || persistedBaseRef || verifiedDefaultBranch,
    verifiedDefaultBranch,
  };
}

function sourceRepoIdentity(source: string): string | null {
  let localPath = source;
  if (source.startsWith("file://")) {
    try { localPath = fileURLToPath(source); } catch { return null; }
  }
  if (existsSync(localPath)) {
    return rawOriginRepoIdentity(localPath);
  }
  return githubRepoIdentity(source);
}

function sourceIsLocal(source: string): boolean {
  return localSourcePath(source) !== null;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function localSourcePath(source: string): string | null {
  if (existsSync(source)) return resolve(source);
  if (!source.startsWith("file://")) return null;
  try {
    const path = fileURLToPath(source);
    return existsSync(path) ? resolve(path) : null;
  } catch {
    return null;
  }
}

function effectiveSourceUrl(source: string): string | null {
  const result = spawnSync("git", ["ls-remote", "--get-url", source], {
    encoding: "utf8",
    env: process.env,
    timeout: 30000,
  });
  if (result.status !== 0) return null;
  const urls = (result.stdout || "").split("\n").map((url) => url.trim()).filter(Boolean);
  return urls.length === 1 ? urls[0]! : null;
}

function sourceTransportWasRewritten(source: string): boolean {
  if (sourceIsLocal(source)) return false;
  if (!githubRepoIdentity(source)) return false;
  const effective = effectiveSourceUrl(source);
  return effective === null || effective !== source;
}

function inheritedSshTransportControl(source: string): string | null {
  if (!/^git@github\.com:|^ssh:\/\/git@github\.com\//i.test(source)) return null;
  for (const key of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_PROXY_COMMAND"]) {
    if (process.env[key]?.trim()) return key;
  }
  const configured = spawnSync("git", ["config", "--get", "core.sshCommand"], {
    encoding: "utf8",
    env: process.env,
    timeout: 30000,
  });
  return configured.status === 0 && configured.stdout.trim() ? "core.sshCommand" : null;
}

function protectedBranch(branch: string, baseRef?: string): boolean {
  const name = branch.replace(/^refs\/heads\//, "").toLowerCase();
  const protectedNames = new Set(["main", "master", "trunk", "develop", "development", "production"]);
  if (protectedNames.has(name)) return true;
  if (!baseRef) return false;
  const baseName = baseRef.replace(/^refs\/(?:heads|remotes)\//, "").replace(/^origin\//, "").toLowerCase();
  return Boolean(baseName && name === baseName);
}

function probeRemoteDefaultBranch(remote: string, cwd: string): string | null {
  const result = runGit(["ls-remote", "--symref", remote, "HEAD"], cwd);
  if (!result.ok) return null;
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2) return null;
  const ref = lines[0]!.match(/^ref:\s+(refs\/heads\/(\S+))\s+HEAD$/);
  const head = lines[1]!.match(/^([0-9a-f]{40,64})\s+HEAD$/);
  if (!ref || !head) return null;
  const branch = ref[2]!;
  const valid = runGit(["check-ref-format", "--branch", branch], cwd);
  return valid.ok ? branch : null;
}

function probeOriginDefaultBranch(path: string): string | null {
  return probeRemoteDefaultBranch("origin", path);
}

function probeSourceDefaultBranch(source: string): string | null {
  const local = localSourcePath(source);
  return local
    ? probeOriginDefaultBranch(local)
    : probeRemoteDefaultBranch(source, process.cwd());
}

class DefaultBranchContractError extends Error {
  constructor(readonly code: "remote_default_branch_unverified" | "remote_default_branch_changed" | "protected_branch", message: string) {
    super(message);
    this.name = "DefaultBranchContractError";
  }
}

function assertStableDefaultBranch(
  path: string,
  request: Pick<ResolvedClaimWorktreeOptions, "branch" | "verifiedDefaultBranch">,
): void {
  const currentDefault = probeOriginDefaultBranch(path);
  if (!currentDefault) {
    throw new DefaultBranchContractError(
      "remote_default_branch_unverified",
      "could not re-verify the repository default branch from origin HEAD before activation",
    );
  }
  if (currentDefault !== request.verifiedDefaultBranch) {
    if (currentDefault === request.branch) {
      throw new DefaultBranchContractError(
        "protected_branch",
        `refusing repository default branch activation: ${request.branch}`,
      );
    }
    throw new DefaultBranchContractError(
      "remote_default_branch_changed",
      `repository default branch changed during activation: ${request.verifiedDefaultBranch} -> ${currentDefault}`,
    );
  }
  if (currentDefault === request.branch) {
    throw new DefaultBranchContractError(
      "protected_branch",
      `refusing repository default branch activation: ${request.branch}`,
    );
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSafePath(path: string, root = DEFAULT_ROOT()): string {
  const rootAbs = resolve(root);
  mkdirSync(rootAbs, { recursive: true });
  if (lstatSync(rootAbs).isSymbolicLink()) {
    throw new Error(`worktree root is a symlink: ${rootAbs}`);
  }

  const target = resolve(path);
  const rel = relative(rootAbs, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`worktree path escapes root: ${target}`);
  }

  let current = rootAbs;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`worktree path contains symlink segment: ${current}`);
    }
  }
  return target;
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: sanitizedGitEnv(), timeout: 30000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    exitCode: result.status,
  };
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => {
      if (value === undefined) return false;
      return !/^(GIT_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|CURL_CA_BUNDLE$|SSL_CERT_FILE$|SSL_CERT_DIR$)/i.test(key);
    }),
  );
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function isGitWorktree(path: string): boolean {
  if (!existsSync(path)) return false;
  const result = runGit(["rev-parse", "--show-toplevel"], path);
  return result.ok && resolve(result.stdout.trim()) === resolve(path);
}

function resolveBaseRef(source: string, requested?: string): string {
  if (requested) return requested;
  const originMain = runGit(["rev-parse", "--verify", "origin/main"], source);
  return originMain.ok ? "origin/main" : "HEAD";
}

function resolveBaseCommit(source: string, requested?: string): string | null {
  const ref = requested || "origin/HEAD";
  const normalized = ref
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/heads\//, "");
  const candidates = [ref];
  if (!normalized.startsWith("origin/")) candidates.push(`origin/${normalized}`);
  for (const candidate of [...new Set(candidates)]) {
    const result = runGit(["rev-parse", "--verify", `${candidate}^{commit}`], source);
    if (result.ok) return result.stdout.trim();
  }
  return null;
}

function validateExistingTarget(options: ResolvedClaimWorktreeOptions, target: string): string {
  if (!isGitWorktree(target)) throw new Error(`target path exists and is not a git worktree: ${target}`);
  const branch = runGit(["symbolic-ref", "--short", "HEAD"], target);
  if (!branch.ok || branch.stdout.trim() !== options.branch) {
    throw new Error(`existing worktree branch mismatch: ${branch.stdout.trim() || "detached"} != ${options.branch}`);
  }
  if (rawOriginRepoIdentity(target) !== canonicalizeRepo(options.repo)) {
    throw new Error("existing worktree repository does not match the requested repo");
  }
  const status = runGit(["status", "--porcelain=v1"], target);
  if (!status.ok || status.stdout.trim()) throw new Error("existing worktree is not clean");
  const head = readHead(target) || "";
  const baseRef = existsSync(options.source) ? resolveBaseRef(options.source, options.baseRef) : options.baseRef;
  const base = resolveBaseCommit(target, baseRef);
  if (!base || base !== head) {
    throw new Error(`existing worktree HEAD does not match base ${baseRef}`);
  }
  validateUrlTargetAgainstRemoteBase(options, target, head);
  if (existsSync(options.source) && isGitWorktree(options.source)) {
    const sourceCommon = gitCommonDir(options.source);
    const targetCommon = gitCommonDir(target);
    if (!sourceCommon || sourceCommon !== targetCommon) {
      throw new Error("existing worktree does not belong to the source git common directory");
    }
    const registered = runGit(["worktree", "list", "--porcelain"], options.source);
    if (!registered.ok || !registered.stdout.split("\n").some((line) => line === `worktree ${resolve(target)}`)) {
      throw new Error("existing worktree is not registered by the source repository");
    }
  }
  return head;
}

function leaseIdentityIssues(lease: WorktreeLease, path = lease.canonical_path, git = inspectGitWorktree(path)): WorktreeIssue[] {
  const issues: WorktreeIssue[] = [];
  if (!git.exists) issues.push({ code: "path_missing", severity: "block", message: "lease path is missing", ref: path });
  if (git.exists && !git.is_git_worktree) issues.push({ code: "not_git_worktree", severity: "block", message: "lease path is not a git worktree", ref: path });
  if (git.detached) issues.push({ code: "detached_head", severity: "block", message: "detached HEAD worktrees are not safe", ref: path });
  if (git.detached || git.branch !== lease.branch) issues.push({ code: "branch_mismatch", severity: "block", message: "active lease branch identity changed", ref: git.branch || "detached" });
  if (git.is_git_worktree) {
    if (rawOriginRepoIdentity(path) !== lease.canonical_repo) {
      issues.push({ code: "repo_mismatch", severity: "block", message: "lease repository identity changed", ref: path });
    }
    if (lease.source && resolve(lease.source) !== resolve(path) && existsSync(lease.source) && isGitWorktree(lease.source)) {
      const sourceCommon = gitCommonDir(lease.source);
      const targetCommon = gitCommonDir(path);
      if (!sourceCommon || sourceCommon !== targetCommon) {
        issues.push({ code: "git_common_dir_mismatch", severity: "block", message: "lease detached from its source git authority", ref: path });
      } else {
        const registered = runGit(["worktree", "list", "--porcelain"], lease.source);
        if (!registered.ok || !registered.stdout.split("\n").some((line) => line === `worktree ${resolve(path)}`)) {
          issues.push({ code: "worktree_registration_mismatch", severity: "block", message: "lease path is not registered by its source repository", ref: path });
        }
      }
    }
  }
  return issues;
}

function validateActiveReplay(lease: WorktreeLease): { git: GitInspection; issues: WorktreeIssue[] } {
  const git = inspectGitWorktree(lease.canonical_path);
  const issues = leaseIdentityIssues(lease, lease.canonical_path, git);
  return { git, issues };
}

function activeReplayResult(lease: WorktreeLease, action = "claim"): WorktreeResult {
  const { git, issues } = validateActiveReplay(lease);
  return issues.length > 0
    ? { ok: false, action, code: "active_lease_invalid", idempotent: true, lease, git, issues }
    : { ok: true, action, idempotent: true, lease, git };
}

function gitCommonDir(path: string): string | null {
  const result = runGit(["rev-parse", "--git-common-dir"], path);
  return result.ok ? resolve(path, result.stdout.trim()) : null;
}

function withGitMutationLocks<T>(
  path: string,
  branch: string,
  operation: () => T,
  extraRefs: string[] = [],
): T {
  const indexResult = runGit(["rev-parse", "--git-path", "index"], path);
  const commonDir = gitCommonDir(path);
  if (!indexResult.ok || !commonDir) throw new Error("could not resolve Git mutation lock paths");
  const indexPath = isAbsolute(indexResult.stdout.trim())
    ? indexResult.stdout.trim()
    : resolve(path, indexResult.stdout.trim());
  const lockPaths = [
    `${indexPath}.lock`,
    join(commonDir, "config.lock"),
    join(commonDir, "refs", "heads", `${branch}.lock`),
    ...extraRefs.map((ref) => gitRefLockPath(commonDir, ref)),
  ];
  const locks: Array<{ path: string; fd: number }> = [];
  try {
    for (const lockPath of lockPaths) {
      mkdirSync(dirname(lockPath), { recursive: true });
      try {
        locks.push({ path: lockPath, fd: acquireGitMutationLock(lockPath) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new GitMutationLockBusyError(lockPath);
        }
        throw error;
      }
    }
    return operation();
  } finally {
    for (const lock of locks.reverse()) {
      try { closeSync(lock.fd); } catch {}
      try { unlinkSync(lock.path); } catch {}
    }
  }
}

function withLeaseOperationLock<T>(
  lease: WorktreeLease,
  operation: string,
  callback: () => T,
): T {
  const configuredRoot = lease.metadata["worktree_root"];
  if (typeof configuredRoot !== "string" || !configuredRoot.trim()) {
    throw new Error("lease does not record a trusted worktree root");
  }
  const root = resolve(configuredRoot);
  assertSafePath(lease.canonical_path, root);
  const lockPath = assertSafePath(join(
    root,
    ".control-plane-locks",
    `${sanitizeSegment(operation, "operation")}-${sanitizeSegment(lease.lease_id, "lease")}-${lease.generation}.lock`,
  ), root);
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = acquireGitMutationLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GitMutationLockBusyError(lockPath);
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function acquireGitMutationLock(path: string): number {
  const create = (): number => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({
      owner: "hasna-repos-worktree-control-plane",
      pid: process.pid,
      created_at_ms: Date.now(),
    }));
    return fd;
  };
  try {
    return create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const reclaimed = reclaimStaleOwnedGitLock(path, create);
    if (reclaimed === null) throw error;
    return reclaimed;
  }
}

function reclaimStaleOwnedGitLock(path: string, create: () => number): number | null {
  const reclaim = getDb().transaction((): number | null => {
    if (!staleOwnedGitLock(path)) return null;
    try {
      unlinkSync(path);
    } catch {
      return null;
    }
    try {
      return create();
    } catch {
      return null;
    }
  });
  return reclaim();
}

function staleOwnedGitLock(path: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record["owner"] !== "hasna-repos-worktree-control-plane"
    || typeof record["pid"] !== "number"
    || !Number.isInteger(record["pid"])
    || record["pid"] <= 0) {
    return false;
  }
  try {
    process.kill(record["pid"], 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  return true;
}

function gitRefLockPath(commonDir: string, ref: string): string {
  if (!ref.startsWith("refs/") || ref.includes("\\") || ref.split("/").includes("..")) {
    throw new Error(`invalid Git ref lock path: ${ref}`);
  }
  const root = resolve(commonDir);
  const lockPath = resolve(root, `${ref}.lock`);
  if (lockPath === root || !lockPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Git ref lock escapes common directory: ${ref}`);
  }
  const valid = spawnSync("git", ["check-ref-format", ref], {
    encoding: "utf8",
    env: sanitizedGitEnv(),
  });
  if (valid.status !== 0) throw new Error(`invalid Git ref lock path: ${ref}`);
  return lockPath;
}

class GitMutationLockBusyError extends Error {
  constructor(path: string) {
    super(`Git mutation lock is busy: ${path}`);
    this.name = "GitMutationLockBusyError";
  }
}

function createGitWorktree(options: ResolvedClaimWorktreeOptions, target: string): string {
  if (existsSync(target)) {
    if (isGitWorktree(target)) return validateExistingTarget(options, target);
    if (readdirSync(target).length > 0) throw new Error(`target path exists and is not a git worktree: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(join(target, ".."), { recursive: true });
  const source = options.source;
  if (existsSync(source) && isGitWorktree(source)) {
    const baseRef = resolveBaseRef(source, options.baseRef);
    const result = runGit(["worktree", "add", "-b", options.branch, target, baseRef], source);
    if (!result.ok) throw new Error(result.stderr.trim() || `git worktree add failed with ${result.exitCode}`);
    return readHead(target) || "";
  }

  const clone = spawnSync("git", ["clone", "--no-checkout", source, target], {
    encoding: "utf8",
    env: sanitizedGitEnv(),
    timeout: 120000,
  });
  if (clone.status !== 0) throw new Error(clone.stderr || clone.error?.message || "git clone failed");
  const localSource = localSourcePath(source);
  if (localSource) {
    const canonicalOrigin = rawOriginUrl(localSource);
    if (!canonicalOrigin || githubRepoIdentity(canonicalOrigin) !== canonicalizeRepo(options.repo)) {
      throw new Error("local clone source does not have the canonical GitHub origin");
    }
    const setOrigin = runGit(["remote", "set-url", "origin", canonicalOrigin], target);
    if (!setOrigin.ok) throw new Error(setOrigin.stderr.trim() || "failed to set canonical clone origin");
  }
  const baseRef = options.baseRef || "origin/HEAD";
  const baseCommit = resolveBaseCommit(target, baseRef);
  if (!baseCommit) throw new Error(`clone base ref not found: ${baseRef}`);
  const switchResult = runGit(["switch", "-c", options.branch, baseCommit], target);
  if (!switchResult.ok) throw new Error(switchResult.stderr.trim() || "git switch failed");
  const head = readHead(target) || "";
  validateUrlTargetAgainstRemoteBase(options, target, head);
  return head;
}

function remoteBranchRef(ref: string | undefined): string | null {
  const requested = (ref || "main").trim();
  const normalized = requested
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "")
    .replace(/^refs\/heads\//, "");
  if (!normalized || normalized.startsWith("refs/")) return null;
  return `refs/heads/${normalized}`;
}

function probeOriginRef(path: string, ref: string): {
  ok: boolean;
  sha?: string;
  code?: "remote_branch_missing" | "remote_probe_failed" | "remote_probe_invalid";
} {
  const probe = runGit(["ls-remote", "--exit-code", "origin", ref], path);
  if (!probe.ok) {
    return {
      ok: false,
      code: probe.exitCode === 2 ? "remote_branch_missing" : "remote_probe_failed",
    };
  }
  const matches = probe.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed = matches.length === 1 ? matches[0]!.split(/\s+/) : [];
  const sha = parsed[1] === ref && /^[0-9a-f]{40,64}$/i.test(parsed[0] || "") ? parsed[0]! : null;
  return sha ? { ok: true, sha } : { ok: false, code: "remote_probe_invalid" };
}

function validateUrlTargetAgainstRemoteBase(
  options: ResolvedClaimWorktreeOptions,
  target: string,
  head: string,
): void {
  const expectedRepo = canonicalizeRepo(options.repo);
  if (rawOriginRepoIdentity(target) !== expectedRepo) {
    throw new Error("validated origin identity does not match the requested repository");
  }
  const localSource = localSourcePath(options.source);
  if (localSource) {
    const sourceBase = resolveBaseCommit(localSource, options.baseRef);
    if (!sourceBase || sourceBase !== head) {
      throw new Error(`validated local source base ${options.baseRef || "main"} does not match worktree HEAD`);
    }
    const ref = remoteBranchRef(options.baseRef);
    if (!ref) throw new Error(`validated origin base is not a branch: ${options.baseRef || "main"}`);
    const remote = probeOriginRef(target, ref);
    if (!remote.ok) throw new Error(`validated origin ${remote.code}: ${ref}`);
    if (remote.sha !== head) {
      throw new Error(`validated origin base ${ref} does not match worktree HEAD`);
    }
    return;
  }
  const ref = remoteBranchRef(options.baseRef);
  if (!ref) throw new Error(`validated origin base is not a branch: ${options.baseRef || "main"}`);
  const remote = probeOriginRef(target, ref);
  if (!remote.ok) throw new Error(`validated origin ${remote.code}: ${ref}`);
  if (remote.sha !== head) {
    throw new Error(`validated origin base ${ref} does not match worktree HEAD`);
  }
}

function readHead(path: string): string | null {
  const head = runGit(["rev-parse", "HEAD"], path);
  return head.ok ? head.stdout.trim() : null;
}

function queryLeaseByIdOrPath(options: { leaseId?: string; path?: string }): WorktreeLease | undefined {
  if (options.leaseId) {
    return mapLease(getDb().query("SELECT * FROM worktree_leases WHERE lease_id = ?").get(options.leaseId) as WorktreeLeaseRow | null);
  }
  if (options.path) {
    const canonicalPath = resolve(options.path);
    return mapLease(getDb().query("SELECT * FROM worktree_leases WHERE canonical_path = ? ORDER BY created_at_ms DESC LIMIT 1").get(canonicalPath) as WorktreeLeaseRow | null);
  }
  return undefined;
}

function conflictingSelector(options: { leaseId?: string; path?: string }, action: string): WorktreeResult | undefined {
  if (!options.leaseId || !options.path) return undefined;
  const byId = mapLease(getDb().query("SELECT * FROM worktree_leases WHERE lease_id = ?").get(options.leaseId) as WorktreeLeaseRow | null);
  if (!byId || resolve(options.path) !== resolve(byId.canonical_path)) {
    return { ok: false, action, code: "conflicting_selector", message: "leaseId and path do not identify the same worktree", lease: byId };
  }
  return undefined;
}

function activeCollision(canonicalRepo: string, branch: string, canonicalPath: string): WorktreeLease | undefined {
  return mapLease(getDb().query(`SELECT * FROM worktree_leases
    WHERE ${OWNERSHIP_PREDICATE}
      AND (canonical_path = ? OR (canonical_repo = ? AND branch = ?))
    ORDER BY created_at_ms ASC LIMIT 1`).get(canonicalPath, canonicalRepo, branch) as WorktreeLeaseRow | null);
}

function isSameClaim(lease: WorktreeLease, options: ResolvedClaimWorktreeOptions, canonicalRepo: string): boolean {
  return lease.canonical_repo === canonicalRepo
    && lease.task_id === options.taskId
    && lease.run_id === options.runId
    && lease.machine_id === options.machineId
    && lease.branch === options.branch
    && lease.owner === options.owner
    && lease.source === options.source
    && lease.base_ref === (options.baseRef || null);
}

function leaseByIdempotency(idempotencyKey: string | undefined): WorktreeLease | undefined {
  if (!idempotencyKey) return undefined;
  return mapLease(getDb().query("SELECT * FROM worktree_leases WHERE idempotency_key = ?").get(idempotencyKey) as WorktreeLeaseRow | null);
}

function requestMismatchIssues(lease: WorktreeLease, options: ResolvedClaimWorktreeOptions, canonicalRepo: string, canonicalPath: string): WorktreeIssue[] {
  const expectedSource = options.source;
  const expectedBaseRef = options.baseRef || null;
  const fields: Array<[keyof WorktreeLease, unknown]> = [
    ["canonical_repo", canonicalRepo],
    ["task_id", options.taskId],
    ["run_id", options.runId],
    ["machine_id", options.machineId],
    ["canonical_path", canonicalPath],
    ["branch", options.branch],
    ["owner", options.owner],
    ["source", expectedSource],
    ["base_ref", expectedBaseRef],
  ];
  return fields
    .filter(([field, expected]) => lease[field] !== expected)
    .map(([field, expected]) => ({
      code: "idempotency_request_mismatch",
      severity: "block" as const,
      message: `idempotency key belongs to a different ${String(field)}`,
      ref: `${String(lease[field])} != ${String(expected)}`,
    }));
}

function validateIdempotentReplay(lease: WorktreeLease, options: ResolvedClaimWorktreeOptions, canonicalRepo: string, canonicalPath: string): WorktreeIssue[] {
  const issues = requestMismatchIssues(lease, options, canonicalRepo, canonicalPath);
  if (issues.length === 0) return [];
  return [
    {
      code: "idempotency_key_conflict",
      severity: "block",
      message: "idempotency key was already used for a different worktree lease request",
      ref: options.idempotencyKey,
    },
    ...issues,
  ];
}

function insertPreparingLease(
  options: ResolvedClaimWorktreeOptions,
  canonicalRepo: string,
  canonicalPath: string,
  leaseId: string,
  action: "claim" | "import",
): WorktreeLease {
  const db = getDb();
  const now = nowMs();
  const token = randomUUID();
  const ttl = Math.max(1, options.ttlSeconds || DEFAULT_TTL_SECONDS);
  db.query(`INSERT INTO worktree_leases (
    lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
    owner, status, generation, fencing_token, idempotency_key, source, base_ref,
    expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json,
    repo_path, worktree_path
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      leaseId,
      canonicalRepo,
      options.taskId,
      options.runId,
      options.machineId,
      canonicalPath,
      options.branch,
      options.owner,
      token,
      options.idempotencyKey || null,
      options.source,
      options.baseRef || null,
      now + ttl * 1000,
      now,
      now,
      now,
      JSON.stringify({
        created_by: `repos.worktrees.${action}`,
        worktree_root: resolve(options.root || DEFAULT_ROOT()),
      }),
      options.source,
      canonicalPath,
    );
  return queryLeaseByIdOrPath({ leaseId })!;
}

function transitionLease(lease: WorktreeLease, nextStatus: WorktreeLeaseStatus, metadata: Record<string, unknown> = {}): WorktreeLease | undefined {
  const now = nowMs();
  const merged = { ...lease.metadata, ...metadata };
  const result = getDb().query(`UPDATE worktree_leases SET
      status = ?, updated_at_ms = ?, released_at_ms = CASE WHEN ? IN ('released', 'quarantined') THEN ? ELSE released_at_ms END,
      metadata_json = ?
    WHERE lease_id = ? AND status = ? AND generation = ?`).run(
      nextStatus,
      now,
      nextStatus,
      now,
      JSON.stringify(merged),
      lease.lease_id,
      lease.status,
      lease.generation,
    );
  return result.changes === 1 ? queryLeaseByIdOrPath({ leaseId: lease.lease_id }) : undefined;
}

export function claimWorktree(options: ClaimWorktreeOptions): WorktreeResult {
  try {
    if (![options.repo, options.taskId, options.runId, options.machineId, options.owner].every(nonEmpty)) {
      return { ok: false, action: "claim", code: "missing_required_key", message: "repo, taskId, runId, machineId, and owner must be nonempty" };
    }
    const source = gitSourceFor(options);
    const canonicalRepo = canonicalizeRepo(options.repo);
    const sourceRepo = sourceRepoIdentity(source);
    if (sourceRepo !== canonicalRepo) {
      return {
        ok: false,
        action: "claim",
        code: "source_repo_mismatch",
        message: `source repository identity ${sourceRepo || "unknown"} does not match ${canonicalRepo}`,
      };
    }
    if (sourceTransportWasRewritten(source)) {
      return {
        ok: false,
        action: "claim",
        code: "source_transport_rewritten",
        message: "canonical source URL is redirected by effective Git fetch configuration",
      };
    }
    const unsafeSshControl = inheritedSshTransportControl(source);
    if (unsafeSshControl) {
      return {
        ok: false,
        action: "claim",
        code: "source_transport_unsafe",
        message: `canonical SSH source is affected by ${unsafeSshControl}`,
      };
    }

    const existing = leaseByIdempotency(options.idempotencyKey);
    const verifiedDefaultBranch = existing && isGitWorktree(existing.canonical_path)
      ? probeOriginDefaultBranch(existing.canonical_path)
      : probeSourceDefaultBranch(source);
    if (!verifiedDefaultBranch) {
      return {
        ok: false,
        action: "claim",
        code: "remote_default_branch_unverified",
        message: "could not verify the repository default branch from origin HEAD",
      };
    }
    const request = resolvedClaimOptions(options, source, verifiedDefaultBranch, existing?.base_ref);
    if (protectedBranch(request.branch, request.baseRef)
      || protectedBranch(request.branch, verifiedDefaultBranch)) {
      return { ok: false, action: "claim", code: "protected_branch", message: `refusing protected worktree branch: ${request.branch}` };
    }

    if (existing) {
      const canonicalPath = assertSafePath(defaultWorktreePath(request, existing.lease_id), request.root || DEFAULT_ROOT());
      const issues = validateIdempotentReplay(existing, request, canonicalRepo, canonicalPath);
      if (issues.length > 0) return { ok: false, action: "claim", code: "idempotency_key_conflict", idempotent: true, lease: existing, issues };
      if (existing.status === "active") return activeReplayResult(existing);
      if (existing.status === "preparing" || existing.status === "creating") {
        return completePreparingLease(existing, request, true);
      }
      return { ok: false, action: "claim", code: `idempotent_${existing.status}`, idempotent: true, lease: existing, message: `idempotency key belongs to ${existing.status} lease` };
    }

    const leaseId = newLeaseId();
    const canonicalPath = assertSafePath(defaultWorktreePath(request, leaseId), request.root || DEFAULT_ROOT());
    const collision = activeCollision(canonicalRepo, request.branch, canonicalPath);
    if (collision) {
      if (isSameClaim(collision, request, canonicalRepo)) {
        if (collision.status === "active") {
          return activeReplayResult(collision);
        }
        if (collision.status === "preparing" || collision.status === "creating") {
          return completePreparingLease(collision, request, true);
        }
      }
      const stale = collision.expires_at_ms < nowMs();
      return {
        ok: false,
        action: "claim",
        code: stale ? "stale_owner_rejected" : "owner_collision",
        lease: collision,
        message: stale ? "lease is expired but must be explicitly released; repos will not auto-steal" : "active owner collision",
      };
    }

    const lease = insertPreparingLease(request, canonicalRepo, canonicalPath, leaseId, "claim");
    return completePreparingLease(lease, request, false);
  } catch (error) {
    return { ok: false, action: "claim", code: "claim_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function completePreparingLease(lease: WorktreeLease, options: ResolvedClaimWorktreeOptions, idempotent: boolean): WorktreeResult {
  const claimed = claimPreparingCompletion(lease, "claim", idempotent);
  if ("result" in claimed) return claimed.result;
  try {
    const head = createGitWorktree(options, claimed.lease.canonical_path);
    return withGitMutationLocks(claimed.lease.canonical_path, claimed.lease.branch, () => {
      validateUrlTargetAgainstRemoteBase(options, claimed.lease.canonical_path, head);
      const git = inspectGitWorktree(claimed.lease.canonical_path);
      assertStableDefaultBranch(claimed.lease.canonical_path, options);
      const activated = activatePreparingCompletion(claimed.lease, claimed.token, head);
      if (!activated) return reconcilePreparingCompletion(claimed.lease, "claim", idempotent, git);
      const active = queryLeaseByIdOrPath({ leaseId: claimed.lease.lease_id })!;
      return { ok: true, action: "claim", idempotent, lease: active, git: inspectGitWorktree(active.canonical_path) };
    });
  } catch (error) {
    return releasePreparingCompletion(claimed.lease, claimed.token, "claim", idempotent, error);
  }
}

function claimPreparingCompletion(
  lease: WorktreeLease,
  action: "claim" | "import",
  idempotent: boolean,
): { lease: WorktreeLease; token: string } | { result: WorktreeResult } {
  if (lease.status !== "preparing" && lease.status !== "creating") {
    return { result: { ok: false, action, code: "lease_not_preparing", idempotent, lease } };
  }
  const now = nowMs();
  if (lease.status === "creating" && now - lease.updated_at_ms < PREPARING_COMPLETION_TIMEOUT_MS) {
    return {
      result: {
        ok: false,
        action,
        code: "claim_in_progress",
        idempotent,
        lease,
        message: "another caller owns worktree completion",
      },
    };
  }
  const token = randomUUID();
  const metadata = {
    ...lease.metadata,
    ...(action === "import" ? { created_by: "repos.worktrees.import" } : {}),
    preparing_completion_token: token,
    preparing_completion_started_at_ms: now,
  };
  const claimed = getDb().query(`UPDATE worktree_leases SET status = 'creating', updated_at_ms = ?, metadata_json = ?
    WHERE lease_id = ? AND status = ? AND generation = ? AND fencing_token = ? AND updated_at_ms = ?`).run(
    now,
    JSON.stringify(metadata),
    lease.lease_id,
    lease.status,
    lease.generation,
    lease.fencing_token,
    lease.updated_at_ms,
  );
  if (claimed.changes !== 1) {
    return { result: reconcilePreparingCompletion(lease, action, idempotent) };
  }
  return { lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id })!, token };
}

function preparingMetadata(
  lease: WorktreeLease,
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  const metadata = { ...lease.metadata, ...values };
  delete metadata["preparing_completion_token"];
  delete metadata["preparing_completion_started_at_ms"];
  return metadata;
}

function activatePreparingCompletion(lease: WorktreeLease, token: string, head: string | null): boolean {
  const now = nowMs();
  const activated = getDb().query(`UPDATE worktree_leases SET
      status = 'active', head_sha = ?, heartbeat_at_ms = ?, updated_at_ms = ?, metadata_json = ?
    WHERE lease_id = ? AND status = 'creating' AND generation = ? AND fencing_token = ?
      AND json_extract(metadata_json, '$.preparing_completion_token') = ?`).run(
    head || null,
    now,
    now,
    JSON.stringify(preparingMetadata(lease)),
    lease.lease_id,
    lease.generation,
    lease.fencing_token,
    token,
  );
  return activated.changes === 1;
}

function reconcilePreparingCompletion(
  lease: WorktreeLease,
  action: "claim" | "import",
  idempotent: boolean,
  git?: GitInspection,
): WorktreeResult {
  const current = queryLeaseByIdOrPath({ leaseId: lease.lease_id });
  if (current?.status === "active") return activeReplayResult(current, action);
  return {
    ok: false,
    action,
    code: current?.status === "creating" ? "claim_in_progress" : "cas_transition_failed",
    idempotent,
    lease: current || lease,
    git,
  };
}

function releasePreparingCompletion(
  lease: WorktreeLease,
  token: string,
  action: "claim" | "import",
  idempotent: boolean,
  error: unknown,
): WorktreeResult {
  const message = error instanceof Error ? error.message : String(error);
  const current = queryLeaseByIdOrPath({ leaseId: lease.lease_id });
  if (current?.status === "active") return activeReplayResult(current, action);
  if (current?.status === "creating"
    && current.metadata["preparing_completion_token"] === token) {
    getDb().query(`UPDATE worktree_leases SET status = 'preparing', updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'creating' AND generation = ? AND fencing_token = ?
        AND json_extract(metadata_json, '$.preparing_completion_token') = ?`).run(
      nowMs(),
      JSON.stringify(preparingMetadata(current, { preparing_error: message })),
      current.lease_id,
      current.generation,
      current.fencing_token,
      token,
    );
  }
  return {
    ok: false,
    action,
    code: error instanceof DefaultBranchContractError ? error.code : "worktree_create_failed",
    idempotent,
    lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
    message,
  };
}

export function importWorktree(options: ImportWorktreeOptions): WorktreeResult {
  try {
    if (![options.repo, options.taskId, options.runId, options.machineId, options.branch, options.owner].every(nonEmpty)) {
      return {
        ok: false,
        action: "import",
        code: "missing_required_key",
        message: "repo, taskId, runId, machineId, branch, and owner must be nonempty",
      };
    }
    if (!nonEmpty(options.path)) {
      return {
        ok: false,
        action: "import",
        code: "missing_required_path",
        message: "path must be nonempty",
      };
    }
    const canonicalRepo = canonicalizeRepo(options.repo);
    if (protectedBranch(options.branch)) {
      return { ok: false, action: "import", code: "protected_branch", message: `refusing protected branch import: ${options.branch}` };
    }
    const canonicalPath = assertSafePath(options.path, options.root || DEFAULT_ROOT());
    const git = inspectGitWorktree(canonicalPath);
    const blocking = safetyRefusals(git, undefined).filter((issue) => issue.code !== "unknown_owner");
    if (blocking.length > 0) return { ok: false, action: "import", code: "unsafe_import_refused", git, issues: blocking };
    if (rawOriginRepoIdentity(canonicalPath) !== canonicalRepo) {
      return { ok: false, action: "import", code: "repo_mismatch", git, message: "imported worktree repository does not match repo" };
    }
    const defaultBranch = probeOriginDefaultBranch(canonicalPath);
    if (!defaultBranch) {
      return {
        ok: false,
        action: "import",
        code: "remote_default_branch_unverified",
        git,
        message: "could not verify the repository default branch from origin HEAD",
      };
    }
    const request: ResolvedClaimWorktreeOptions = {
      ...options,
      source: canonicalPath,
      verifiedDefaultBranch: defaultBranch,
    };
    if (protectedBranch(options.branch, defaultBranch)) {
      return {
        ok: false,
        action: "import",
        code: "protected_branch",
        git,
        message: `refusing repository default branch import: ${options.branch}`,
      };
    }
    if (git.branch !== options.branch) {
      return {
        ok: false,
        action: "import",
        code: "branch_mismatch",
        git,
        issues: [{ code: "branch_mismatch", severity: "block", message: "import branch does not match the existing worktree branch", ref: git.branch || git.path }],
      };
    }
    const existing = leaseByIdempotency(options.idempotencyKey);
    if (existing) {
      const issues = validateIdempotentReplay(existing, request, canonicalRepo, canonicalPath);
      if (issues.length > 0) return { ok: false, action: "import", code: "idempotency_key_conflict", idempotent: true, lease: existing, git, issues };
      if (existing.status === "active") return activeReplayResult(existing, "import");
      if (existing.status === "preparing" || existing.status === "creating") {
        return completePreparingImportLease(existing, request, canonicalRepo, true);
      }
      return { ok: false, action: "import", code: `idempotent_${existing.status}`, idempotent: true, lease: existing, git, message: `idempotency key belongs to ${existing.status} lease` };
    }
    const collision = activeCollision(canonicalRepo, options.branch, canonicalPath);
    if (collision) {
      if (isSameClaim(collision, request, canonicalRepo)
        && (collision.status === "preparing" || collision.status === "creating")) {
        return completePreparingImportLease(collision, request, canonicalRepo, true);
      }
      return { ok: false, action: "import", code: "owner_collision", lease: collision, git };
    }

    const lease = insertPreparingLease(request, canonicalRepo, canonicalPath, newLeaseId(), "import");
    return completePreparingImportLease(lease, request, canonicalRepo, false);
  } catch (error) {
    return { ok: false, action: "import", code: "import_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function completePreparingImportLease(
  lease: WorktreeLease,
  request: ResolvedClaimWorktreeOptions,
  canonicalRepo: string,
  idempotent: boolean,
): WorktreeResult {
  const claimed = claimPreparingCompletion(lease, "import", idempotent);
  if ("result" in claimed) return claimed.result;
  try {
    return withGitMutationLocks(claimed.lease.canonical_path, claimed.lease.branch, () => {
      const git = inspectGitWorktree(claimed.lease.canonical_path);
      const blocking = safetyRefusals(git, undefined).filter((issue) => issue.code !== "unknown_owner");
      if (blocking.length > 0) throw new Error(`unsafe import: ${blocking.map((issue) => issue.code).join(",")}`);
      if (rawOriginRepoIdentity(claimed.lease.canonical_path) !== canonicalRepo) {
        throw new Error("imported worktree repository does not match repo");
      }
      if (git.branch !== request.branch) throw new Error(`import branch mismatch: ${git.branch || "detached"}`);
      assertStableDefaultBranch(claimed.lease.canonical_path, request);
      const activated = activatePreparingCompletion(claimed.lease, claimed.token, git.head_sha);
      if (!activated) return reconcilePreparingCompletion(claimed.lease, "import", idempotent, git);
      return {
        ok: true,
        action: "import",
        idempotent,
        lease: queryLeaseByIdOrPath({ leaseId: claimed.lease.lease_id }),
        git,
      };
    });
  } catch (error) {
    return releasePreparingCompletion(claimed.lease, claimed.token, "import", idempotent, error);
  }
}

export function renewWorktreeLease(options: FencedLeaseOptions & { ttlSeconds?: number }): WorktreeResult {
  const selector = conflictingSelector(options, "renew");
  if (selector) return selector;
  const lease = queryLeaseByIdOrPath(options);
  if (!lease) return { ok: false, action: "renew", code: "lease_not_found" };
  const fence = checkFence(lease, options);
  if (fence) return { ok: false, action: "renew", code: fence.code, message: fence.message, lease };
  const now = nowMs();
  const ttl = Math.max(1, options.ttlSeconds || DEFAULT_TTL_SECONDS);
  const expiresAt = Math.max(lease.expires_at_ms + 1, now + ttl * 1000);
  const token = randomUUID();
  const result = getDb().query(`UPDATE worktree_leases SET generation = generation + 1, fencing_token = ?, expires_at_ms = ?, heartbeat_at_ms = ?, updated_at_ms = ?
    WHERE lease_id = ? AND generation = ? AND fencing_token = ? AND status = 'active'`).run(token, expiresAt, now, now, lease.lease_id, options.generation, options.fencingToken);
  if (result.changes !== 1) return { ok: false, action: "renew", code: "cas_transition_failed", lease };
  return { ok: true, action: "renew", lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) };
}

function checkFence(lease: WorktreeLease, options: FencedLeaseOptions): { code: string; message: string } | undefined {
  if (lease.status !== "active") return { code: "lease_not_active", message: `lease is ${lease.status}` };
  if (lease.generation !== options.generation) return { code: "stale_generation", message: "generation does not match current lease" };
  if (lease.fencing_token !== options.fencingToken) return { code: "stale_fencing_token", message: "fencing token does not match current lease" };
  return undefined;
}

export function inspectWorktree(options: { leaseId?: string; path?: string }): WorktreeResult {
  const selector = conflictingSelector(options, "inspect");
  if (selector) return selector;
  const lease = queryLeaseByIdOrPath(options);
  const path = lease?.canonical_path || options.path;
  return {
    ok: Boolean(lease || path),
    action: "inspect",
    code: lease || path ? undefined : "lease_not_found",
    lease,
    git: path ? inspectGitWorktree(path) : undefined,
  };
}

export function verifyWorktree(options: { leaseId?: string; path?: string }): WorktreeResult {
  const selector = conflictingSelector(options, "verify");
  if (selector) return selector;
  const lease = queryLeaseByIdOrPath(options);
  const path = lease?.canonical_path || options.path;
  if (!path) return { ok: false, action: "verify", code: "lease_not_found" };
  const git = inspectGitWorktree(path);
  const issues = safetyRefusals(git, lease);
  return { ok: issues.length === 0, action: "verify", code: issues.length ? "unsafe_state" : undefined, lease, git, issues };
}

export function releaseWorktree(options: FencedLeaseOptions & { cleanup?: "none" | "quarantine" }): WorktreeResult {
  const selector = conflictingSelector(options, "release");
  if (selector) return selector;
  const lease = queryLeaseByIdOrPath(options);
  if (!lease) return { ok: false, action: "release", code: "lease_not_found" };
  if (lease.status === "preparing" || lease.status === "creating") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    if (lease.status === "creating" && nowMs() - lease.updated_at_ms < PREPARING_COMPLETION_TIMEOUT_MS) {
      return { ok: false, action: "release", code: "claim_in_progress", lease };
    }
    const now = nowMs();
    const terminalStatus = lease.status === "creating" || pathEntryExists(lease.canonical_path)
      ? "worktree_failed"
      : "failed";
    const metadata = JSON.stringify({ ...lease.metadata, abandoned_before_activation: true });
    const completionToken = lease.metadata["preparing_completion_token"];
    const failedResult = lease.status === "creating"
      ? typeof completionToken === "string"
        ? getDb().query(`UPDATE worktree_leases SET status = ?, updated_at_ms = ?, metadata_json = ?
            WHERE lease_id = ? AND status = 'creating' AND generation = ? AND fencing_token = ?
              AND updated_at_ms = ? AND json_extract(metadata_json, '$.preparing_completion_token') = ?`).run(
            terminalStatus,
            now,
            metadata,
            lease.lease_id,
            lease.generation,
            lease.fencing_token,
            lease.updated_at_ms,
            completionToken,
          )
        : { changes: 0 }
      : getDb().query(`UPDATE worktree_leases SET status = ?, updated_at_ms = ?, metadata_json = ?
          WHERE lease_id = ? AND status = 'preparing' AND generation = ? AND fencing_token = ? AND updated_at_ms = ?`).run(
          terminalStatus,
          now,
          metadata,
          lease.lease_id,
          lease.generation,
          lease.fencing_token,
          lease.updated_at_ms,
        );
    if (failedResult.changes !== 1) {
      return {
        ok: false,
        action: "release",
        code: "cas_transition_failed",
        lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
      };
    }
    const failed = queryLeaseByIdOrPath({ leaseId: lease.lease_id })!;
    return { ok: true, action: "release", lease: failed, git: inspectGitWorktree(lease.canonical_path) };
  }
  if (options.cleanup !== "quarantine" && lease.status === "releasing") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    return completeRelease(lease);
  }
  if (options.cleanup !== "quarantine" && lease.status === "release_committing") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    return completeReleaseCommit(lease);
  }
  if (options.cleanup !== "quarantine" && lease.status === "released") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    if (lease.metadata["release_finalized"] !== true) return resumeProvisionalRelease(lease);
    if (finalizedReleaseProofMatches(lease)) {
      return {
        ok: true,
        action: "release",
        idempotent: true,
        lease,
        git: inspectGitWorktree(lease.canonical_path),
        issues: [],
      };
    }
    return {
      ok: false,
      action: "release",
      code: "release_not_finalized",
      message: "released lease does not have a valid finalized proof",
      lease,
    };
  }
  if (options.cleanup === "quarantine"
    && (lease.status === "quarantining" || lease.status === "quarantine_finalizing")) {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    return completeQuarantine(lease);
  }
  if (options.cleanup === "quarantine" && lease.status === "quarantine_compensating") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    return completeQuarantineCompensation(lease);
  }
  if (options.cleanup === "quarantine" && lease.status === "quarantine_committing") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    return completeQuarantineCommit(lease);
  }
  if (options.cleanup === "quarantine" && lease.status === "quarantine_failed") {
    return {
      ok: false,
      action: "release",
      code: "quarantine_failed_terminal",
      message: "quarantine recovery retained an artifact and still reserves ownership",
      lease,
    };
  }
  if (options.cleanup === "quarantine" && lease.status === "quarantined") {
    if (lease.generation !== options.generation) return { ok: false, action: "release", code: "stale_generation", lease };
    if (lease.fencing_token !== options.fencingToken) return { ok: false, action: "release", code: "stale_fencing_token", lease };
    if (lease.metadata["quarantine_finalized"] !== true) return resumeProvisionalQuarantine(lease);
    if (finalizedQuarantineProofMatches(lease)) {
      return {
        ok: true,
        action: "release",
        idempotent: true,
        lease,
        git: inspectGitWorktree(lease.canonical_path),
        issues: [],
      };
    }
    return {
      ok: false,
      action: "release",
      code: "quarantine_not_finalized",
      message: "quarantined lease does not have a valid finalized proof",
      lease,
    };
  }
  const fence = checkFence(lease, options);
  if (fence) return { ok: false, action: "release", code: fence.code, message: fence.message, lease };
  const git = inspectGitWorktree(lease.canonical_path);
  const issues = safetyRefusals(git, lease);
  if (issues.length > 0) return { ok: false, action: "release", code: "unsafe_release_refused", lease, git, issues };

  if (options.cleanup !== "quarantine") {
    const expectedHead = git.head_sha;
    if (!expectedHead) return { ok: false, action: "release", code: "unsafe_release_refused", lease, git, issues };
    const metadata = {
      ...lease.metadata,
      release_expected_head_sha: expectedHead,
      release_finalized: false,
    };
    const claimed = getDb().query(`UPDATE worktree_leases SET status = 'releasing', head_sha = ?, updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'active' AND generation = ? AND fencing_token = ?`).run(
      expectedHead,
      nowMs(),
      JSON.stringify(metadata),
      lease.lease_id,
      lease.generation,
      lease.fencing_token,
    );
    if (claimed.changes !== 1) {
      const current = queryLeaseByIdOrPath({ leaseId: lease.lease_id });
      if (current && finalizedReleaseProofMatches(current)) {
        return { ok: true, action: "release", idempotent: true, lease: current, git: inspectGitWorktree(current.canonical_path), issues: [] };
      }
      return { ok: false, action: "release", code: "cas_transition_failed", lease: current || lease };
    }
    return completeRelease(queryLeaseByIdOrPath({ leaseId: lease.lease_id })!, git);
  }

  if (lease.metadata["legacy_layout"] === true) {
    return {
      ok: false,
      action: "release",
      code: "legacy_layout_cleanup_refused",
      message: "legacy-layout leases must be safely imported or relocated before quarantine cleanup",
      lease,
      git,
    };
  }
  let plannedQuarantinePath: string;
  try {
    plannedQuarantinePath = quarantinePathFor(lease);
  } catch (error) {
    return {
      ok: false,
      action: "release",
      code: "unsafe_quarantine_root",
      message: error instanceof Error ? error.message : String(error),
      lease,
      git,
    };
  }
  const backupRef = backupRefFor(lease);
  const locked = transitionLease(lease, "quarantining", {
    planned_quarantine_path: plannedQuarantinePath,
    planned_backup_ref: backupRef,
  });
  if (!locked) return { ok: false, action: "release", code: "cas_transition_failed", lease };
  return completeQuarantine(locked, git);
}

function completeRelease(locked: WorktreeLease, originalGit?: GitInspection): WorktreeResult {
  const expectedHead = locked.metadata["release_expected_head_sha"];
  if (typeof expectedHead !== "string") {
    const failed = failTransientLease(locked, "releasing", "release plan is missing");
    return { ok: false, action: "release", code: "release_plan_missing", lease: failed || locked };
  }
  try {
    const git = inspectGitWorktree(locked.canonical_path);
    const issues = safetyRefusals(git, locked, true);
    if (git.head_sha !== expectedHead) {
      issues.push({
        code: "release_head_changed",
        severity: "block",
        message: "worktree HEAD changed after the initial release proof",
        ref: `${expectedHead} != ${git.head_sha || "unknown"}`,
      });
    }
    if (issues.length > 0) {
      throw new Error(`release safety validation failed: ${issues.map((issue) => issue.code).join(",")}`);
    }
    const metadata = {
      ...locked.metadata,
      release_verified_head_sha: expectedHead,
      release_finalized: false,
    };
    const committed = getDb().query(`UPDATE worktree_leases SET
        status = 'release_committing', head_sha = ?, updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'releasing' AND generation = ? AND fencing_token = ?`).run(
        expectedHead,
        nowMs(),
        JSON.stringify(metadata),
        locked.lease_id,
        locked.generation,
        locked.fencing_token,
    );
    if (committed.changes !== 1) {
      const current = queryLeaseByIdOrPath({ leaseId: locked.lease_id });
      if (current && finalizedReleaseProofMatches(current)) {
        return { ok: true, action: "release", idempotent: true, lease: current, git, issues: [] };
      }
      return { ok: false, action: "release", code: "cas_transition_failed", lease: current || locked, git };
    }
    return completeReleaseCommit(queryLeaseByIdOrPath({ leaseId: locked.lease_id })!, git);
  } catch (error) {
    if (error instanceof GitMutationLockBusyError) {
      return {
        ok: false,
        action: "release",
        code: "terminal_lock_busy",
        message: error.message,
        lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
        git: originalGit,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = failTransientLease(locked, "releasing", message);
    if (failed && finalizedReleaseProofMatches(failed)) {
      return {
        ok: true,
        action: "release",
        idempotent: true,
        lease: failed,
        git: inspectGitWorktree(failed.canonical_path),
        issues: [],
      };
    }
    return {
      ok: false,
      action: "release",
      code: "release_failed",
      message,
      lease: failed || locked,
      git: originalGit,
    };
  }
}

function completeReleaseCommit(locked: WorktreeLease, originalGit?: GitInspection): WorktreeResult {
  const expectedHead = locked.metadata["release_verified_head_sha"];
  if (typeof expectedHead !== "string") {
    const failed = failTransientLease(locked, "release_committing", "release commit proof is missing");
    return { ok: false, action: "release", code: "release_plan_missing", lease: failed || locked };
  }
  try {
    return withGitMutationLocks(locked.canonical_path, locked.branch, () => {
      const git = inspectGitWorktree(locked.canonical_path);
      const issues = safetyRefusals(git, locked, true);
      if (git.head_sha !== expectedHead) {
        issues.push({ code: "release_head_changed", severity: "block", message: "worktree HEAD changed before terminal release", ref: git.head_sha || "unknown" });
      }
      if (issues.length > 0) throw new Error(`release commit validation failed: ${issues.map((issue) => issue.code).join(",")}`);
      const now = nowMs();
      const finalized = getDb().query(`UPDATE worktree_leases SET
          status = 'released', updated_at_ms = ?, released_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'release_committing' AND generation = ? AND fencing_token = ?`).run(
        now,
        now,
        JSON.stringify({
          ...locked.metadata,
          release_finalized: false,
        }),
        locked.lease_id,
        locked.generation,
        locked.fencing_token,
      );
      if (finalized.changes !== 1) {
        const current = queryLeaseByIdOrPath({ leaseId: locked.lease_id });
        if (current && finalizedReleaseProofMatches(current)) {
          return { ok: true, action: "release", idempotent: true, lease: current, git, issues: [] };
        }
        return { ok: false, action: "release", code: "cas_transition_failed", lease: current || locked, git };
      }
      const released = queryLeaseByIdOrPath({ leaseId: locked.lease_id })!;
      if (!releaseProofMatches(released, false) || readHead(released.canonical_path) !== expectedHead) {
        getDb().query(`UPDATE worktree_leases SET status = 'worktree_failed', updated_at_ms = ?, metadata_json = ?
          WHERE lease_id = ? AND status = 'released' AND generation = ? AND fencing_token = ?`).run(
          nowMs(),
          JSON.stringify({ ...released.metadata, release_error: "terminal release proof changed after CAS" }),
          released.lease_id,
          released.generation,
          released.fencing_token,
        );
        return {
          ok: false,
          action: "release",
          code: "release_failed",
          message: "terminal release proof changed after CAS",
          lease: queryLeaseByIdOrPath({ leaseId: released.lease_id }) || released,
          git,
        };
      }
      const finalizedAt = nowMs();
      const proofFinalized = getDb().query(`UPDATE worktree_leases SET updated_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'released' AND generation = ? AND fencing_token = ?
          AND COALESCE(json_type(metadata_json, '$.release_finalized'), '') != 'true'`).run(
        finalizedAt,
        JSON.stringify({
          ...released.metadata,
          release_finalized: true,
          release_finalized_at_ms: finalizedAt,
        }),
        released.lease_id,
        released.generation,
        released.fencing_token,
      );
      if (proofFinalized.changes !== 1) {
        return {
          ok: false,
          action: "release",
          code: "cas_transition_failed",
          lease: queryLeaseByIdOrPath({ leaseId: released.lease_id }) || released,
          git,
        };
      }
      return {
        ok: true,
        action: "release",
        lease: queryLeaseByIdOrPath({ leaseId: released.lease_id }),
        git,
        issues: [],
      };
    });
  } catch (error) {
    if (error instanceof GitMutationLockBusyError) {
      return {
        ok: false,
        action: "release",
        code: "terminal_lock_busy",
        message: error.message,
        lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
        git: originalGit,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = failTransientLease(locked, "release_committing", message);
    return { ok: false, action: "release", code: "release_failed", message, lease: failed || locked, git: originalGit };
  }
}

function releaseProofMatches(lease: WorktreeLease, requireFinalized = true): boolean {
  const expectedHead = lease.metadata["release_verified_head_sha"];
  if (lease.status !== "released"
    || (requireFinalized && lease.metadata["release_finalized"] !== true)
    || typeof expectedHead !== "string"
    || lease.head_sha !== expectedHead
    || !existsSync(lease.canonical_path)) {
    return false;
  }
  const git = inspectGitWorktree(lease.canonical_path);
  const releasingLease = { ...lease, status: "releasing" as const };
  return git.head_sha === expectedHead && safetyRefusals(git, releasingLease, true).length === 0;
}

function finalizedReleaseProofMatches(lease: WorktreeLease): boolean {
  return releaseProofMatches(lease, true);
}

function resumeProvisionalRelease(lease: WorktreeLease): WorktreeResult {
  try {
    return withGitMutationLocks(lease.canonical_path, lease.branch, () => {
      const git = inspectGitWorktree(lease.canonical_path);
      const expectedHead = lease.metadata["release_verified_head_sha"];
      if (typeof expectedHead !== "string"
        || !releaseProofMatches(lease, false)
        || readHead(lease.canonical_path) !== expectedHead) {
        getDb().query(`UPDATE worktree_leases SET status = 'worktree_failed', updated_at_ms = ?, metadata_json = ?
          WHERE lease_id = ? AND status = 'released' AND generation = ? AND fencing_token = ?
            AND COALESCE(json_type(metadata_json, '$.release_finalized'), '') != 'true'`).run(
          nowMs(),
          JSON.stringify({ ...lease.metadata, release_error: "provisional release proof is invalid" }),
          lease.lease_id,
          lease.generation,
          lease.fencing_token,
        );
        return {
          ok: false,
          action: "release",
          code: "release_failed",
          message: "provisional release proof is invalid",
          lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
          git,
        };
      }
      const finalizedAt = nowMs();
      const finalized = getDb().query(`UPDATE worktree_leases SET updated_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'released' AND generation = ? AND fencing_token = ?
          AND COALESCE(json_type(metadata_json, '$.release_finalized'), '') != 'true'`).run(
        finalizedAt,
        JSON.stringify({
          ...lease.metadata,
          release_finalized: true,
          release_finalized_at_ms: finalizedAt,
        }),
        lease.lease_id,
        lease.generation,
        lease.fencing_token,
      );
      if (finalized.changes !== 1) {
        return { ok: false, action: "release", code: "cas_transition_failed", lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease, git };
      }
      return {
        ok: true,
        action: "release",
        idempotent: true,
        lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }),
        git,
        issues: [],
      };
    });
  } catch (error) {
    return {
      ok: false,
      action: "release",
      code: error instanceof GitMutationLockBusyError ? "terminal_lock_busy" : "release_failed",
      message: error instanceof Error ? error.message : String(error),
      lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
    };
  }
}

function completeQuarantine(locked: WorktreeLease, originalGit?: GitInspection): WorktreeResult {
  try {
    return withLeaseOperationLock(
      locked,
      "quarantine",
      () => completeQuarantineWithOperationLock(locked, originalGit),
    );
  } catch (error) {
    return {
      ok: false,
      action: "release",
      code: error instanceof GitMutationLockBusyError ? "terminal_lock_busy" : "quarantine_failed",
      message: error instanceof Error ? error.message : String(error),
      lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
      git: originalGit,
    };
  }
}

function completeQuarantineWithOperationLock(
  locked: WorktreeLease,
  originalGit?: GitInspection,
): WorktreeResult {
  const planned = locked.metadata["planned_quarantine_path"];
  const recordedPlannedRef = locked.metadata["planned_backup_ref"];
  if (typeof planned !== "string") {
    const failed = failQuarantiningLease(locked, "quarantine plan is missing");
    return { ok: false, action: "release", code: "quarantine_plan_missing", lease: failed || locked };
  }
  const canonicalBackupRef = backupRefFor(locked);
  let safePlanned: string | undefined;
  let quarantinePath: string | undefined;
  let finalizationClaimed = locked.status === "quarantine_finalizing";
  try {
    if (recordedPlannedRef !== undefined && recordedPlannedRef !== canonicalBackupRef) {
      throw new Error(`quarantine backup ref does not match canonical ref ${canonicalBackupRef}`);
    }
    safePlanned = assertQuarantineTarget(locked, planned);
    const sourceExists = pathEntryExists(locked.canonical_path);
    const targetExists = pathEntryExists(safePlanned);
    if (sourceExists === targetExists) {
      throw new Error(sourceExists
        ? "quarantine source and target both exist"
        : "quarantine source and target are both missing");
    }
    const identityPath = targetExists ? safePlanned : locked.canonical_path;
    const identityIssues = leaseIdentityIssues(locked, identityPath);
    if (identityIssues.length > 0) {
      throw new Error(`quarantine identity validation failed: ${identityIssues.map((issue) => issue.code).join(",")}`);
    }
    quarantinePath = safePlanned;
    if (!targetExists) quarantineWorktree(locked, safePlanned);
    const finalGit = inspectGitWorktree(safePlanned);
    const safetyIssues = safetyRefusals(finalGit, locked, true);
    if (safetyIssues.length > 0) {
      throw new Error(`quarantine safety validation failed: ${safetyIssues.map((issue) => issue.code).join(",")}`);
    }
    const provedHead = finalGit.head_sha;
    if (!provedHead) throw new Error("quarantine safety proof did not produce a HEAD");
    createBackupRef(locked, safePlanned, provedHead);
    if (!quarantineProofMatches(safePlanned, canonicalBackupRef, provedHead)) {
      throw new Error("HEAD changed after quarantine safety proof");
    }
    const proofMetadata = {
      ...locked.metadata,
      planned_backup_ref: canonicalBackupRef,
      backup_ref: canonicalBackupRef,
      quarantine_path: quarantinePath,
      verified_head_sha: provedHead,
      quarantine_finalized: false,
    };
    if (!finalizationClaimed) {
      const claim = getDb().query(`UPDATE worktree_leases SET
          status = 'quarantine_finalizing', head_sha = ?, updated_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'quarantining' AND generation = ? AND fencing_token = ?`).run(
          provedHead,
          nowMs(),
          JSON.stringify(proofMetadata),
          locked.lease_id,
          locked.generation,
          locked.fencing_token,
      );
      if (claim.changes !== 1) throw new Error("quarantine finalization CAS failed");
      finalizationClaimed = true;
    }
    if (!quarantineProofMatches(safePlanned, canonicalBackupRef, provedHead)) {
      throw new Error("quarantine proof changed after finalization CAS");
    }
    const committed = getDb().query(`UPDATE worktree_leases SET
        status = 'quarantine_committing', head_sha = ?, updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'quarantine_finalizing' AND generation = ? AND fencing_token = ?`).run(
        provedHead,
        nowMs(),
        JSON.stringify(proofMetadata),
        locked.lease_id,
        locked.generation,
        locked.fencing_token,
    );
    if (committed.changes !== 1) throw new Error("quarantine commit CAS failed");
    return completeQuarantineCommit(queryLeaseByIdOrPath({ leaseId: locked.lease_id })!, finalGit);
  } catch (error) {
    if (error instanceof GitMutationLockBusyError) {
      return {
        ok: false,
        action: "release",
        code: "terminal_lock_busy",
        message: error.message,
        lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
        git: originalGit,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = {
      ...locked.metadata,
      quarantine_error: message,
      quarantine_finalization_claimed: finalizationClaimed,
    };
    const expectedStatus = finalizationClaimed ? "quarantine_finalizing" : "quarantining";
    const failureClaim = getDb().query(`UPDATE worktree_leases SET status = 'quarantine_compensating', updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = ? AND generation = ? AND fencing_token = ?`).run(
      nowMs(),
      JSON.stringify(failureMetadata),
      locked.lease_id,
      expectedStatus,
      locked.generation,
      locked.fencing_token,
    );
    if (failureClaim.changes !== 1) {
      const current = queryLeaseByIdOrPath({ leaseId: locked.lease_id });
      if (current
        && current.generation === locked.generation
        && current.fencing_token === locked.fencing_token
        && finalizedQuarantineProofMatches(current)) {
        return {
          ok: true,
          action: "release",
          idempotent: true,
          lease: current,
          git: originalGit || inspectGitWorktree(current.canonical_path),
          issues: [],
        };
      }
      return {
        ok: false,
        action: "release",
        code: "cas_transition_failed",
        message,
        lease: current || locked,
        git: originalGit,
      };
    }

    return completeQuarantineCompensation(
      queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
      originalGit,
    );
  }
}

function completeQuarantineCommit(locked: WorktreeLease, originalGit?: GitInspection): WorktreeResult {
  const path = locked.metadata["quarantine_path"];
  const backupRef = locked.metadata["backup_ref"];
  const expectedHead = locked.metadata["verified_head_sha"];
  try {
    if (typeof path !== "string" || typeof backupRef !== "string" || typeof expectedHead !== "string") {
      throw new Error("quarantine commit proof is missing");
    }
    const safePath = assertQuarantineTarget(locked, path);
    return withGitMutationLocks(safePath, locked.branch, () => {
      const git = inspectGitWorktree(safePath);
      const issues = safetyRefusals(git, locked, true);
      if (git.head_sha !== expectedHead || !quarantineProofMatches(safePath, backupRef, expectedHead)) {
        issues.push({ code: "quarantine_proof_changed", severity: "block", message: "quarantine proof changed before terminal commit", ref: expectedHead });
      }
      if (issues.length > 0) throw new Error(`quarantine commit validation failed: ${issues.map((issue) => issue.code).join(",")}`);
      const now = nowMs();
      const finalized = getDb().query(`UPDATE worktree_leases SET
          status = 'quarantined', canonical_path = ?, worktree_path = ?, updated_at_ms = ?, released_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'quarantine_committing' AND generation = ? AND fencing_token = ?`).run(
        safePath,
        safePath,
        now,
        now,
        JSON.stringify({
          ...locked.metadata,
          quarantine_finalized: false,
        }),
        locked.lease_id,
        locked.generation,
        locked.fencing_token,
      );
      if (finalized.changes !== 1) throw new Error("quarantine terminal CAS failed");
      const quarantined = queryLeaseByIdOrPath({ leaseId: locked.lease_id })!;
      if (!quarantineProofFinalizedMatches(quarantined, false)
        || readHead(quarantined.canonical_path) !== expectedHead) {
        const claimed = getDb().query(`UPDATE worktree_leases SET status = 'quarantine_compensating', updated_at_ms = ?, metadata_json = ?
          WHERE lease_id = ? AND status = 'quarantined' AND generation = ? AND fencing_token = ?`).run(
          nowMs(),
          JSON.stringify({
            ...quarantined.metadata,
            quarantine_error: "terminal quarantine proof changed after CAS",
            quarantine_finalization_claimed: true,
          }),
          quarantined.lease_id,
          quarantined.generation,
          quarantined.fencing_token,
        );
        if (claimed.changes !== 1) {
          return { ok: false, action: "release", code: "cas_transition_failed", lease: quarantined, git };
        }
        return completeQuarantineCompensation(queryLeaseByIdOrPath({ leaseId: quarantined.lease_id })!, git);
      }
      const finalizedAt = nowMs();
      const proofFinalized = getDb().query(`UPDATE worktree_leases SET updated_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'quarantined' AND generation = ? AND fencing_token = ?
          AND COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') != 'true'`).run(
        finalizedAt,
        JSON.stringify({
          ...quarantined.metadata,
          quarantine_finalized: true,
          quarantine_finalized_at_ms: finalizedAt,
        }),
        quarantined.lease_id,
        quarantined.generation,
        quarantined.fencing_token,
      );
      if (proofFinalized.changes !== 1) {
        return {
          ok: false,
          action: "release",
          code: "cas_transition_failed",
          lease: queryLeaseByIdOrPath({ leaseId: quarantined.lease_id }) || quarantined,
          git,
        };
      }
      return {
        ok: true,
        action: "release",
        lease: queryLeaseByIdOrPath({ leaseId: quarantined.lease_id }),
        git,
        issues: [],
      };
    }, [backupRef]);
  } catch (error) {
    if (error instanceof GitMutationLockBusyError) {
      return {
        ok: false,
        action: "release",
        code: "terminal_lock_busy",
        message: error.message,
        lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
        git: originalGit,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const claimed = getDb().query(`UPDATE worktree_leases SET status = 'quarantine_compensating', updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'quarantine_committing' AND generation = ? AND fencing_token = ?`).run(
      nowMs(),
      JSON.stringify({
        ...locked.metadata,
        quarantine_error: message,
        quarantine_finalization_claimed: true,
      }),
      locked.lease_id,
      locked.generation,
      locked.fencing_token,
    );
    if (claimed.changes !== 1) {
      const current = queryLeaseByIdOrPath({ leaseId: locked.lease_id });
      if (current && finalizedQuarantineProofMatches(current)) {
        return { ok: true, action: "release", idempotent: true, lease: current, git: inspectGitWorktree(current.canonical_path), issues: [] };
      }
      return { ok: false, action: "release", code: "cas_transition_failed", message, lease: current || locked, git: originalGit };
    }
    return completeQuarantineCompensation(queryLeaseByIdOrPath({ leaseId: locked.lease_id })!, originalGit);
  }
}

function completeQuarantineCompensation(locked: WorktreeLease, originalGit?: GitInspection): WorktreeResult {
  const message = typeof locked.metadata["quarantine_error"] === "string"
    ? locked.metadata["quarantine_error"]
    : "quarantine compensation resumed";
  const finalizationClaimed = locked.metadata["quarantine_finalization_claimed"] === true;
  const planned = locked.metadata["planned_quarantine_path"];
  let safePlanned: string | undefined;
  let rollbackError: string | undefined;
  let compensationError: string | undefined;
  let identityValidated = false;
  try {
    if (typeof planned !== "string") throw new Error("quarantine plan is missing");
    safePlanned = assertQuarantineTarget(locked, planned);
    let sourcePresent = pathEntryExists(locked.canonical_path);
    let targetPresent = pathEntryExists(safePlanned);
    if (sourcePresent === targetPresent) {
      throw new Error(sourcePresent
        ? "quarantine source and target both exist"
        : "quarantine source and target are both missing");
    }
    const identityPath = targetPresent ? safePlanned : locked.canonical_path;
    const identityIssues = leaseIdentityIssues(locked, identityPath);
    if (identityIssues.length > 0) {
      throw new Error(`quarantine identity validation failed: ${identityIssues.map((issue) => issue.code).join(",")}`);
    }
    identityValidated = true;
    if (!sourcePresent && targetPresent) {
      try {
        moveGitWorktree(safePlanned, locked.canonical_path);
      } catch (rollback) {
        rollbackError = rollback instanceof Error ? rollback.message : String(rollback);
      }
      sourcePresent = pathEntryExists(locked.canonical_path);
      targetPresent = pathEntryExists(safePlanned);
    }
    if (!rollbackError && (!sourcePresent || targetPresent)) {
      compensationError = "quarantine rollback did not restore the source path";
    }
  } catch (compensation) {
    compensationError = compensation instanceof Error ? compensation.message : String(compensation);
  }

  const sourcePresent = pathEntryExists(locked.canonical_path);
  const targetPresent = Boolean(safePlanned && pathEntryExists(safePlanned));
  const unresolvedPlannedArtifact = typeof planned === "string" && !safePlanned;
  let rollbackIssues: WorktreeIssue[] = [];
  if (!rollbackError && identityValidated && sourcePresent && !targetPresent) {
    rollbackIssues = safetyRefusals(inspectGitWorktree(locked.canonical_path), locked, true);
  }
  let status: "active" | "failed" | "quarantine_failed" = !finalizationClaimed
    && !rollbackError
    && !compensationError
    && identityValidated
    && sourcePresent
    && !targetPresent
    && rollbackIssues.length === 0
    ? "active"
    : sourcePresent || targetPresent || unresolvedPlannedArtifact
      ? "quarantine_failed"
      : "failed";
  const retainedPath = status === "active"
    ? locked.canonical_path
    : targetPresent && safePlanned
      ? safePlanned
      : locked.canonical_path;
  const finalMetadata = {
    ...locked.metadata,
    rollback_error: rollbackError,
    compensation_error: compensationError,
    rollback_issues: rollbackIssues.map((issue) => issue.code),
  };
  let finalStateError: string | undefined;
  try {
    const finalized = getDb().query(`UPDATE worktree_leases SET status = ?, canonical_path = ?, worktree_path = ?, updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'quarantine_compensating' AND generation = ? AND fencing_token = ?`).run(
      status,
      retainedPath,
      retainedPath,
      nowMs(),
      JSON.stringify(finalMetadata),
      locked.lease_id,
      locked.generation,
      locked.fencing_token,
    );
    if (finalized.changes !== 1) finalStateError = "quarantine compensation final-state CAS failed";
  } catch (finalState) {
    finalStateError = finalState instanceof Error ? finalState.message : String(finalState);
  }
  if (finalStateError) {
    status = sourcePresent || targetPresent || unresolvedPlannedArtifact ? "quarantine_failed" : "failed";
    getDb().query(`UPDATE worktree_leases SET status = ?, canonical_path = ?, worktree_path = ?, updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'quarantine_compensating' AND generation = ? AND fencing_token = ?`).run(
      status,
      retainedPath,
      retainedPath,
      nowMs(),
      JSON.stringify({ ...finalMetadata, final_state_error: finalStateError }),
      locked.lease_id,
      locked.generation,
      locked.fencing_token,
    );
  }
  return {
    ok: false,
    action: "release",
    code: rollbackError ? "quarantine_rollback_failed" : "quarantine_failed",
    message: [
      message,
      compensationError,
      rollbackError ? `rollback failed: ${rollbackError}` : undefined,
      finalStateError ? `final state failed: ${finalStateError}` : undefined,
    ].filter(Boolean).join("; "),
    lease: queryLeaseByIdOrPath({ leaseId: locked.lease_id }) || locked,
    git: originalGit,
  };
}

function quarantineProofFinalizedMatches(lease: WorktreeLease, requireFinalized = true): boolean {
  if (lease.status !== "quarantined"
    || (requireFinalized && lease.metadata["quarantine_finalized"] !== true)) return false;
  const path = lease.metadata["quarantine_path"];
  const backupRef = lease.metadata["backup_ref"];
  const verifiedHead = lease.metadata["verified_head_sha"];
  if (typeof path !== "string"
    || typeof backupRef !== "string"
    || typeof verifiedHead !== "string"
    || lease.canonical_path !== path
    || lease.head_sha !== verifiedHead
    || !existsSync(path)) {
    return false;
  }
  try {
    const git = inspectGitWorktree(path);
    const committingLease = { ...lease, status: "quarantine_committing" as const };
    return backupRef === backupRefFor(lease)
      && assertQuarantineTarget(lease, path) === path
      && quarantineProofMatches(path, backupRef, verifiedHead)
      && git.head_sha === verifiedHead
      && safetyRefusals(git, committingLease, true).length === 0;
  } catch {
    return false;
  }
}

function finalizedQuarantineProofMatches(lease: WorktreeLease): boolean {
  return quarantineProofFinalizedMatches(lease, true);
}

function resumeProvisionalQuarantine(lease: WorktreeLease): WorktreeResult {
  const backupRef = lease.metadata["backup_ref"];
  const canonicalBackupRef = backupRefFor(lease);
  if (backupRef !== canonicalBackupRef) {
    getDb().query(`UPDATE worktree_leases SET status = 'quarantine_failed', updated_at_ms = ?, metadata_json = ?
      WHERE lease_id = ? AND status = 'quarantined' AND generation = ? AND fencing_token = ?
        AND COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') != 'true'`).run(
      nowMs(),
      JSON.stringify({ ...lease.metadata, quarantine_error: "provisional quarantine backup ref is not canonical" }),
      lease.lease_id,
      lease.generation,
      lease.fencing_token,
    );
    return {
      ok: false,
      action: "release",
      code: "quarantine_failed",
      message: "provisional quarantine backup ref is not canonical",
      lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
    };
  }
  const extraRefs = [canonicalBackupRef];
  try {
    return withGitMutationLocks(lease.canonical_path, lease.branch, () => {
      const git = inspectGitWorktree(lease.canonical_path);
      const expectedHead = lease.metadata["verified_head_sha"];
      if (typeof expectedHead !== "string"
        || !quarantineProofFinalizedMatches(lease, false)
        || readHead(lease.canonical_path) !== expectedHead) {
        getDb().query(`UPDATE worktree_leases SET status = 'quarantine_failed', updated_at_ms = ?, metadata_json = ?
          WHERE lease_id = ? AND status = 'quarantined' AND generation = ? AND fencing_token = ?
            AND COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') != 'true'`).run(
          nowMs(),
          JSON.stringify({ ...lease.metadata, quarantine_error: "provisional quarantine proof is invalid" }),
          lease.lease_id,
          lease.generation,
          lease.fencing_token,
        );
        return {
          ok: false,
          action: "release",
          code: "quarantine_failed",
          message: "provisional quarantine proof is invalid",
          lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
          git,
        };
      }
      const finalizedAt = nowMs();
      const finalized = getDb().query(`UPDATE worktree_leases SET updated_at_ms = ?, metadata_json = ?
        WHERE lease_id = ? AND status = 'quarantined' AND generation = ? AND fencing_token = ?
          AND COALESCE(json_type(metadata_json, '$.quarantine_finalized'), '') != 'true'`).run(
        finalizedAt,
        JSON.stringify({
          ...lease.metadata,
          quarantine_finalized: true,
          quarantine_finalized_at_ms: finalizedAt,
        }),
        lease.lease_id,
        lease.generation,
        lease.fencing_token,
      );
      if (finalized.changes !== 1) {
        return { ok: false, action: "release", code: "cas_transition_failed", lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease, git };
      }
      return {
        ok: true,
        action: "release",
        idempotent: true,
        lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }),
        git,
        issues: [],
      };
    }, extraRefs);
  } catch (error) {
    return {
      ok: false,
      action: "release",
      code: error instanceof GitMutationLockBusyError ? "terminal_lock_busy" : "quarantine_failed",
      message: error instanceof Error ? error.message : String(error),
      lease: queryLeaseByIdOrPath({ leaseId: lease.lease_id }) || lease,
    };
  }
}

function quarantineProofMatches(cwd: string, backupRef: string, expectedHead: string): boolean {
  const proof = runGit(["rev-parse", "HEAD", backupRef], cwd);
  if (!proof.ok) return false;
  const values = proof.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  return values.length === 2 && values.every((value) => value === expectedHead);
}

function failQuarantiningLease(locked: WorktreeLease, message: string): WorktreeLease | undefined {
  const status = locked.status === "quarantine_finalizing" ? "quarantine_finalizing" : "quarantining";
  return failTransientLease(locked, status, message, "quarantine_error");
}

function failTransientLease(
  locked: WorktreeLease,
  status: "releasing" | "release_committing" | "quarantining" | "quarantine_finalizing",
  message: string,
  metadataKey = "release_error",
): WorktreeLease | undefined {
  const now = nowMs();
  const terminalStatus = pathEntryExists(locked.canonical_path) ? "worktree_failed" : "failed";
  getDb().query(`UPDATE worktree_leases SET status = ?, updated_at_ms = ?, metadata_json = ?
    WHERE lease_id = ? AND status = ? AND generation = ? AND fencing_token = ?`).run(
    terminalStatus,
    now,
    JSON.stringify({ ...locked.metadata, [metadataKey]: message }),
    locked.lease_id,
    status,
    locked.generation,
    locked.fencing_token,
  );
  return queryLeaseByIdOrPath({ leaseId: locked.lease_id });
}

function backupRefFor(lease: WorktreeLease): string {
  return `refs/hasna/worktrees/${sanitizeSegment(lease.lease_id, "lease")}/${lease.generation}`;
}

function createBackupRef(lease: WorktreeLease, cwd: string, expectedHead: string): string {
  const ref = backupRefFor(lease);
  const head = readHead(cwd);
  if (!head) throw new Error("failed to resolve quarantine backup HEAD");
  if (head !== expectedHead) throw new Error("HEAD changed after quarantine safety proof");
  const symbolic = runGit(["symbolic-ref", "-q", "--no-recurse", ref], cwd);
  if (symbolic.ok) throw new Error(`canonical quarantine backup ref is symbolic: ${ref}`);
  if (symbolic.exitCode !== 1) throw new Error(symbolic.stderr.trim() || "failed to inspect quarantine backup ref type");
  const existing = runGit(["rev-parse", "--verify", "--quiet", ref], cwd);
  if (existing.ok) {
    if (existing.stdout.trim() === expectedHead) return ref;
    throw new Error(`canonical quarantine backup ref already points to a different object: ${ref}`);
  }
  if (existing.exitCode !== 1) throw new Error(existing.stderr.trim() || "failed to inspect quarantine backup ref");
  const result = runGit(["update-ref", "--no-deref", ref, expectedHead, "0".repeat(expectedHead.length)], cwd);
  if (!result.ok) throw new Error(result.stderr.trim() || "failed to create backup ref");
  if (readHead(cwd) !== expectedHead) {
    runGit(["update-ref", "--no-deref", "-d", ref, expectedHead], cwd);
    throw new Error("HEAD changed after quarantine safety proof");
  }
  return ref;
}

function quarantinePathFor(lease: WorktreeLease): string {
  const configuredRoot = lease.metadata["worktree_root"];
  if (typeof configuredRoot !== "string" || !configuredRoot.trim()) {
    throw new Error("lease does not record a trusted worktree root");
  }
  const root = resolve(configuredRoot);
  assertSafePath(lease.canonical_path, root);
  const target = join(
    root,
    ".quarantine",
    sanitizeSegment(lease.machine_id, "unknown-machine"),
    `${sanitizeSegment(lease.canonical_repo.split("/").pop() || lease.canonical_repo, "repo")}-${stableHash(lease.canonical_repo)}`,
    sanitizeSegment(lease.lease_id, "lease"),
    String(Date.now()),
    "repo",
  );
  return assertQuarantineTarget(lease, target);
}

function assertQuarantineTarget(lease: WorktreeLease, target: string): string {
  const configuredRoot = lease.metadata["worktree_root"];
  if (typeof configuredRoot !== "string" || !configuredRoot.trim()) {
    throw new Error("lease does not record a trusted worktree root");
  }
  const quarantineRoot = join(resolve(configuredRoot), ".quarantine");
  const leaseRoot = join(
    quarantineRoot,
    sanitizeSegment(lease.machine_id, "unknown-machine"),
    `${sanitizeSegment(lease.canonical_repo.split("/").pop() || lease.canonical_repo, "repo")}-${stableHash(lease.canonical_repo)}`,
    sanitizeSegment(lease.lease_id, "lease"),
  );
  const resolvedTarget = resolve(target);
  const rel = relative(leaseRoot, resolvedTarget);
  const parts = rel.split(sep).filter(Boolean);
  if (rel.startsWith("..") || isAbsolute(rel) || parts.length !== 2 || parts[1] !== "repo") {
    throw new Error("quarantine target does not match the lease-specific quarantine path");
  }
  return assertSafePath(resolvedTarget, quarantineRoot);
}

function quarantineWorktree(lease: WorktreeLease, target: string): string {
  moveGitWorktree(lease.canonical_path, target);
  return target;
}

function moveGitWorktree(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const gitMarker = join(source, ".git");
  if (existsSync(gitMarker) && lstatSync(gitMarker).isDirectory()) {
    renameSync(source, target);
    return;
  }
  const moved = runGit(["worktree", "move", source, target], source);
  if (!moved.ok) throw new Error(moved.stderr.trim() || "git worktree move failed");
}

export function inspectGitWorktree(path: string): GitInspection {
  const target = resolve(path);
  const issues: WorktreeIssue[] = [];
  if (!existsSync(target)) {
    return {
      path: target,
      exists: false,
      is_git_worktree: false,
      top_level: null,
      branch: null,
      detached: false,
      head_sha: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty: { staged: 0, modified: 0, untracked: 0 },
      issues: [{ code: "path_missing", severity: "block", message: "worktree path does not exist", ref: target }],
    };
  }
  if (lstatSync(target).isSymbolicLink()) {
    issues.push({ code: "path_symlink", severity: "block", message: "worktree path is a symlink", ref: target });
  }
  if (!statSync(target).isDirectory()) {
    issues.push({ code: "path_not_directory", severity: "block", message: "worktree path is not a directory", ref: target });
  }

  const top = runGit(["rev-parse", "--show-toplevel"], target);
  const topLevel = top.ok ? resolve(top.stdout.trim()) : null;
  const isGit = Boolean(topLevel && topLevel === target);
  if (!isGit) issues.push({ code: "not_git_worktree", severity: "block", message: "path is not the root of a git worktree", ref: target });

  const branchResult = isGit ? runGit(["symbolic-ref", "--short", "HEAD"], target) : undefined;
  const branch = branchResult?.ok ? branchResult.stdout.trim() : null;
  const detached = isGit && !branch;
  const head = isGit ? readHead(target) : null;
  const status = isGit ? runGit(["status", "--porcelain=v1"], target) : undefined;
  const dirty = { staged: 0, modified: 0, untracked: 0 };
  if (status?.ok) {
    for (const line of status.stdout.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) dirty.untracked += 1;
      else {
        if (line[0] !== " ") dirty.staged += 1;
        if (line[1] !== " ") dirty.modified += 1;
      }
    }
  } else if (isGit) {
    issues.push({ code: "git_status_failed", severity: "block", message: "git status could not prove the worktree clean", ref: target });
  }
  if (isGit && !head) issues.push({ code: "head_inspection_failed", severity: "block", message: "worktree HEAD could not be resolved", ref: target });

  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (isGit && !detached) {
    const upstreamResult = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], target);
    if (upstreamResult.ok) {
      upstream = upstreamResult.stdout.trim();
      const counts = runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], target);
      if (counts.ok) {
        const [left, right] = counts.stdout.trim().split(/\s+/).map((part) => Number(part));
        if (Number.isInteger(left) && left! >= 0 && Number.isInteger(right) && right! >= 0) {
          behind = left!;
          ahead = right!;
        }
      }
    }
  }

  return { path: target, exists: true, is_git_worktree: isGit, top_level: topLevel, branch, detached, head_sha: head, upstream, ahead, behind, dirty, issues };
}

function safetyRefusals(git: GitInspection, lease: WorktreeLease | undefined, allowQuarantining = false): WorktreeIssue[] {
  const issues = [...git.issues];
  const owned = lease?.status === "active"
    || (allowQuarantining
      && (lease?.status === "releasing"
        || lease?.status === "release_committing"
        || lease?.status === "quarantining"
        || lease?.status === "quarantine_finalizing"
        || lease?.status === "quarantine_committing"
        || lease?.status === "quarantine_compensating"
        || lease?.status === "quarantine_failed"));
  if (!owned) issues.push({ code: "unknown_owner", severity: "block", message: "no active repos worktree lease owns this path", ref: git.path });
  if (lease) issues.push(...leaseIdentityIssues(lease, git.path, git));
  if (git.dirty.staged > 0) issues.push({ code: "staged_changes", severity: "block", message: "staged changes present", ref: git.path });
  if (git.dirty.modified > 0) issues.push({ code: "dirty_changes", severity: "block", message: "unstaged modifications present", ref: git.path });
  if (git.dirty.untracked > 0) issues.push({ code: "untracked_files", severity: "block", message: "untracked files present", ref: git.path });
  if (lease && git.is_git_worktree && git.branch === lease.branch && rawOriginRepoIdentity(git.path) === lease.canonical_repo) {
    issues.push(...remoteBranchIssues(git, lease));
  }
  return issues;
}

function remoteBranchIssues(git: GitInspection, lease: WorktreeLease): WorktreeIssue[] {
  const issues: WorktreeIssue[] = [];
  const remote = runGit(["config", "--includes", "--get", `branch.${lease.branch}.remote`], git.path);
  const merge = runGit(["config", "--includes", "--get", `branch.${lease.branch}.merge`], git.path);
  if (!remote.ok || !merge.ok) {
    return [{ code: "no_upstream", severity: "block", message: "branch has no configured upstream", ref: lease.branch }];
  }
  const expectedUpstream = `origin/${lease.branch}`;
  if (git.upstream !== expectedUpstream
    || remote.stdout.trim() !== "origin"
    || merge.stdout.trim() !== `refs/heads/${lease.branch}`) {
    return [{
      code: "non_origin_upstream",
      severity: "block",
      message: "branch upstream must be the matching origin branch",
      ref: `${git.upstream || "none"}:${remote.stdout.trim()}:${merge.stdout.trim()}`,
    }];
  }

  const branchRef = `refs/heads/${lease.branch}`;
  const probe = probeOriginRef(git.path, branchRef);
  if (!probe.ok) {
    return [{
      code: probe.code!,
      severity: "block",
      message: probe.code === "remote_branch_missing"
        ? "validated origin no longer has the leased branch"
        : probe.code === "remote_probe_failed"
          ? "validated origin branch could not be probed"
          : "validated origin returned an invalid branch proof",
      ref: branchRef,
    }];
  }
  if (!git.head_sha || probe.sha !== git.head_sha) {
    issues.push({
      code: "remote_head_mismatch",
      severity: "block",
      message: "worktree HEAD is not the exact SHA published at the validated origin branch",
      ref: `${git.head_sha || "unknown"} != ${probe.sha}`,
    });
    issues.push({
      code: "unique_commits",
      severity: "block",
      message: "the exact worktree HEAD is not proven on the validated origin branch",
      ref: lease.branch,
    });
  }
  return issues;
}

export function inventoryWorktrees(options: InventoryOptions = {}) {
  const root = resolve(options.root || DEFAULT_ROOT());
  const limit = Math.max(1, options.limit || 500);
  const discovered = discoverGitWorktrees(root, limit).map((path) => {
    const lease = queryLeaseByIdOrPath({ path });
    return { path, lease, git: inspectGitWorktree(path) };
  });
  const leases = (getDb().query("SELECT * FROM worktree_leases ORDER BY updated_at_ms DESC LIMIT ?").all(limit) as WorktreeLeaseRow[]).map(mapLease).filter(Boolean);
  return { root, discovered, leases };
}

function discoverGitWorktrees(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0 && results.length < limit) {
    const item = stack.pop()!;
    if (item.depth > 7) continue;
    if (lstatSync(item.path).isSymbolicLink()) continue;
    if (existsSync(join(item.path, ".git"))) {
      results.push(item.path);
      continue;
    }
    for (const entry of readdirSync(item.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      stack.push({ path: join(item.path, entry.name), depth: item.depth + 1 });
    }
  }
  return results.sort();
}

export function formatWorktreeResult(result: unknown, pretty = false): string {
  return JSON.stringify(result, null, pretty ? 2 : 0);
}
