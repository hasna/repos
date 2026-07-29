/**
 * The worktree lifecycle, owned by `repos`.
 *
 * ## Why this is a verb and not a convention
 *
 * The layout `~/.hasna/repos/worktrees/<repo-name>/<worktree-name>` has been
 * ratified in the non-overridable rules and in knowledge `k_mrj32xhu_efxkxl`
 * for weeks. Measured on this station on 2026-07-28: 444 entries sit directly
 * at the root, mixing correct `<repo>/<name>` pairs with flat task-named
 * directories, a bare UUID directory, and a `station01/` machine segment the
 * convention explicitly forbids. A 2026-07-20 audit of the same root found the
 * same classes — 40 flat and roughly 201 station-prefixed out of 362. The
 * drift is recurring, not residual.
 *
 * Prose did not hold the layout because every caller re-derives the path. So
 * the path is not a parameter here. `add` takes a repo and a name and
 * *computes* where the worktree goes; there is no argument in which a caller
 * can express a different location. That is the difference between a rule and
 * an enforcement point.
 *
 * ## Why `remove` refuses to take a path
 *
 * `iapp-factory`'s `addWorktree` opened by force-removing whatever occupied the
 * target path — `git worktree remove --force`, then `prune`, then
 * `rmSync(recursive, force)` — against a root of `~/.hasna/repos/worktrees`.
 * A caller-side `isPathInside` guard was added later (task `75eb20c6`), in one
 * caller. Every future caller re-derives that guard or forgets it.
 *
 * Here the destructive verbs accept a lease id or a `<repo>/<name>` pair and
 * nothing else. An absolute path, a relative path, a `..` component and a
 * tilde are all rejected by argument shape before any resolution happens, so
 * the hazard is unrepresentable rather than guarded. Containment is then
 * re-checked after symlink resolution, because a directory that was inside the
 * root when the lease was written may not be inside it now.
 *
 * ## What this plane deliberately does not do
 *
 * It reads no credential of its own. Nothing here touches `gh`, a token
 * environment variable, or the vault, and
 * `src/lib/worktrees-credential-isolation.test.ts` asserts that with positive
 * controls.
 *
 * It is NOT true that the plane works with no credential on the station at all,
 * and the first version of this comment said so. `add` fetches the base ref
 * through the parent checkout's existing remote configuration, so for a private
 * https remote or an ssh remote without a key the fetch needs whatever ambient
 * git credential that remote demands, and without one `add` hard-fails with
 * BASE_REF_UNRESOLVABLE — measured, and pinned by a test. That is the design's
 * stated Phase 1 caveat, and it is what the credential broker (Phase 2) exists
 * to remove. Public remotes, local remotes, and repos with no remote need
 * nothing.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDb } from "../db/database.js";
import { AmbiguousRepoNameError, getRepo, isDerivedCheckoutPath } from "../db/repos.js";
import type { Repo } from "../types/index.js";
import { resolveTrustedAccountHome } from "./account-home.js";
import { getSourceMachineId } from "./machine-id.js";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

export const WORKTREE_LEASE_SCHEMA = "open-repos.worktree-lease.v1" as const;
export const WORKTREE_LIST_SCHEMA = "open-repos.worktree-list.v1" as const;
export const WORKTREE_ADOPT_SCHEMA = "open-repos.worktree-adopt.v1" as const;

const GIT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_DAYS = 7;

/**
 * A worktree name is one path segment of a conservative slug alphabet.
 *
 * Every containment argument in this module reduces to this predicate. If a
 * name could carry a separator or a `..` component, `<root>/<repo>/<name>`
 * would not be a path under the root — it would be a path expression supplied
 * by the caller, which is precisely the thing `add` refuses to accept.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Directory names under the root that are bookkeeping, not worktrees. */
const RESERVED_ROOT_ENTRIES = new Set([".evidence"]);

export type WorktreeErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_WORKTREE_NAME"
  | "INVALID_BASE_REF"
  | "INVALID_BRANCH_NAME"
  | "BRANCH_EXISTS"
  | "REPO_NOT_FOUND"
  | "AMBIGUOUS_REPO"
  | "PARENT_CHECKOUT_BROKEN"
  | "WORKTREE_PATH_OCCUPIED"
  | "PATH_OUTSIDE_ROOT"
  | "TARGET_IS_PARENT_CHECKOUT"
  | "NOT_A_WORKTREE"
  | "BASE_REF_UNRESOLVABLE"
  | "LEASE_NOT_FOUND"
  | "LEASE_CONFLICT"
  | "WORKTREE_DIRTY"
  | "WORKTREE_UNPUSHED"
  | "TRUSTED_HOME_UNAVAILABLE"
  | "LAYOUT_INVARIANT_VIOLATED"
  | "GIT_FAILED";

export interface WorktreeErrorDetails {
  repo?: string;
  path?: string;
  root?: string;
  name?: string;
  branch?: string;
  base_ref?: string;
  lease_id?: string;
  hint?: string;
  git_stderr?: string;
}

export class WorktreeError extends Error {
  constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
    public readonly details: WorktreeErrorDetails = {},
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

function fail(code: WorktreeErrorCode, message: string, details: WorktreeErrorDetails = {}): never {
  throw new WorktreeError(code, message, details);
}

export interface WorktreeLease {
  lease_id: string;
  repo_id: string;
  repo_path: string;
  repo_catalog_id: number | null;
  machine_id: string;
  worktree_path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  task_id: string;
  run_id: string;
  mode: string;
  owner_metadata: string;
  cleanup_policy: string;
  status: string;
  git_common_dir: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string;
  verified_at: string | null;
  released_at: string | null;
  last_error: string | null;
}

// ── credential-free git ───────────────────────────────────────────────────────

/**
 * Strip anything credential-shaped out of git's diagnostics before it reaches a
 * log, a `--json` payload or a task comment.
 *
 * git happily prints the remote URL it failed against, and a URL can carry
 * `https://user:token@host`. This module's whole claim is that the credential
 * stays behind the abstraction, and an error message is a perfectly good
 * exfiltration channel.
 */
export function redactGitDiagnostics(text: string): string {
  return text
    // The whole authority, up to the LAST `@` before the host. Matching
    // `user:pass@` specifically missed two shapes adversarial review found:
    // `https://<token>@host` (no colon at all — how GitLab and GitHub PATs are
    // usually embedded) and a password containing `@`, which left its tail in
    // the clear as `https://<redacted>@ss@host`.
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/]*@/g, "$1<redacted>@")
    // Bare tokens outside a URL. Provider prefixes are enumerated rather than
    // guessed at, and this list is expected to grow.
    .replace(
      /\b(gh[pousr]_|github_pat_|glpat-|glrt-|xoxb-|sk-ant-|sk-proj-|npm_|AKIA)[A-Za-z0-9_-]+/g,
      "$1<redacted>",
    );
}

interface GitOptions {
  timeout?: number;
  allowFailure?: boolean;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], options: GitOptions = {}): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = redactGitDiagnostics(
      String(failure.stderr ?? "").trim() || String(failure.message ?? "git failed"),
    );
    if (!options.allowFailure) {
      fail("GIT_FAILED", `git ${args[0]} failed`, { path: cwd, git_stderr: stderr });
    }
    return { ok: false, stdout: String(failure.stdout ?? "").trim(), stderr };
  }
}

function gitOut(cwd: string, args: string[], options: GitOptions = {}): string {
  return runGit(cwd, args, options).stdout;
}

// ── the root, and containment inside it ──────────────────────────────────────

let rootForTests: string | null = null;

/** Test seam, mirroring `setPrimaryRelocationCanonicalRootForTests`. */
export function setWorktreeRootForTests(root: string | null): void {
  rootForTests = root;
}

/**
 * The canonical worktree root.
 *
 * Derived from the operating system account database rather than `$HOME`: a
 * root that moves with an environment variable is a containment check any
 * caller can step around by exporting one value before invoking the CLI.
 */
export function worktreeRootDir(): string {
  if (rootForTests) return resolve(rootForTests);
  const home = resolveTrustedAccountHome();
  if (!home) {
    fail(
      "TRUSTED_HOME_UNAVAILABLE",
      "the account home could not be resolved from the operating system account database",
    );
  }
  return join(home, ".hasna", "repos", "worktrees");
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve a path through symlinks as far as it exists, keeping the part that
 * does not exist yet. `realpathSync` on a path whose leaf is absent throws, and
 * a create has to reason about exactly that case.
 */
function resolveThroughExisting(path: string): string {
  let current = resolve(path);
  const trailing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    trailing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return trailing.length === 0 ? realpathOrSelf(current) : join(realpathOrSelf(current), ...trailing);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The containment gate. Everything destructive passes through here after
 * symlink resolution, never before.
 */
function assertInsideRoot(candidate: string, label: string): string {
  const root = realpathOrSelf(worktreeRootDir());
  const resolved = resolveThroughExisting(candidate);
  if (!isWithin(root, resolved)) {
    fail("PATH_OUTSIDE_ROOT", `${label} resolves outside the canonical worktree root`, {
      path: resolved,
      root,
    });
  }
  return resolved;
}

// ── names ────────────────────────────────────────────────────────────────────

export function assertWorktreeName(name: string | undefined): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.endsWith(".")) {
    fail(
      "INVALID_WORKTREE_NAME",
      "a worktree name must be a single path segment of letters, digits, '.', '_' and '-'",
      { name: typeof name === "string" ? name.replace(/[^\x20-\x7e]/g, "?") : String(name) },
    );
  }
  return name;
}

/**
 * Coerce an untrusted string into one safe path segment.
 *
 * Used for values that come from stored rows rather than from arguments, where
 * refusing outright would strand data the operator is trying to rescue. The
 * digest keeps distinct inputs distinct without preserving anything traversable.
 */
function safePathSegment(value: string): string {
  if (NAME_PATTERN.test(value) && !value.endsWith(".")) return value;
  return `unsafe-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function assertRepoSegment(name: string): string {
  if (!NAME_PATTERN.test(name) || name.endsWith(".")) {
    fail("INVALID_REQUEST", `registry repo name '${name}' is not usable as a directory segment`, {
      repo: name,
    });
  }
  return name;
}

/** `<root>/<repo-name>/<worktree-name>` — the only shape this module produces. */
export function computeWorktreePath(repoName: string, worktreeName: string): string {
  return join(worktreeRootDir(), assertRepoSegment(repoName), assertWorktreeName(worktreeName));
}

// ── repo resolution and parent health ────────────────────────────────────────

function resolveRepo(input: string): Repo {
  if (!input || typeof input !== "string") {
    fail("INVALID_REQUEST", "a repo id, path or unique name is required");
  }
  let repo: Repo | null;
  try {
    repo = getRepo(input);
  } catch (error) {
    if (error instanceof AmbiguousRepoNameError) {
      fail("AMBIGUOUS_REPO", error.message, { repo: input });
    }
    throw error;
  }
  if (!repo) {
    fail("REPO_NOT_FOUND", `no registry row matches '${input}'`, {
      repo: input,
      hint: "resolve by exact id or path; fuzzy matching is deliberately not accepted here",
    });
  }
  return repo;
}

interface ParentCheckout {
  path: string;
  commonDir: string;
}

/**
 * Assert the parent checkout is a working repository before anything is built
 * on top of it.
 *
 * The live counter-example: registry row 92 points at
 * `/home/hasna/workspace/hasna/opensource/open-repos`, whose `.git` holds only
 * `hooks/` and `worktrees/`. `git rev-parse` there exits 128 with "not a git
 * repository", and a verb that assumes health turns that into an opaque git
 * failure two calls later.
 */
function assertHealthyParent(repo: Repo): ParentCheckout {
  const path = repo.path;
  if (!existsSync(path)) {
    fail("PARENT_CHECKOUT_BROKEN", `the registered checkout for '${repo.name}' does not exist`, {
      repo: repo.name,
      path,
      hint: "the registry row is stale; re-clone the repo or prune the row",
    });
  }
  const inside = runGit(path, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (!inside.ok || inside.stdout !== "true") {
    fail("PARENT_CHECKOUT_BROKEN", `the registered checkout for '${repo.name}' is not a git repository`, {
      repo: repo.name,
      path,
      git_stderr: inside.stderr,
      hint: "the checkout is a husk (a .git holding only hooks/ and worktrees/ is the known shape); re-clone it",
    });
  }
  const commonDir = gitOut(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    allowFailure: true,
  });
  if (!commonDir) {
    fail("PARENT_CHECKOUT_BROKEN", `the git directory for '${repo.name}' could not be resolved`, {
      repo: repo.name,
      path,
    });
  }
  return { path: realpathOrSelf(path), commonDir: realpathOrSelf(commonDir) };
}

function repoIdentity(repo: Repo): string {
  const remote = sanitizeRemoteIdentity(repo.remote_url ?? undefined);
  if (remote) {
    const withoutHost = remote.replace(/^[^/]+\//, "");
    return `github:${withoutHost}`;
  }
  return `path:${repo.path}`;
}

// ── leases ───────────────────────────────────────────────────────────────────

/**
 * How the base was resolved when the lease was first claimed.
 *
 * The reuse path used to return a hardcoded `"origin"`, so a worktree branched
 * from a repo with no remote reported `local` on creation and `origin` on
 * re-entry — the field that exists to evidence the fail-closed fetch fabricated
 * itself on the second call. The lease's own metadata has the answer.
 */
function recordedBaseSource(lease: WorktreeLease): "origin" | "local" {
  try {
    const metadata = JSON.parse(lease.owner_metadata) as { base_source?: unknown };
    return metadata.base_source === "local" ? "local" : "origin";
  } catch {
    return "origin";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newLeaseId(): string {
  return `wt_${randomBytes(12).toString("hex")}`;
}

function leaseByPath(db: Database, path: string): WorktreeLease | null {
  return db.query("SELECT * FROM worktree_leases WHERE worktree_path = ?").get(path) as WorktreeLease | null;
}

function leaseById(db: Database, leaseId: string): WorktreeLease | null {
  return db.query("SELECT * FROM worktree_leases WHERE lease_id = ?").get(leaseId) as WorktreeLease | null;
}

function leaseByClaim(
  db: Database,
  claim: { repoId: string; machineId: string; taskId: string; runId: string; baseRef: string },
): WorktreeLease | null {
  return db
    .query(
      `SELECT * FROM worktree_leases
       WHERE repo_id = ? AND machine_id = ? AND task_id = ? AND run_id = ? AND base_ref = ?`,
    )
    .get(claim.repoId, claim.machineId, claim.taskId, claim.runId, claim.baseRef) as WorktreeLease | null;
}

// ── add ──────────────────────────────────────────────────────────────────────

export interface AddWorktreeRequest {
  /** Exact registry id, path, or unique name. Fuzzy resolution is not accepted. */
  repo: string;
  /** The todos task id. The ratified name source when a task exists. */
  task?: string;
  /** The sanctioned fallback when no task exists. */
  name?: string;
  /** Ref to branch from. Defaults to the registry's default branch. */
  base?: string;
  /** Branch to create. Defaults to the worktree name. */
  branch?: string;
  runId?: string;
  cleanupPolicy?: string;
  mode?: string;
  db?: Database;
  machineId?: string;
}

export interface AddWorktreeResult {
  schema: typeof WORKTREE_LEASE_SCHEMA;
  path: string;
  created: boolean;
  reused: boolean;
  base: { ref: string; sha: string; source: "origin" | "local" };
  lease: WorktreeLease;
}

interface ResolvedBase {
  ref: string;
  sha: string;
  source: "origin" | "local";
}

/**
 * Pin the base from origin, or say plainly that there is no origin to pin from.
 *
 * A worktree branched off a local HEAD several days behind origin produces a PR
 * carrying other people's reverts — the failure recorded as factory lesson
 * IAP9-00118. So a repo that has an origin MUST fetch, and a fetch failure is
 * terminal: falling back to the local ref would be exactly the silent
 * degradation this design exists to remove.
 *
 * A repo with no remote at all is a different case, not a fallback: there is no
 * upstream that could be fresher. It resolves locally and the result says so.
 */
function resolveBase(parent: ParentCheckout, baseRef: string): ResolvedBase {
  const remotes = gitOut(parent.path, ["remote"], { allowFailure: true })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!remotes.includes("origin")) {
    const local = runGit(parent.path, ["rev-parse", "--verify", `${baseRef}^{commit}`], {
      allowFailure: true,
    });
    if (!local.ok || !local.stdout) {
      fail("BASE_REF_UNRESOLVABLE", `base ref '${baseRef}' does not resolve in the parent checkout`, {
        base_ref: baseRef,
        path: parent.path,
        git_stderr: local.stderr,
      });
    }
    return { ref: baseRef, sha: local.stdout, source: "local" };
  }

  const fetched = runGit(parent.path, ["fetch", "--quiet", "origin", "--", baseRef], {
    allowFailure: true,
    timeout: GIT_FETCH_TIMEOUT_MS,
  });
  if (!fetched.ok) {
    fail("BASE_REF_UNRESOLVABLE", `base ref '${baseRef}' could not be fetched from origin`, {
      base_ref: baseRef,
      path: parent.path,
      git_stderr: fetched.stderr,
      hint: "the base is pinned from origin on purpose; branching off a stale local ref is not a supported fallback",
    });
  }
  const sha = runGit(parent.path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
    allowFailure: true,
  });
  if (!sha.ok || !sha.stdout) {
    fail("BASE_REF_UNRESOLVABLE", `origin returned no commit for base ref '${baseRef}'`, {
      base_ref: baseRef,
      path: parent.path,
      git_stderr: sha.stderr,
    });
  }
  return { ref: baseRef, sha: sha.stdout, source: "origin" };
}

/**
 * Ref-shaped arguments a caller supplies, which git will happily read as
 * options.
 *
 * `git fetch origin <ref>` parses options anywhere on the command line, and
 * `--upload-pack=<cmd>` names a program to execute. So a `--base` value
 * beginning with `-` is not a ref at all — it is an argument to git, and it
 * runs commands. Measured on this station before the guard existed:
 * `addWorktree({ base: "--upload-pack=touch <marker>; git-upload-pack" })`
 * returned success and created the marker file. The regression test keeps a
 * positive control that fires the same payload at git directly, so "rejected"
 * cannot quietly become "rejected because everything is rejected".
 *
 * `git check-ref-format` is not sufficient on its own: it is given
 * `refs/heads/<value>`, so `refs/heads/--upload-pack=x` is a well-formed ref
 * name and exits 0. The leading-dash refusal and the charset are what do the
 * work; check-ref-format is the second gate, not the first. `--` separators are
 * added at the call sites that support them, so validation and git's own
 * parsing both have to fail before an option is smuggled through.
 */
const REF_ARGUMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$/;

function assertRefArgument(
  parent: ParentCheckout,
  value: string,
  code: "INVALID_BASE_REF" | "INVALID_BRANCH_NAME",
  label: string,
): string {
  const printable = String(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
  if (
    typeof value !== "string"
    || !REF_ARGUMENT_PATTERN.test(value)
    || value.includes("..")
    || value.endsWith(".")
    || value.endsWith("/")
    || value.endsWith(".lock")
  ) {
    fail(code, `'${printable}' is not a usable ${label}`, {
      hint: "a ref must start with a letter or digit; a leading '-' would be read by git as an option",
    });
  }
  const wellFormed = runGit(parent.path, ["check-ref-format", "--allow-onelevel", `refs/heads/${value}`], {
    allowFailure: true,
  });
  if (!wellFormed.ok) {
    fail(code, `'${printable}' is not a well-formed ${label}`, {});
  }
  return value;
}

/**
 * Is this directory a *linked* worktree, as opposed to a primary checkout, a
 * submodule, or an ordinary directory?
 *
 * Read from the filesystem rather than by asking git. `git worktree add` writes
 * `.git` as a FILE holding `gitdir: <common>/worktrees/<name>`, while a primary
 * checkout has `.git` as a directory and a submodule's pointer goes to
 * `<parent>/.git/modules/<name>` — so the `worktrees/` segment in the pointer is
 * the exact discriminator, and it needs no subprocess.
 *
 * That matters at the scale this runs at: `worktree list` measured 54 seconds on
 * the live root because this predicate spawned two `git rev-parse` processes for
 * each of roughly 1,900 candidate directories. Reading one small file instead
 * removes ~3,800 process spawns from a read-only report.
 */
function isLinkedWorktree(path: string): boolean {
  const pointer = join(path, ".git");
  let stats;
  try {
    stats = lstatSync(pointer);
  } catch {
    return false;
  }
  // A primary checkout keeps its object store here; it is not a linked worktree.
  if (stats.isDirectory()) return false;
  if (!stats.isFile()) return false;
  try {
    const gitdir = readFileSync(pointer, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!gitdir) return false;
    // `<common>/worktrees/<name>` is git's linked-worktree layout. A submodule
    // points at `<parent>/.git/modules/<name>` and is correctly excluded.
    return /(^|\/)worktrees\/[^/]+\/?$/.test(gitdir);
  } catch {
    return false;
  }
}

export function addWorktree(request: AddWorktreeRequest): AddWorktreeResult {
  const db = request.db ?? getDb();
  if ((request.task ? 1 : 0) + (request.name ? 1 : 0) !== 1) {
    fail("INVALID_REQUEST", "exactly one of --task and --name is required");
  }
  // Name validation runs before anything is resolved or created, so a crafted
  // name never reaches the filesystem — not even as a `mkdir` of its parent.
  const worktreeName = assertWorktreeName(request.task ?? request.name);

  const repo = resolveRepo(request.repo);
  const repoSegment = assertRepoSegment(repo.name);
  const parent = assertHealthyParent(repo);

  const root = worktreeRootDir();
  const target = join(root, repoSegment, worktreeName);
  // Belt and braces: the computed path must still land inside the root after
  // symlink resolution. `<root>/<repo>` may itself be a symlink planted by
  // something else on a shared station.
  const resolvedTarget = assertInsideRoot(target, "the computed worktree path");
  if (!isDerivedCheckoutPath(resolvedTarget)) {
    // The path must be classified as a derived checkout, so that a remote
    // lookup resolving `github.com/hasna/<x>` prefers the primary clone over
    // any worktree of it (`getRepoByRemote` narrows on exactly this predicate).
    //
    // The scanner uses this same predicate as its admission rule, while this
    // assertion protects the complementary lookup-ranking invariant here.
    fail("LAYOUT_INVARIANT_VIOLATED", "the computed worktree path is not recognised as a derived checkout", {
      path: resolvedTarget,
      root,
    });
  }

  const machineId = request.machineId ?? getSourceMachineId();
  const runId = request.runId ?? "";
  // Every caller-supplied ref is validated here, before any filesystem or git
  // work, so a hostile value cannot reach git even on a code path that fails
  // for some other reason first.
  const baseRef = assertRefArgument(
    parent,
    request.base ?? repo.default_branch ?? "main",
    "INVALID_BASE_REF",
    "base ref",
  );
  const branch = assertRefArgument(parent, request.branch ?? worktreeName, "INVALID_BRANCH_NAME", "branch name");
  const repoId = repoIdentity(repo);

  const existing =
    leaseByClaim(db, { repoId, machineId, taskId: request.task ?? worktreeName, runId, baseRef })
    ?? leaseByPath(db, target);

  if (existing && existsSync(existing.worktree_path) && isLinkedWorktree(existing.worktree_path)) {
    // Idempotent by design. A second `add` for the same claim is a caller
    // re-entering, not a caller asking for a clean slate — the destroy-then-
    // create reading of this is the factory hazard.
    db.query("UPDATE worktree_leases SET verified_at = ?, updated_at = ? WHERE lease_id = ?")
      .run(nowIso(), nowIso(), existing.lease_id);
    return {
      schema: WORKTREE_LEASE_SCHEMA,
      path: existing.worktree_path,
      created: false,
      reused: true,
      base: { ref: existing.base_ref, sha: existing.base_sha, source: recordedBaseSource(existing) },
      lease: leaseById(db, existing.lease_id)!,
    };
  }

  if (existsSync(target)) {
    fail("WORKTREE_PATH_OCCUPIED", "the computed worktree path already exists", {
      path: target,
      hint: "nothing is removed to make room; inspect the path and adopt or clear it deliberately",
    });
  }

  const branchExists = runGit(parent.path, ["rev-parse", "--verify", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  if (branchExists.ok && branchExists.stdout) {
    fail("BRANCH_EXISTS", `branch '${branch}' already exists in the parent checkout`, { branch });
  }

  const base = resolveBase(parent, baseRef);

  mkdirSync(dirname(target), { recursive: true });
  runGit(parent.path, ["worktree", "add", "--quiet", "-b", branch, target, base.sha]);

  // Re-assert containment on what was actually created. The check above ran
  // before `git worktree add`, and nothing stops a component of the path from
  // being replaced with a symlink in between on a shared station. This does not
  // close the race — it detects the outcome, and reports rather than deletes,
  // because deleting a path that just moved out of the root is the exact
  // mistake this module exists to prevent.
  const created = resolveThroughExisting(target);
  if (!isWithin(realpathOrSelf(root), created)) {
    fail("LAYOUT_INVARIANT_VIOLATED", "the created worktree does not resolve inside the canonical root", {
      path: created,
      root,
      hint: "nothing was removed; inspect the path before acting on it",
    });
  }

  const timestamp = nowIso();
  const lease: WorktreeLease = {
    lease_id: existing?.lease_id ?? newLeaseId(),
    repo_id: repoId,
    repo_path: parent.path,
    repo_catalog_id: repo.id,
    machine_id: machineId,
    worktree_path: target,
    branch,
    base_ref: base.ref,
    base_sha: base.sha,
    task_id: request.task ?? worktreeName,
    run_id: runId,
    mode: request.mode ?? (request.task ? "task" : "manual"),
    owner_metadata: JSON.stringify({ base_source: base.source, worktree_name: worktreeName }),
    cleanup_policy: request.cleanupPolicy ?? "delete-if-clean",
    status: "claimed",
    git_common_dir: parent.commonDir,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
    claimed_at: timestamp,
    verified_at: timestamp,
    released_at: null,
    last_error: null,
  };
  try {
    upsertLease(db, lease);
  } catch (error) {
    // The worktree exists on disk at this point. The lease table carries two
    // more uniqueness constraints than the primary key, so a concurrent `add`
    // that won the race leaves this insert failing over a directory that is
    // already there. Reporting a raw SQLite error would read as a bug in the
    // registry; the recoverable truth is that the worktree is unleased.
    fail("LEASE_CONFLICT", "the worktree was created but its lease could not be recorded", {
      path: target,
      lease_id: lease.lease_id,
      hint: "another process holds a conflicting lease; run `repos worktree adopt <path> --apply` to reconcile",
      git_stderr: redactGitDiagnostics(String((error as Error).message ?? "")),
    });
  }

  return {
    schema: WORKTREE_LEASE_SCHEMA,
    path: target,
    created: true,
    reused: Boolean(existing),
    base,
    lease: leaseById(db, lease.lease_id)!,
  };
}

function upsertLease(db: Database, lease: WorktreeLease): void {
  db.query(
    `INSERT INTO worktree_leases (
       lease_id, repo_id, repo_path, repo_catalog_id, machine_id, worktree_path, branch,
       base_ref, base_sha, task_id, run_id, mode, owner_metadata, cleanup_policy, status,
       git_common_dir, created_at, updated_at, claimed_at, verified_at, released_at, last_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lease_id) DO UPDATE SET
       repo_path = excluded.repo_path,
       repo_catalog_id = excluded.repo_catalog_id,
       worktree_path = excluded.worktree_path,
       branch = excluded.branch,
       base_ref = excluded.base_ref,
       base_sha = excluded.base_sha,
       mode = excluded.mode,
       owner_metadata = excluded.owner_metadata,
       cleanup_policy = excluded.cleanup_policy,
       status = excluded.status,
       git_common_dir = excluded.git_common_dir,
       updated_at = excluded.updated_at,
       verified_at = excluded.verified_at,
       released_at = excluded.released_at,
       last_error = excluded.last_error`,
  ).run(
    lease.lease_id,
    lease.repo_id,
    lease.repo_path,
    lease.repo_catalog_id,
    lease.machine_id,
    lease.worktree_path,
    lease.branch,
    lease.base_ref,
    lease.base_sha,
    lease.task_id,
    lease.run_id,
    lease.mode,
    lease.owner_metadata,
    lease.cleanup_policy,
    lease.status,
    lease.git_common_dir,
    lease.created_at,
    lease.updated_at,
    lease.claimed_at,
    lease.verified_at,
    lease.released_at,
    lease.last_error,
  );
}

// ── remove ───────────────────────────────────────────────────────────────────

export interface RemoveWorktreeRequest {
  /** A lease id, or `<repo-name>/<worktree-name>`. Never a filesystem path. */
  ref: string;
  discardChanges?: boolean;
  db?: Database;
}

export interface RemoveWorktreeResult {
  schema: typeof WORKTREE_LEASE_SCHEMA;
  removed: boolean;
  path: string;
  branch: string | null;
  lease_id: string | null;
  evidence_path: string | null;
}

type ParsedRef =
  | { kind: "lease"; leaseId: string }
  | { kind: "pair"; repoName: string; worktreeName: string };

/**
 * Parse the only two reference shapes a destructive verb accepts.
 *
 * Everything path-shaped is rejected here, before resolution — an absolute
 * path, a relative path, a `..` component, a tilde and a three-segment string
 * all fail on shape. That is what makes "remove the wrong directory" an
 * argument this CLI cannot express.
 */
export function parseWorktreeRef(ref: string): ParsedRef {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200 || ref.includes("\0")) {
    fail("INVALID_REQUEST", "a lease id or <repo>/<worktree> reference is required");
  }
  const parts = ref.split("/");
  if (parts.length === 1) {
    if (!NAME_PATTERN.test(ref) || ref.endsWith(".")) {
      fail("INVALID_REQUEST", "a lease id must be a single slug token, not a path", { name: ref });
    }
    return { kind: "lease", leaseId: ref };
  }
  if (parts.length === 2) {
    const [repoName, worktreeName] = parts as [string, string];
    if (
      !NAME_PATTERN.test(repoName) || repoName.endsWith(".")
      || !NAME_PATTERN.test(worktreeName) || worktreeName.endsWith(".")
    ) {
      fail("INVALID_REQUEST", "a <repo>/<worktree> reference must be two plain name segments", { name: ref });
    }
    return { kind: "pair", repoName, worktreeName };
  }
  fail("INVALID_REQUEST", "a filesystem path is not an accepted reference; use a lease id or <repo>/<worktree>", {
    name: ref.slice(0, 64),
  });
}

interface ResolvedTarget {
  path: string;
  lease: WorktreeLease | null;
  branch: string | null;
  parentPath: string | null;
}

function resolveRemovalTarget(db: Database, ref: string): ResolvedTarget {
  const parsed = parseWorktreeRef(ref);
  if (parsed.kind === "lease") {
    const lease = leaseById(db, parsed.leaseId);
    if (!lease) fail("LEASE_NOT_FOUND", `no lease '${parsed.leaseId}'`, { lease_id: parsed.leaseId });
    return { path: lease.worktree_path, lease, branch: lease.branch, parentPath: lease.repo_path };
  }
  const path = join(worktreeRootDir(), parsed.repoName, parsed.worktreeName);
  const lease = leaseByPath(db, path);
  if (lease) return { path, lease, branch: lease.branch, parentPath: lease.repo_path };
  if (!existsSync(path)) {
    fail("LEASE_NOT_FOUND", `no lease and no directory for '${ref}'`, { path });
  }
  // An adopted stray: on disk and a real worktree, but never leased. It is
  // still removable, because refusing here would leave the corpus unmanageable.
  return { path, lease: null, branch: null, parentPath: null };
}

/**
 * Archive whatever would be destroyed, before destroying it.
 *
 * The governance convention (`k_mrssvzft_b76n48`) requires backup-on-reap. The
 * durable loss in a forced teardown is commits that exist nowhere else, so the
 * branch is bundled; the visible loss is the working-tree diff, so that is
 * written as a patch. Untracked file *contents* are listed but not copied —
 * stated here rather than implied, because an archive that silently omits
 * something is worse than one that says what it omits.
 */
function archiveBeforeReap(target: ResolvedTarget, leaseId: string): string {
  // The archive directory is named after the lease, and on the
  // `<repo>/<worktree>` path that id comes from the database row rather than
  // from the argument — so unlike a lease-id reference it has never been
  // through `parseWorktreeRef`. A row whose primary key contained `../..` would
  // place the archive outside the root, which is the one thing this module
  // promises cannot happen. Anything that is not a plain segment is replaced
  // rather than trusted.
  const evidenceDir = join(
    worktreeRootDir(),
    ".evidence",
    `${safePathSegment(leaseId)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

  // Each capture records its own failure. `runGit` caps child output at 32 MB,
  // so a diff larger than that throws, is swallowed by `allowFailure`, and would
  // otherwise be written as an empty patch next to a successful-looking
  // `evidence_path`. An archive that silently omits something is worse than one
  // that says what it could not take.
  const incomplete: string[] = [];
  const capture = (file: string, args: string[]) => {
    const result = runGit(target.path, args, { allowFailure: true });
    writeFileSync(join(evidenceDir, file), `${result.stdout}\n`);
    if (!result.ok) incomplete.push(`${file}: git ${args[0]} failed: ${result.stderr}`);
  };

  const status = gitOut(target.path, ["status", "--porcelain"], { allowFailure: true });
  writeFileSync(join(evidenceDir, "dirty-status.txt"), `${status}\n`);
  capture("tracked-changes.patch", ["diff", "HEAD"]);
  capture("untracked-files.txt", ["ls-files", "--others", "--exclude-standard"]);

  const unpushed = countUnpushedCommits(target.path);
  if (unpushed > 0) {
    // `HEAD` is always bundled, and it is what makes this archive honest.
    //
    // The first version bundled the *lease's* branch. A detached HEAD — rebase,
    // bisect, an explicit `checkout --detach`, all ordinary — puts the commits
    // where that branch does not point, so the unpushed count was right, the
    // bundle was of the wrong ref, and the commits were destroyed while
    // `evidence_path` reported an archive. `HEAD` is the ref that describes
    // what is about to be deleted, attached or not.
    //
    // The checked-out branch is added alongside it when there is one, so the
    // bundle can be restored by name. The lease's claimed branch is deliberately
    // NOT used: it is a stored value that may have gone stale, and this is the
    // last chance to preserve the data.
    const revisions = ["HEAD"];
    const headBranch = gitOut(target.path, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    if (headBranch && headBranch !== "HEAD" && REF_ARGUMENT_PATTERN.test(headBranch)) {
      revisions.push(headBranch);
    }
    const bundlePath = join(evidenceDir, "branch.bundle");
    const bundled = runGit(target.path, ["bundle", "create", bundlePath, ...revisions], {
      allowFailure: true,
    });
    if (!bundled.ok) {
      incomplete.push(`branch.bundle: git bundle failed: ${bundled.stderr}`);
    } else {
      // The archive verifies its own output, because until now it did not.
      // `git bundle create` declines an empty range without failing loudly, and
      // an archive that reports success while holding nothing is worse than no
      // archive: the caller acts on `evidence_path` and the commits are gone.
      const headSha = gitOut(target.path, ["rev-parse", "HEAD"], { allowFailure: true });
      const heads = gitOut(target.path, ["bundle", "list-heads", bundlePath], { allowFailure: true });
      if (!headSha || !heads.includes(headSha)) {
        incomplete.push(`branch.bundle: does not contain HEAD (${headSha.slice(0, 12) || "unresolved"})`);
      }
    }
  }
  if (incomplete.length > 0) {
    writeFileSync(join(evidenceDir, "INCOMPLETE.txt"), `${incomplete.join("\n")}\n`);
  }
  return evidenceDir;
}

function countUnpushedCommits(path: string): number {
  const counted = runGit(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"], {
    allowFailure: true,
  });
  if (!counted.ok) return 0;
  const value = Number.parseInt(counted.stdout, 10);
  return Number.isFinite(value) ? value : 0;
}

export function removeWorktree(request: RemoveWorktreeRequest): RemoveWorktreeResult {
  const db = request.db ?? getDb();
  const target = resolveRemovalTarget(db, request.ref);

  // Containment after symlink resolution: the lease was written when the path
  // was inside the root; that is not evidence it still is.
  const resolved = assertInsideRoot(target.path, "the worktree path");
  if (target.parentPath && realpathOrSelf(target.parentPath) === resolved) {
    fail("TARGET_IS_PARENT_CHECKOUT", "the resolved path is the parent checkout", { path: resolved });
  }
  if (!existsSync(resolved) || !isLinkedWorktree(resolved)) {
    fail("NOT_A_WORKTREE", "the resolved path is not a linked git worktree", {
      path: resolved,
      hint: "use `repos worktree list` to reconcile leases against disk",
    });
  }

  const dirty = gitOut(resolved, ["status", "--porcelain"], { allowFailure: true });
  const unpushed = countUnpushedCommits(resolved);
  if (!request.discardChanges) {
    if (dirty) {
      fail("WORKTREE_DIRTY", "the worktree has uncommitted changes", {
        path: resolved,
        hint: "commit or pass --discard-changes; a forced teardown archives the diff first",
      });
    }
    if (unpushed > 0) {
      fail("WORKTREE_UNPUSHED", `the worktree carries ${unpushed} commit(s) that exist on no remote`, {
        path: resolved,
        hint: "push the branch or pass --discard-changes; a forced teardown bundles the branch first",
      });
    }
  }

  const leaseId = target.lease?.lease_id ?? `adopted-${Date.now()}`;
  const evidencePath = request.discardChanges && (dirty || unpushed > 0)
    ? archiveBeforeReap({ ...target, path: resolved }, leaseId)
    : null;

  const parentForGit = target.parentPath && existsSync(target.parentPath) ? target.parentPath : resolved;
  // The branch to delete is the one this worktree actually has checked out, read
  // now, not the one the lease claims.
  //
  // Adversarial-review finding P2-3: the lease's branch is a stored value that
  // goes stale the moment anyone switches branches inside the worktree, and
  // `adopt --all --apply` would freeze an adopt-time name into every lease on
  // this station. Deleting by that name reached into the parent checkout — often
  // a shared clone — and force-deleted an unrelated live branch, silently,
  // because the delete runs with `allowFailure`.
  const headBranch = gitOut(resolved, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const branch = headBranch && headBranch !== "HEAD" ? headBranch : null;

  runGit(parentForGit, request.discardChanges
    ? ["worktree", "remove", "--force", resolved]
    : ["worktree", "remove", resolved]);
  runGit(parentForGit, ["worktree", "prune"], { allowFailure: true });
  if (branch && REF_ARGUMENT_PATTERN.test(branch)) {
    runGit(
      parentForGit,
      request.discardChanges ? ["branch", "-D", "--", branch] : ["branch", "-d", "--", branch],
      { allowFailure: true },
    );
  }

  if (target.lease) {
    const timestamp = nowIso();
    db.query("UPDATE worktree_leases SET status = 'released', released_at = ?, updated_at = ? WHERE lease_id = ?")
      .run(timestamp, timestamp, target.lease.lease_id);
  }

  return {
    schema: WORKTREE_LEASE_SCHEMA,
    removed: true,
    path: resolved,
    branch,
    lease_id: target.lease?.lease_id ?? null,
    evidence_path: evidencePath,
  };
}

// ── release ──────────────────────────────────────────────────────────────────

export interface ReleaseWorktreeRequest {
  leaseId: string;
  keep?: boolean;
  db?: Database;
}

export interface ReleaseWorktreeResult {
  schema: typeof WORKTREE_LEASE_SCHEMA;
  removed: boolean;
  refusal: WorktreeErrorCode | null;
  evidence_path: string | null;
  lease: WorktreeLease;
}

export function releaseWorktree(request: ReleaseWorktreeRequest): ReleaseWorktreeResult {
  const db = request.db ?? getDb();
  const parsed = parseWorktreeRef(request.leaseId);
  if (parsed.kind !== "lease") {
    fail("INVALID_REQUEST", "release takes a lease id; use `worktree remove` for a <repo>/<worktree> pair");
  }
  const lease = leaseById(db, parsed.leaseId);
  if (!lease) fail("LEASE_NOT_FOUND", `no lease '${request.leaseId}'`, { lease_id: request.leaseId });

  const timestamp = nowIso();
  const markReleased = () => {
    db.query("UPDATE worktree_leases SET status = 'released', released_at = ?, updated_at = ? WHERE lease_id = ?")
      .run(timestamp, timestamp, lease.lease_id);
    return leaseById(db, lease.lease_id)!;
  };

  if (request.keep || lease.cleanup_policy !== "delete-if-clean") {
    return {
      schema: WORKTREE_LEASE_SCHEMA,
      removed: false,
      refusal: null,
      evidence_path: null,
      lease: markReleased(),
    };
  }

  try {
    const removal = removeWorktree({ ref: lease.lease_id, db });
    return {
      schema: WORKTREE_LEASE_SCHEMA,
      removed: removal.removed,
      refusal: null,
      evidence_path: removal.evidence_path,
      lease: leaseById(db, lease.lease_id)!,
    };
  } catch (error) {
    if (error instanceof WorktreeError) {
      // `delete-if-clean` means exactly that: a refusal leaves the lease
      // claimed and the directory intact, and reports why.
      db.query("UPDATE worktree_leases SET last_error = ?, updated_at = ? WHERE lease_id = ?")
        .run(error.code, timestamp, lease.lease_id);
      return {
        schema: WORKTREE_LEASE_SCHEMA,
        removed: false,
        refusal: error.code,
        evidence_path: null,
        lease: leaseById(db, lease.lease_id)!,
      };
    }
    throw error;
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

export type WorktreeIssue =
  | "no-lease"
  | "missing-directory"
  | "flat-layout"
  | "nested-layout"
  | "machine-mismatch"
  | "stale"
  | "not-a-worktree";

export interface WorktreeListEntry {
  path: string;
  repo_name: string | null;
  worktree_name: string | null;
  lease_id: string | null;
  branch: string | null;
  machine_id: string | null;
  status: string | null;
  claimed_at: string | null;
  on_disk: boolean;
  is_worktree: boolean;
  issues: WorktreeIssue[];
}

export interface WorktreeListResult {
  schema: typeof WORKTREE_LIST_SCHEMA;
  root: string;
  summary: { entries: number; issue_count: number; leases: number; on_disk: number };
  entries: WorktreeListEntry[];
}

export interface WorktreeListOptions {
  staleDays?: number;
  onlyStale?: boolean;
  now?: Date;
  db?: Database;
  machineId?: string;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listChildDirs(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((entry) => !RESERVED_ROOT_ENTRIES.has(entry))
      .map((entry) => join(path, entry))
      .filter(isDirectory);
  } catch {
    return [];
  }
}

/**
 * Walk the root and classify what is actually there against what the leases
 * claim.
 *
 * The classes are the ones measured on this station, not invented ones: a
 * directory that is itself a worktree sitting directly under the root
 * (`flat-layout`), a worktree buried one level deeper than the convention
 * allows — the `station01/` machine segment (`nested-layout`), a lease whose
 * directory is gone, and a lease claimed by another machine.
 */
export function listWorktrees(options: WorktreeListOptions = {}): WorktreeListResult {
  const db = options.db ?? getDb();
  const root = worktreeRootDir();
  const machineId = options.machineId ?? getSourceMachineId();
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const now = options.now ?? new Date();

  const leases = db.query("SELECT * FROM worktree_leases WHERE status != 'released'").all() as WorktreeLease[];
  const leaseByWorktreePath = new Map(leases.map((lease) => [lease.worktree_path, lease]));
  const entries = new Map<string, WorktreeListEntry>();

  const record = (path: string, seed: Partial<WorktreeListEntry> = {}): WorktreeListEntry => {
    const existing = entries.get(path);
    if (existing) return existing;
    const entry: WorktreeListEntry = {
      path,
      repo_name: null,
      worktree_name: null,
      lease_id: null,
      branch: null,
      machine_id: null,
      status: null,
      claimed_at: null,
      on_disk: existsSync(path),
      is_worktree: false,
      issues: [],
      ...seed,
    };
    entries.set(path, entry);
    return entry;
  };

  for (const repoDir of listChildDirs(root)) {
    const repoName = repoDir.slice(root.length + 1);
    if (isLinkedWorktree(repoDir) || existsSync(join(repoDir, ".git"))) {
      // A worktree (or any checkout) directly under the root: the flat class.
      const entry = record(repoDir, { worktree_name: repoName, on_disk: true, is_worktree: true });
      entry.issues.push("flat-layout");
      continue;
    }
    for (const worktreeDir of listChildDirs(repoDir)) {
      const worktreeName = worktreeDir.slice(repoDir.length + 1);
      const linked = isLinkedWorktree(worktreeDir);
      const entry = record(worktreeDir, {
        repo_name: repoName,
        worktree_name: worktreeName,
        on_disk: true,
        is_worktree: linked,
      });
      if (!linked) {
        // Not a worktree at this depth — either an ordinary directory or a
        // machine segment holding worktrees one level further down.
        const deeper = listChildDirs(worktreeDir).filter((child) =>
          isLinkedWorktree(child) || existsSync(join(child, ".git")));
        if (deeper.length > 0) {
          entries.delete(worktreeDir);
          for (const nested of deeper) {
            // The repo segment is carried down. Adversarial-review finding P2-5:
            // leaving it null meant `worktree list <repo>` filtered out a
            // violation sitting literally inside `<root>/<repo>/` — 218 nested
            // entries invisible to exactly the query that should surface them.
            const nestedEntry = record(nested, {
              repo_name: repoName,
              worktree_name: nested.slice(worktreeDir.length + 1),
              on_disk: true,
              is_worktree: true,
            });
            nestedEntry.issues.push("nested-layout");
          }
          continue;
        }
        entry.issues.push("not-a-worktree");
      }
    }
  }

  for (const lease of leases) {
    // The repo segment comes from the lease's position under the root, not from
    // the parent checkout's directory name — those differ (`open-repos` under
    // the root, `clones/open-repos` on disk) and a listing keyed on the wrong
    // one cannot be filtered by the same name `add` was given.
    const relativeToRoot = isWithin(root, lease.worktree_path)
      ? relative(root, lease.worktree_path).split(sep)
      : [];
    const entry = record(lease.worktree_path, {
      repo_name: relativeToRoot.length >= 2 ? relativeToRoot[0]! : null,
      worktree_name: lease.worktree_path.split(sep).pop() ?? null,
      on_disk: existsSync(lease.worktree_path),
    });
    entry.lease_id = lease.lease_id;
    entry.branch = lease.branch;
    entry.machine_id = lease.machine_id;
    entry.status = lease.status;
    entry.claimed_at = lease.claimed_at;
    if (!entry.on_disk) entry.issues.push("missing-directory");
    if (lease.machine_id !== machineId) entry.issues.push("machine-mismatch");
    const claimedAt = Date.parse(lease.claimed_at);
    if (Number.isFinite(claimedAt) && now.getTime() - claimedAt > staleDays * 86_400_000) {
      entry.issues.push("stale");
    }
  }

  for (const entry of entries.values()) {
    if (!entry.lease_id && entry.on_disk && !leaseByWorktreePath.has(entry.path)) {
      entry.issues.push("no-lease");
    }
  }

  const all = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  const filtered = options.onlyStale ? all.filter((entry) => entry.issues.includes("stale")) : all;
  return {
    schema: WORKTREE_LIST_SCHEMA,
    root,
    summary: {
      entries: filtered.length,
      issue_count: filtered.filter((entry) => entry.issues.length > 0).length,
      leases: leases.length,
      on_disk: filtered.filter((entry) => entry.on_disk).length,
    },
    entries: filtered,
  };
}

// ── adopt ────────────────────────────────────────────────────────────────────

export interface AdoptWorktreeRequest {
  /** The one place a raw path is accepted — and it is read-only toward it. */
  path?: string;
  all?: boolean;
  apply?: boolean;
  db?: Database;
  machineId?: string;
}

export interface AdoptedWorktree {
  path: string;
  repo_name: string | null;
  worktree_name: string;
  branch: string | null;
  repo_catalog_id: number | null;
  lease_id: string | null;
  mode: string;
  already_leased: boolean;
}

export interface AdoptWorktreeResult {
  schema: typeof WORKTREE_ADOPT_SCHEMA;
  applied: boolean;
  root: string;
  adopted: AdoptedWorktree[];
}

function repoRowForCommonDir(db: Database, commonDir: string): Repo | null {
  const checkout = commonDir.replace(/\/\.git\/?$/, "");
  const rows = db.query("SELECT * FROM repos").all() as Repo[];
  return rows.find((row) => realpathOrSelf(row.path) === realpathOrSelf(checkout)) ?? null;
}

/**
 * Backfill leases for worktrees that exist on disk without one.
 *
 * This is the sanctioned migration path for the measured corpus, so it defaults
 * to a dry run: 444 entries is not a set anybody should mutate on the strength
 * of a flag they typed once. It never moves, deletes or modifies the worktree
 * it adopts.
 */
export function adoptWorktrees(request: AdoptWorktreeRequest = {}): AdoptWorktreeResult {
  const db = request.db ?? getDb();
  const root = worktreeRootDir();
  const machineId = request.machineId ?? getSourceMachineId();

  if (!request.path && !request.all) {
    fail("INVALID_REQUEST", "either a path or --all is required");
  }

  const candidates: string[] = [];
  if (request.path) {
    if (!isAbsolute(request.path)) {
      fail("INVALID_REQUEST", "an adopt path must be absolute", { path: request.path });
    }
    // Containment first: a path outside the root is refused before it is even
    // stat'd, so a probe cannot be used to test for the existence of files
    // elsewhere on the station.
    const resolved = assertInsideRoot(request.path, "the adopt path");
    if (!existsSync(resolved) || !isLinkedWorktree(resolved)) {
      fail("NOT_A_WORKTREE", "the path is not a linked git worktree", { path: resolved });
    }
    candidates.push(resolved);
  } else {
    for (const repoDir of listChildDirs(root)) {
      for (const worktreeDir of listChildDirs(repoDir)) {
        if (isLinkedWorktree(worktreeDir)) candidates.push(worktreeDir);
      }
    }
  }

  const adopted: AdoptedWorktree[] = [];
  for (const path of candidates) {
    const existing = leaseByPath(db, path);
    const commonDir = realpathOrSelf(
      gitOut(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFailure: true }),
    );
    const repo = repoRowForCommonDir(db, commonDir);
    const branch = gitOut(path, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true }) || null;
    const worktreeName = path.split(sep).pop() ?? path;
    const record: AdoptedWorktree = {
      path,
      repo_name: repo?.name ?? null,
      worktree_name: worktreeName,
      branch,
      repo_catalog_id: repo?.id ?? null,
      lease_id: existing?.lease_id ?? null,
      mode: "adopted",
      already_leased: Boolean(existing),
    };

    if (request.apply && !existing) {
      const timestamp = nowIso();
      const headSha = gitOut(path, ["rev-parse", "HEAD"], { allowFailure: true }) || "";
      const lease: WorktreeLease = {
        lease_id: newLeaseId(),
        repo_id: repo ? repoIdentity(repo) : `path:${commonDir}`,
        repo_path: repo?.path ?? commonDir.replace(/\/\.git\/?$/, ""),
        repo_catalog_id: repo?.id ?? null,
        machine_id: machineId,
        worktree_path: path,
        branch: branch ?? "HEAD",
        base_ref: branch ?? "HEAD",
        base_sha: headSha,
        task_id: worktreeName,
        run_id: "",
        mode: "adopted",
        owner_metadata: JSON.stringify({ adopted_at: timestamp, worktree_name: worktreeName }),
        cleanup_policy: "keep",
        status: "claimed",
        git_common_dir: commonDir,
        created_at: timestamp,
        updated_at: timestamp,
        claimed_at: timestamp,
        verified_at: timestamp,
        released_at: null,
        last_error: null,
      };
      upsertLease(db, lease);
      record.lease_id = lease.lease_id;
    }
    adopted.push(record);
  }

  return {
    schema: WORKTREE_ADOPT_SCHEMA,
    applied: Boolean(request.apply),
    root,
    adopted,
  };
}
