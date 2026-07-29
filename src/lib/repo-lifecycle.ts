/**
 * The repository plane: create, clone, archive — with the credential behind
 * the verb.
 *
 * ## Why the credential model is the feature
 *
 * The R5 directive (owner, 2026-07-28) wants repository lifecycle verbs so
 * that agents on any station call an abstraction instead of holding "all the
 * credentials in the world". A verb that wraps `gh` while the *caller's*
 * token does the authenticating has delivered nothing — so the boundary here
 * is concrete and tested, not aspirational:
 *
 *   - **Caller token variables are scrubbed** from every child this module
 *     spawns (`GH_TOKEN`, `GITHUB_TOKEN` and their enterprise forms), and so
 *     are the store redirections `GH_CONFIG_DIR` and `XDG_CONFIG_HOME`, because
 *     pointing `gh` at a caller-written credential store substitutes the
 *     identity exactly as a caller-supplied token would. The operation's
 *     authority is never something the calling agent supplied.
 *   - **The CLI resolves its own credential** from station configuration:
 *     either a configured `github.credentialCommand` (an argv — for example a
 *     vault read — whose stdout is the token, injected only into the child
 *     process environment), or, absent one, the station `gh`'s own credential
 *     store. The station operator chooses once, in config; callers cannot.
 *   - **Fail closed.** A configured credential command that fails, is
 *     malformed, or produces nothing is a typed CREDENTIAL_UNAVAILABLE error
 *     raised *before any child is spawned* — never a silent fall-through to
 *     the gh store. An unauthenticated gh maps to the same code, so automation
 *     can tell "the credential plane is down" from "the operation failed".
 *   - **The resolved token never reaches the caller**: not in results, and
 *     scrubbed from error diagnostics even when a child echoes it back.
 *
 * ## What this phase is and is not
 *
 * This is the station-side half of the design in
 * `designs/r5-repos-credential-abstraction-design.md` (CEO workspace): the
 * verb surface and the choke point. The broker — a hosted mint issuing
 * short-lived, repo-scoped tokens so stations hold no long-lived GitHub
 * credential at all — is that design's Phase 2 and slots in as one more
 * credential source behind `resolveCredential()`, without changing any verb.
 * Until it lands, the honest statement is: the *caller* needs no credential;
 * the *station* still holds one, behind station config the caller cannot
 * reach. Same shape as the worktree plane's stated Phase 1 caveat.
 *
 * ## Why there is no delete verb
 *
 * Standing owner rule (2026-07-24): archive, never hard-delete. The verb set
 * cannot express deletion, so no token with delete capability is ever needed —
 * blast-radius reduction by making the hazard unrepresentable, the same move
 * `worktree remove` makes against raw paths.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AmbiguousRepoNameError, getRepo } from "../db/repos.js";
import { getConfig } from "./config.js";
import { scanRepoPaths } from "./scanner.js";
import { redactGitDiagnostics } from "./worktrees.js";

export const REPO_CREATE_SCHEMA = "open-repos.repo-create.v1" as const;
export const REPO_CLONE_SCHEMA = "open-repos.repo-clone.v1" as const;
export const REPO_ARCHIVE_SCHEMA = "open-repos.repo-archive.v1" as const;

const GH_TIMEOUT_MS = 60_000;
const GH_CLONE_TIMEOUT_MS = 300_000;
const CREDENTIAL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The caller-supplied variable names `gh` would otherwise treat as authority.
 * Scrubbed from every child environment, unconditionally: even when the gh
 * store is the configured source, the credential must be the *station's*, not
 * whatever the calling agent happened to export.
 */
const CALLER_TOKEN_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/**
 * Variables that carry no token themselves but redirect `gh` to a *different*
 * credential store, which substitutes the authority just as effectively.
 *
 * Scrubbing the token variables alone left the boundary open, measured against
 * the real CLI and a genuinely private repository: with all four token
 * variables unset, `GH_CONFIG_DIR` (and equally `XDG_CONFIG_HOME`, which `gh`
 * consults next) pointed at a caller-written `hosts.yml` made `gh` authenticate
 * with the caller's token — `HTTP 401: Bad credentials` — where the identical
 * call resolved through the station store and succeeded. So the caller, not the
 * station, decided which identity performed the operation, while the result
 * still reported `credential_source: "gh-store"`.
 *
 * `HOME` is deliberately *not* scrubbed: `gh`'s default config path is
 * `$HOME/.config/gh`, which is precisely where the station's own credential
 * lives. Removing these two redirections is what makes that default binding.
 * A station that genuinely keeps its `gh` config somewhere else now fails
 * closed and loudly with CREDENTIAL_UNAVAILABLE rather than silently borrowing
 * whichever store the caller pointed at.
 */
const CALLER_CREDENTIAL_STORE_ENV_NAMES = [
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

export type RepoLifecycleErrorCode =
  | "INVALID_REPO_SPEC"
  | "CREDENTIAL_UNAVAILABLE"
  | "REPO_EXISTS"
  | "REPO_NOT_FOUND"
  | "AMBIGUOUS_REPO"
  | "REPO_HAS_NO_REMOTE"
  | "TARGET_PATH_OCCUPIED"
  | "CLONE_REGISTER_FAILED"
  | "GH_UNAVAILABLE"
  | "GH_FAILED";

export interface RepoLifecycleErrorDetails {
  spec?: string;
  target?: string;
  path?: string;
  hint?: string;
  gh_stderr?: string;
}

export class RepoLifecycleError extends Error {
  constructor(
    public readonly code: RepoLifecycleErrorCode,
    message: string,
    public readonly details: RepoLifecycleErrorDetails = {},
  ) {
    super(message);
    this.name = "RepoLifecycleError";
  }
}

function fail(code: RepoLifecycleErrorCode, message: string, details: RepoLifecycleErrorDetails = {}): never {
  throw new RepoLifecycleError(code, message, details);
}

/**
 * `<org>/<name>`, both segments starting alphanumeric. The grammar is the
 * guard: a leading dash (flag injection into gh argv), a `..` or `.` segment
 * (path expression), whitespace, or extra segments are unrepresentable, so
 * nothing downstream needs to defend against them.
 */
const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface RepoSpec {
  org: string;
  name: string;
}

export function parseRepoSpec(spec: string): RepoSpec {
  const segments = spec.split("/");
  if (segments.length === 2) {
    const [org, name] = segments as [string, string];
    if (ORG_PATTERN.test(org) && NAME_PATTERN.test(name) && name !== "." && name !== "..") {
      return { org, name };
    }
  }
  fail("INVALID_REPO_SPEC", `'${spec}' is not a valid <org>/<name> repository spec`, {
    spec,
    hint: "Both segments start alphanumeric; the name allows [A-Za-z0-9._-].",
  });
}

/** True when the string is spec-shaped, without throwing. */
export function isRepoSpec(value: string): boolean {
  try {
    parseRepoSpec(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Redaction for anything that might carry the resolved token: the known
 * provider prefixes via the shared git-diagnostics redactor, plus the exact
 * token value, which a credential command may mint in a shape no prefix list
 * anticipates.
 */
export function redactRepoLifecycleText(text: string, token: string | null): string {
  const base = redactGitDiagnostics(text);
  if (!token) return base;
  return base.split(token).join("<redacted>");
}

export type CredentialSource = "credential-command" | "gh-store";

interface ResolvedCredential {
  source: CredentialSource;
  /** Held for redaction only; never serialized, never logged. */
  token: string | null;
  /** The full environment for gh children — built once, used everywhere. */
  env: Record<string, string | undefined>;
}

/**
 * The choke point. Every gh child in this module runs in the environment this
 * function returns, so the boundary properties hold by construction rather
 * than per call site.
 */
function resolveCredential(): ResolvedCredential {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of CALLER_TOKEN_ENV_NAMES) delete env[name];
  for (const name of CALLER_CREDENTIAL_STORE_ENV_NAMES) delete env[name];

  const configured = getConfig().github?.credentialCommand;
  if (configured === undefined) {
    return { source: "gh-store", token: null, env };
  }

  // A configured command that cannot run as configured is a hard stop, not a
  // downgrade: falling back to the gh store here would silently swap which
  // identity performs the operation.
  const argv = Array.isArray(configured)
    ? configured.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  if (!Array.isArray(configured) || argv.length !== configured.length || argv.length === 0) {
    fail("CREDENTIAL_UNAVAILABLE", "github.credentialCommand is configured but malformed", {
      hint: "Expected a non-empty array of non-empty strings in the repos config.",
    });
  }

  let stdout: string;
  try {
    stdout = execFileSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CREDENTIAL_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env,
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    const detail = redactRepoLifecycleText(
      String(failure.stderr ?? "").trim() || String(failure.message ?? "credential command failed"),
      null,
    );
    fail("CREDENTIAL_UNAVAILABLE", "the configured credential command failed", {
      hint: detail,
    });
  }

  const token = stdout.trim();
  if (token.length === 0 || /\s/.test(token)) {
    fail("CREDENTIAL_UNAVAILABLE", "the configured credential command did not produce a single-line token", {
      hint: "The command's stdout must be exactly one token.",
    });
  }

  env["GH_TOKEN"] = token;
  return { source: "credential-command", token, env };
}

interface GhOptions {
  timeout?: number;
  allowFailure?: boolean;
}

interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Diagnostics that mean "gh has no working credential", not "gh failed". */
const GH_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /gh auth login/i,
  /not logged in/i,
  /authentication (?:required|failed)/i,
  /HTTP 401/i,
  /Bad credentials/i,
];

function isGhAuthFailure(stderr: string): boolean {
  return GH_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

function runGh(credential: ResolvedCredential, args: string[], options: GhOptions = {}): GhResult {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? GH_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: credential.env,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const failure = error as { code?: string; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    if (failure.code === "ENOENT") {
      fail("GH_UNAVAILABLE", "the GitHub CLI (gh) is not installed on this station", {
        hint: "Repository-plane verbs run GitHub operations through gh.",
      });
    }
    const stderr = redactRepoLifecycleText(
      String(failure.stderr ?? "").trim() || String(failure.message ?? "gh failed"),
      credential.token,
    );
    if (!options.allowFailure) {
      if (isGhAuthFailure(stderr)) {
        fail("CREDENTIAL_UNAVAILABLE", "the station's GitHub credential did not authenticate", {
          gh_stderr: stderr,
          hint: "The credential lives behind the CLI: fix the station's gh login or github.credentialCommand, not the caller's environment.",
        });
      }
      fail("GH_FAILED", `gh ${args[0]} ${args[1] ?? ""} failed`.trim(), { gh_stderr: stderr });
    }
    return { ok: false, stdout: String(failure.stdout ?? "").trim(), stderr };
  }
}

function githubIdentityFromRemote(remoteUrl: string | null | undefined): RepoSpec | null {
  if (!remoteUrl) return null;
  const match = /github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (!match) return null;
  return { org: match[1]!, name: match[2]! };
}

/**
 * A registry name/id/path, or an `<org>/<name>` spec, resolved to a GitHub
 * identity. Registry resolution keeps the exact-match semantics of
 * `repos repo`: ambiguity is a refusal, never a guess.
 */
function resolveGithubIdentity(target: string): RepoSpec {
  if (isRepoSpec(target)) return parseRepoSpec(target);

  let repo;
  try {
    repo = getRepo(target);
  } catch (error) {
    if (error instanceof AmbiguousRepoNameError) {
      fail("AMBIGUOUS_REPO", error.message, { target });
    }
    throw error;
  }
  if (!repo) {
    fail("REPO_NOT_FOUND", `No registry row matches '${target}'`, {
      target,
      hint: "Pass an explicit <org>/<name> spec for repositories not in the local registry.",
    });
  }
  const identity = githubIdentityFromRemote(repo.remote_url);
  if (!identity) {
    fail("REPO_HAS_NO_REMOTE", `Registry row '${repo.name}' has no GitHub remote to operate on`, {
      target,
      path: repo.path,
    });
  }
  return identity;
}

interface CloneOutcome {
  path: string;
  registered: boolean;
}

/**
 * Clone `<org>/<name>` to `<parentDir>/<name>` and register the checkout.
 *
 * The destination is refused, never cleared, when occupied — the factory
 * destroy-then-create hazard stays unrepresentable on this plane too. And a
 * clone that cannot be registered is a failure, not a warning: the verb's
 * contract is acquire-and-register, and half of it done silently is how
 * registry rows drift from disk.
 */
async function cloneAndRegister(credential: ResolvedCredential, spec: RepoSpec, parentDir: string): Promise<CloneOutcome> {
  const destination = join(resolve(parentDir), spec.name);
  if (existsSync(destination)) {
    fail("TARGET_PATH_OCCUPIED", `${destination} already exists`, {
      path: destination,
      hint: "The verb never removes an occupant. Pick another --dir or remove the path yourself.",
    });
  }
  runGh(credential, ["repo", "clone", `${spec.org}/${spec.name}`, destination], {
    timeout: GH_CLONE_TIMEOUT_MS,
  });
  await scanRepoPaths([destination]);
  const registered = getRepo(destination) !== null;
  if (!registered) {
    fail("CLONE_REGISTER_FAILED", `cloned to ${destination} but the checkout did not register`, {
      path: destination,
      hint: "The clone is intact on disk; inspect `repos scan` output for why indexing skipped it.",
    });
  }
  return { path: destination, registered };
}

export type RepoVisibility = "private" | "public";

export interface CreateRepositoryRequest {
  spec: string;
  visibility?: RepoVisibility;
  description?: string;
  /** When present, also clone to `<cloneParentDir>/<name>` and register it. */
  cloneParentDir?: string;
}

export interface CreateRepositoryResult {
  schema: typeof REPO_CREATE_SCHEMA;
  ok: true;
  repo: { org: string; name: string; url: string; visibility: RepoVisibility };
  credential_source: CredentialSource;
  clone: CloneOutcome | null;
}

export async function createRepository(request: CreateRepositoryRequest): Promise<CreateRepositoryResult> {
  const spec = parseRepoSpec(request.spec);
  const visibility: RepoVisibility = request.visibility === "public" ? "public" : "private";
  const credential = resolveCredential();

  // Existence preflight, fail-closed on anything that is not a clean 404: an
  // auth failure or an outage must stop the verb, not read as "free to create".
  const preflight = runGh(credential, ["api", `repos/${spec.org}/${spec.name}`, "-q", ".id"], {
    allowFailure: true,
  });
  if (preflight.ok) {
    fail("REPO_EXISTS", `${spec.org}/${spec.name} already exists on GitHub`, { spec: request.spec });
  }
  if (!/\b404\b/.test(preflight.stderr)) {
    if (isGhAuthFailure(preflight.stderr)) {
      fail("CREDENTIAL_UNAVAILABLE", "the station's GitHub credential did not authenticate", {
        gh_stderr: preflight.stderr,
        hint: "The credential lives behind the CLI: fix the station's gh login or github.credentialCommand, not the caller's environment.",
      });
    }
    fail("GH_FAILED", "could not determine whether the repository already exists", {
      spec: request.spec,
      gh_stderr: preflight.stderr,
    });
  }

  const args = ["repo", "create", `${spec.org}/${spec.name}`, visibility === "public" ? "--public" : "--private"];
  if (request.description) args.push("--description", request.description);
  const created = runGh(credential, args);
  // gh prints the new repository's URL; carrying it through instead of
  // deriving one keeps this module free of hardcoded host assumptions.
  const url = created.stdout.split("\n").pop()?.trim() ?? "";

  const clone = request.cloneParentDir
    ? await cloneAndRegister(credential, spec, request.cloneParentDir)
    : null;

  return {
    schema: REPO_CREATE_SCHEMA,
    ok: true,
    repo: { org: spec.org, name: spec.name, url, visibility },
    credential_source: credential.source,
    clone,
  };
}

export interface CloneRepositoryRequest {
  spec: string;
  /** Parent directory; the clone lands at `<parentDir>/<name>`. Default: cwd. */
  parentDir?: string;
}

export interface CloneRepositoryResult {
  schema: typeof REPO_CLONE_SCHEMA;
  ok: true;
  repo: RepoSpec;
  credential_source: CredentialSource;
  clone: CloneOutcome;
}

export async function cloneRepository(request: CloneRepositoryRequest): Promise<CloneRepositoryResult> {
  const spec = parseRepoSpec(request.spec);
  const credential = resolveCredential();
  const clone = await cloneAndRegister(credential, spec, request.parentDir ?? process.cwd());
  return {
    schema: REPO_CLONE_SCHEMA,
    ok: true,
    repo: spec,
    credential_source: credential.source,
    clone,
  };
}

export interface ArchiveRepositoryRequest {
  /** Registry id/name/path, or an explicit `<org>/<name>` spec. */
  target: string;
  /** Unarchive instead. Archive is reversible; delete is not a verb here. */
  restore?: boolean;
}

export interface ArchiveRepositoryResult {
  schema: typeof REPO_ARCHIVE_SCHEMA;
  ok: true;
  repo: RepoSpec;
  archived: boolean;
  credential_source: CredentialSource;
}

export function archiveRepository(request: ArchiveRepositoryRequest): ArchiveRepositoryResult {
  const spec = resolveGithubIdentity(request.target);
  const credential = resolveCredential();
  const verb = request.restore ? "unarchive" : "archive";
  runGh(credential, ["repo", verb, `${spec.org}/${spec.name}`, "--yes"]);
  return {
    schema: REPO_ARCHIVE_SCHEMA,
    ok: true,
    repo: spec,
    archived: !request.restore,
    credential_source: credential.source,
  };
}
