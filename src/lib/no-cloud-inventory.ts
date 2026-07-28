import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

type InventoryStatus = "verify-clean" | "needs-remediation";
type InventoryRouting = "canonical" | "duplicate" | "unkeyed";

type InternalRepoFinding = NoCloudRepoFinding & {
  policy_path: string;
  nested_parent_path: string | null;
};

export interface NoCloudInventoryOptions {
  root?: string;
  limit?: number;
  maxDepth?: number;
  includeNpm?: boolean;
  npmPackages?: string[];
  /**
   * Registry-side enumeration, injectable so tests never depend on the network —
   * an inventory test that silently loses its registry source would be testing
   * the very regression this guards against.
   */
  enumerateScopedPackages?: () => ScopeEnumeration;
}

export interface NoCloudRepoFinding {
  path: string;
  repo_key: string | null;
  routing: InventoryRouting;
  routeable: boolean;
  route_blocked_reason: string | null;
  canonical_path: string | null;
  duplicate_of: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  head: string | null;
  dirty: number;
  remote: string | null;
  files: number;
  package: number;
  lock: number;
  source: number;
  docs: number;
  config: number;
  status: InventoryStatus;
}

export interface NoCloudNpmFinding {
  package: string;
  version: string | null;
  cloud_dep: string | null;
  status: "published" | "published-cloud-dep" | "cloud-package" | "unpublished" | "npm-view-failed";
}

export interface NoCloudInventoryReport {
  kind: "no_cloud_inventory";
  schema_version: "1.3";
  root: string;
  patterns: string[];
  summary: {
    repos: number;
    needs_remediation: number;
    verify_clean: number;
    routeable: number;
    duplicate_repos: number;
    unkeyed_repos: number;
    dirty: number;
    registry_packages: number;
    registry_cloud_deps: number;
    registry_unpublished: number;
    /** How many checked names each source contributed. null when not enumerated. */
    registry_from_local_manifests: number;
    registry_from_registry: number | null;
    /**
     * Whether the registry-side enumeration ran. `failed` means the inventory is
     * narrower than it should be, and says so rather than looking complete.
     */
    registry_enumeration: ScopeEnumerationStatus;
    registry_enumeration_detail: string | null;
    /** Per-source outcome, so a degraded or truncated source is visible. */
    registry_enumeration_sources: ScopeEnumerationSource[] | null;
  };
  repos: NoCloudRepoFinding[];
  npm: NoCloudNpmFinding[];
  excluded: string[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_DEPTH = 8;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const SCHEMA_VERSION = "1.3" as const;

const CLOUD_PACKAGE = "@hasna" + "/cloud";
const CLOUD_PATTERNS = [
  CLOUD_PACKAGE,
  ["register", "Cloud", "Tools"].join(""),
  ["register", "Cloud", "Commands"].join(""),
  ["cloud", "mcp"].join("-"),
  [".hasna", "cloud"].join("/"),
  ["HASNA", "CLOUD", ""].join("_"),
  ["HASNA", "RDS", "PASSWORD"].join("_"),
];

/**
 * The registry inventory: which published packages this report checks.
 *
 * It was a frozen literal list of 37 names that no source of truth maintained.
 * The list outlived its contents — `@hasna/swarm` was unpublished on 2026-07-27
 * while still named in it, and `@hasna/deployment` is a live 404 today — so the
 * report kept asserting packages that no longer exist.
 *
 * Deriving the list from the `package.json` of each scanned repo fixes the
 * staleness and introduces a worse failure in its place: **derivation can only
 * see packages that have a local manifest.** `iapp-wallets` has none, so
 * `@hasna/wallets@0.1.10` — which actively declares the retired
 * `"@hasna/cloud": "^0.1.24"` — silently stops being checked. Fifteen published
 * packages drop out of coverage that way. Swapping a stale narrow source for a
 * different narrow source is not a fix; both fail the same way, silently and
 * downward.
 *
 * So the two sources are UNIONED, and the report says what each contributed:
 *
 *   1. **local manifests** under the scan roots — authoritative for what this
 *      machine has checked out, and immediately correct for renames;
 *   2. **the registry itself** (`npm search` over the scope) — authoritative for
 *      what is actually published, including packages with no local checkout.
 *
 * Neither is authoritative alone, which is exactly why neither may replace the
 * other. Coverage now only shrinks when a package is genuinely gone from both.
 *
 * `@hasna/cloud` is added unconditionally and can never be removed by either
 * source. It is the subject of the whole report, and it is *not* discoverable
 * from the registry enumeration: `npm search` omits deprecated packages, and
 * `@hasna/cloud@0.1.41` is deprecated — the precise fact the report exists to
 * surface. A source that cannot see the thing being audited must not be able to
 * drop it.
 */
export const PACKAGE_SCOPE = "@hasna" as const;

export type ScopeEnumerationStatus = "ok" | "failed" | "skipped";

/**
 * `truncated` exists because a result set sitting exactly on the registry's
 * result ceiling is indistinguishable from a complete one, and calling that `ok`
 * is the silent narrowing this module exists to prevent.
 */
export type ScopeSourceStatus = "ok" | "failed" | "truncated";

export interface ScopeEnumerationSource {
  source: string;
  status: ScopeSourceStatus;
  names: number;
  detail: string | null;
}

export interface ScopeEnumeration {
  status: ScopeEnumerationStatus;
  names: string[];
  detail: string | null;
  /** Per-source outcome, so a degraded source is visible even when the union is ok. */
  sources?: ScopeEnumerationSource[];
}

export interface NpmPackageInventory {
  packages: string[];
  from_local_manifests: number;
  from_registry: number | null;
  registry_enumeration: ScopeEnumerationStatus;
  registry_enumeration_detail: string | null;
  registry_enumeration_sources: ScopeEnumerationSource[] | null;
}

/** Package names declared by the manifests of the repos actually scanned. */
export function deriveLocalPackageNames(repoRoots: string[]): string[] {
  const names = new Set<string>();
  for (const repoRoot of repoRoots) {
    const name = localPackageName(repoRoot);
    if (name && name.startsWith(`${PACKAGE_SCOPE}/`)) names.add(name);
  }
  return [...names].sort();
}

function localPackageName(repoRoot: string): string | null {
  try {
    const manifest = join(repoRoot, "package.json");
    if (!existsSync(manifest)) return null;
    if (statSync(manifest).size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The registry search API caps a result set at 250 however large `--searchlimit`
 * is: `npm search --json --searchlimit=1000 react` returns exactly 250. So the
 * ceiling is a property of the registry, not of this parameter, and a saturated
 * result cannot be raised out of truncation by asking for more.
 */
const SEARCH_RESULT_CEILING = 250;

function scopedNamesFrom(values: unknown[]): string[] {
  const names = new Set<string>();
  for (const entry of values) {
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown })?.name;
    if (typeof name === "string" && name.startsWith(`${PACKAGE_SCOPE}/`)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Decide whether a search result is complete or merely as much as the registry
 * would return.
 *
 * `rawResultCount` is the unfiltered result count, not the scoped subset: the
 * ceiling applies to what the search returned, and `npm search @hasna` is a fuzzy
 * text search whose results include unrelated packages that consume slots.
 */
export function classifyScopeSearchResult(
  scopedNames: string[],
  rawResultCount: number,
  searchLimit: number,
): ScopeEnumeration {
  if (rawResultCount >= searchLimit) {
    return {
      status: "ok",
      names: scopedNames,
      detail: `npm search returned ${rawResultCount} result(s), the maximum for --searchlimit=${searchLimit}`
        + ` (the registry search API caps a result set at ${SEARCH_RESULT_CEILING} regardless), so this`
        + " enumeration is truncated and coverage may be narrower than the scope",
      sources: [{ source: "search", status: "truncated", names: scopedNames.length, detail: null }],
    };
  }
  return { status: "ok", names: scopedNames, detail: null };
}

/**
 * Source 1 — `npm search` over the scope.
 *
 * Correct for what is indexed, and that is strictly less than what is published:
 * it omits deprecated packages, and measured on 2026-07-28 it also omitted live
 * non-deprecated ones (`@hasna/assistants-sdk@0.1.7`, `@hasna/configs-sdk@0.1.3`).
 * A search index is not an enumeration, so it cannot be the only registry source.
 */
export function enumerateScopeSearch(searchLimit = SEARCH_RESULT_CEILING): ScopeEnumeration {
  try {
    const raw = execFileSync("npm", ["search", "--json", `--searchlimit=${searchLimit}`, PACKAGE_SCOPE], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { status: "failed", names: [], detail: "npm search did not return a JSON array" };
    }
    const classified = classifyScopeSearchResult(scopedNamesFrom(parsed), parsed.length, searchLimit);
    return classified;
  } catch (error) {
    return { status: "failed", names: [], detail: redactText(describeExecFailure(error)) };
  }
}

/**
 * Source 2 — the scope roster.
 *
 * This is the source that sees what search cannot. Measured on 2026-07-28 the
 * roster returned 170 names against search's 160, `search \\ roster` was empty —
 * so the roster is a strict superset — and the ten it adds include
 * `@hasna/coders@0.2.14`, which was in the hardcoded list this module replaced and
 * otherwise dropped out of coverage entirely, plus two packages that declare the
 * retired `@hasna/cloud` today (`@hasna/cli@0.1.0` at `^0.1.5`,
 * `@hasna/open-projects@0.1.1` at `^0.1.28`).
 *
 * It needs no credential. `npm access list packages` fails E401 when it sends a
 * token that lacks org read — the failure is caused by *offering* the credential,
 * not by lacking one — while `GET /-/org/<scope>/package` answers 200
 * unauthenticated. So an authenticated attempt is retried with the user config
 * suppressed, which drops the token. Only the user-level config is dropped:
 * project and global `.npmrc` still apply, so a custom registry configured there
 * is still honoured.
 */
export function enumerateScopeRoster(scope = PACKAGE_SCOPE): ScopeEnumeration {
  const attempt = (extraArgs: string[]): { names: string[] } => {
    const raw = execFileSync("npm", ["access", "list", "packages", scope, "--json", ...extraArgs], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return { names: scopedNamesFrom(parsed) };
    if (parsed && typeof parsed === "object") return { names: scopedNamesFrom(Object.keys(parsed)) };
    throw new Error("npm access list packages did not return a JSON object or array");
  };

  let firstFailure = "";
  try {
    return { status: "ok", names: attempt([]).names, detail: null };
  } catch (error) {
    firstFailure = redactText(describeExecFailure(error));
  }
  try {
    // Anonymous retry. The path is never created; npm treats a missing user
    // config as empty, which is exactly the point.
    return { status: "ok", names: attempt(["--userconfig", join(tmpdir(), "repos-no-cloud-anonymous-npmrc")]).names, detail: null };
  } catch (error) {
    return {
      status: "failed",
      names: [],
      detail: `${firstFailure}\n(anonymous retry) ${redactText(describeExecFailure(error))}`.slice(0, 1000),
    };
  }
}

/**
 * Combine the registry-side sources.
 *
 * A source failure degrades; it does not fail the enumeration. Making either
 * source's failure fatal would make a common path fail while coverage was in fact
 * complete — `npm search` is flaky and the roster is a semi-public endpoint — and
 * "correct but breaks a common path" is still a regression. Only every source
 * failing means the registry side contributed nothing, which is the case that has
 * to be reported loudly. Names from a `truncated` source are kept: partial
 * coverage beats none, as long as the partiality is visible.
 */
export function unionScopeEnumerations(
  entries: Array<{ source: string; result: ScopeEnumeration }>,
): ScopeEnumeration {
  const names = new Set<string>();
  const sources: ScopeEnumerationSource[] = [];
  const details: string[] = [];

  for (const { source, result } of entries) {
    for (const name of result.names) names.add(name);
    const status: ScopeSourceStatus = result.status === "failed"
      ? "failed"
      : result.sources?.some((inner) => inner.status === "truncated") ? "truncated" : "ok";
    sources.push({ source, status, names: result.names.length, detail: result.detail });
    if (result.detail) details.push(`${source}: ${result.detail}`);
  }

  const everySourceFailed = entries.length > 0 && sources.every((source) => source.status === "failed");
  return {
    status: everySourceFailed ? "failed" : "ok",
    names: [...names].sort(),
    detail: details.length > 0 ? details.join("\n") : null,
    sources,
  };
}

/** Both registry-side sources, unioned. */
export function enumerateScopedPackages(searchLimit = SEARCH_RESULT_CEILING): ScopeEnumeration {
  return unionScopeEnumerations([
    { source: "roster", result: enumerateScopeRoster() },
    { source: "search", result: enumerateScopeSearch(searchLimit) },
  ]);
}

function describeExecFailure(error: unknown): string {
  const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [failure.stderr, failure.stdout, failure.message]
    .map((part) => (typeof part === "string" ? part : Buffer.isBuffer(part) ? part.toString("utf-8") : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 500) || "npm search failed with no diagnostic output";
}

/** Union the two sources, with `@hasna/cloud` pinned in unconditionally. */
export function resolveNpmPackageChecks(
  repoRoots: string[],
  opts: { enumerate?: () => ScopeEnumeration } = {},
): NpmPackageInventory {
  const local = deriveLocalPackageNames(repoRoots);
  const enumeration = (opts.enumerate ?? (() => enumerateScopedPackages()))();
  const packages = new Set<string>([CLOUD_PACKAGE, ...local, ...enumeration.names]);
  return {
    packages: [...packages].sort(),
    from_local_manifests: local.length,
    from_registry: enumeration.status === "ok" ? enumeration.names.length : null,
    registry_enumeration: enumeration.status,
    registry_enumeration_detail: enumeration.detail,
    registry_enumeration_sources: enumeration.sources ?? null,
  };
}

/**
 * An absent package and an unusable npm client both make `npm view` exit
 * non-zero. Collapsing them into one status is what let a retired package read as
 * a transient blip, so a registry 404 is reported as `unpublished` and everything
 * else stays a failure.
 */
export function classifyNpmViewFailure(detail: string): "unpublished" | "npm-view-failed" {
  if (/\bE404\b/.test(detail) || /\b404 Not Found\b/i.test(detail)) return "unpublished";
  return "npm-view-failed";
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  ".cache",
]);

function cap(value: number | undefined, fallback: number, max = 500): number {
  if (!Number.isFinite(value ?? fallback)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value ?? fallback)));
}

function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s@]+)@/g, "$1***@")
    .replace(/(^|\s)([^@\s:]+:[^@\s]+)@([^@\s]+:[^\s]+)/g, "$1***@$3")
    .replace(/\b(token|password|secret|api[_-]?key)=([^&\s]+)/gi, "$1=***")
    .replace(/\bsecret[-]token:[^\s&]+/gi, () => "secret" + "-token:***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/\b(gh[p]_|gh[o]_|ctx7sk[-]|xai[-]|sk-[a-z]+[-]|npm[_])[A-Za-z0-9_-]+/gi, "$1***")
    .replace(/\bAI[z]a[A-Za-z0-9_-]+/g, () => "AI" + "za***")
    .replace(/\b(?:A[K]IA|ASIA)[A-Z0-9]{16}\b/g, "AWS_ACCESS_KEY_ID_***");
}

function redactPath(path: string): string {
  const home = process.env["HOME"]?.replaceAll("\\", "/");
  const normalized = path.replaceAll("\\", "/");
  if (home && normalized.startsWith(`${home}/`)) return `~/${normalized.slice(home.length + 1)}`;
  return redactText(normalized);
}

function runGit(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function shouldSkipDir(path: string): boolean {
  const name = basename(path);
  if (SKIP_DIRS.has(name)) return true;
  return isPolicyExcludedDir(path);
}

function isPolicyExcludedDir(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return lower.includes("/open-loops")
    || lower.includes("/open-codewith")
    || lower.includes("/.codewith")
    || name.includes("codewith");
}

function remoteRepoKey(remote: string | null): string | null {
  const identity = sanitizeRemoteIdentity(remote);
  if (!identity?.startsWith("github.com/")) return null;
  return identity.slice("github.com/".length).toLowerCase();
}

function parseAheadBehind(raw: string | null): { ahead: number | null; behind: number | null } {
  if (!raw) return { ahead: null, behind: null };
  const [aheadText, behindText] = raw.split(/\s+/);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  const behind = Number.parseInt(behindText ?? "", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

function isTextCandidate(path: string): boolean {
  const name = basename(path);
  if (name === "bun.lock" || name === "package-lock.json" || name === "pnpm-lock.yaml" || name === "yarn.lock") return true;
  return /\.(cjs|cts|js|json|jsx|md|mjs|mts|sh|ts|tsx|txt|toml|ya?ml)$/i.test(name);
}

function isLockfile(path: string): boolean {
  const name = basename(path);
  return name === "bun.lock" || name === "package-lock.json" || name === "pnpm-lock.yaml" || name === "yarn.lock";
}

function containsCloudPattern(path: string): boolean {
  if (!isTextCandidate(path)) return false;
  try {
    const maxBytes = isLockfile(path) ? MAX_LOCKFILE_BYTES : MAX_FILE_BYTES;
    if (statSync(path).size > maxBytes) return isLockfile(path);
    const text = readFileSync(path, "utf-8");
    return CLOUD_PATTERNS.some((pattern) => text.includes(pattern));
  } catch {
    return false;
  }
}

function collectGitRoots(root: string, maxDepth: number): { roots: string[]; excluded: string[] } {
  const roots = new Set<string>();
  const excluded = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    if (shouldSkipDir(dir)) {
      if (isPolicyExcludedDir(dir)) excluded.add(redactPath(dir));
      return;
    }
    if (existsSync(join(dir, ".git"))) roots.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }

  walk(root, 0);
  return { roots: [...roots].sort(), excluded: [...excluded].sort() };
}

/**
 * Is this directory the top of a real git working tree?
 *
 * `existsSync(dir + "/.git")` is not that question, and answering the wrong one
 * here is the defect. Any directory holding a `.git` entry — an empty `.git`
 * directory, a gutted skeleton, a stray file — was accepted as an enclosing
 * repository, so every checkout below it was reported `nested-git-checkout`,
 * `routeable: false`, with `canonical_path` decided from a repo that does not
 * exist.
 *
 * That is production behaviour, not a test artifact. It is also why this module's
 * own suite was environment-dependent: a bare `/tmp/.git` on the host — not a
 * valid repository — became the "parent" of every fixture created under `TMPDIR`,
 * which is how 7 tests failed on an untouched `main` and were mistaken for a
 * broken baseline. Asking git resolves both at once.
 *
 * Deliberately *not* bounded at the scan root. A checkout nested inside another
 * real checkout is an unsafe remediation target whether or not the scan happened
 * to start below the parent, and this module's own contract says so: scanning a
 * nested checkout directly must still report it as nested, so a nested repo
 * cannot be laundered into a routeable one by pointing the scan at it.
 */
function isGitWorkTreeTop(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  // Same question the scanner asks before trusting a remote: `git -C` searches
  // upwards, so only an answer naming this exact directory proves the repository
  // is here rather than somewhere above it.
  const toplevel = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return false;
  return resolve(toplevel).replaceAll("\\", "/") === resolve(dir).replaceAll("\\", "/");
}

function nearestAncestorGitRoot(root: string): string | null {
  let current = dirname(resolve(root));
  while (current !== dirname(current)) {
    if (isGitWorkTreeTop(current)) return current;
    current = dirname(current);
  }
  return null;
}

function nearestNestedParent(root: string, roots: string[]): string | null {
  const normalizedRoot = root.replaceAll("\\", "/");
  const discoveredParent = roots
    .filter((candidate) => {
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      return normalizedCandidate !== normalizedRoot && normalizedRoot.startsWith(`${normalizedCandidate}/`);
    })
    .sort((a, b) => b.length - a.length)[0] ?? null;

  return discoveredParent ?? nearestAncestorGitRoot(root);
}

function collectCloudFiles(root: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    if (shouldSkipDir(dir)) return;
    if (dir !== root && existsSync(join(dir, ".git"))) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (containsCloudPattern(full)) files.push(full);
    }
  }

  walk(root);
  return files.sort();
}

function categoryCounts(root: string, files: string[]) {
  let packageFiles = 0;
  let lock = 0;
  let source = 0;
  let docs = 0;
  let config = 0;

  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (/(^|\/)package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(rel)) packageFiles += 1;
    if (/(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(rel)) lock += 1;
    if (/(^|\/)(src|bin|scripts|lib|server|mcp|cli)\//.test(rel)) source += 1;
    if (/(^|\/)(README|CHANGELOG)|(^|\/)docs\/|\.md$/.test(rel)) docs += 1;
    if (/(^|\/)(\.mcp|\.github|infra|config|hooks|scripts)\/|\.(json|toml|ya?ml)$/.test(rel)) config += 1;
  }

  return { package: packageFiles, lock, source, docs, config };
}

function repoFinding(root: string, base: string, nestedParentPath: string | null): InternalRepoFinding {
  const files = collectCloudFiles(root);
  const counts = categoryCounts(root, files);
  const dirty = (runGit(root, ["status", "--porcelain=v1"]) ?? "")
    .split("\n")
    .filter(Boolean)
    .length;
  const remote = runGit(root, ["remote", "get-url", "origin"]);
  const upstream = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const drift = parseAheadBehind(upstream ? runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]) : null);

  return {
    path: redactPath(relative(base, root) || root),
    policy_path: root.replaceAll("\\", "/").toLowerCase(),
    nested_parent_path: nestedParentPath,
    repo_key: remoteRepoKey(remote),
    routing: "unkeyed",
    routeable: false,
    route_blocked_reason: "missing-github-remote",
    canonical_path: null,
    duplicate_of: null,
    branch: runGit(root, ["branch", "--show-current"]),
    upstream,
    ahead: drift.ahead,
    behind: drift.behind,
    head: runGit(root, ["rev-parse", "--short", "HEAD"]),
    dirty,
    remote: sanitizeRemoteIdentity(remote),
    files: files.length,
    package: counts.package,
    lock: counts.lock,
    source: counts.source,
    docs: counts.docs,
    config: counts.config,
    status: files.length === 0 ? "verify-clean" : "needs-remediation",
  };
}

function canonicalPathTier(repo: InternalRepoFinding, expectedOpenName: string, path: string): number {
  if (expectedOpenName && (path === expectedOpenName || path.endsWith(`/opensource/${expectedOpenName}`))) return 0;
  if (repo.nested_parent_path) return 3;
  if (auxiliaryPathReason(repo)) return 2;
  return 1;
}

function expectedOpenCheckoutName(repoName: string): string {
  return repoName.startsWith("open-") ? repoName : `open-${repoName}`;
}

function canonicalScore(repo: InternalRepoFinding): [number, number, number, string] {
  const path = repo.path.toLowerCase();
  const repoName = repo.repo_key?.split("/").pop() ?? "";
  const expectedOpenName = repoName ? expectedOpenCheckoutName(repoName) : "";
  const pathTier = canonicalPathTier(repo, expectedOpenName, path);
  let score = 0;

  if (expectedOpenName && (path === expectedOpenName || path.endsWith(`/opensource/${expectedOpenName}`))) score -= 100;
  if (repo.branch === "main") score -= 20;
  if (repo.dirty > 0) score += 250;
  if (/(^|\/)opensourcedev(\/|$)/.test(path) || repo.policy_path.includes("/opensourcedev/")) score += 180;
  if ((repo.behind ?? 0) > 0) score += 220;
  if ((repo.ahead ?? 0) > 0) score += 180;
  if (repo.branch !== "main") score += 160;
  if (repo.upstream !== "origin/main") score += 160;
  if (path.includes("/.codewith")) score += 250;
  if (/(compact|improve|review|feature|worktree|codex|goal|pr-\d+)/.test(path)) score += 80;

  return [pathTier, score, path.length, path];
}

function isNoTouchRepoKey(repoKey: string | null): boolean {
  if (!repoKey) return false;
  const repoName = repoKey.split("/").pop() ?? "";
  return repoKey === "hasna/loops" || repoKey === "hasna/codewith" || repoName.includes("codewith");
}

function isManagedRepoKey(repoKey: string | null): boolean {
  if (!repoKey) return false;
  const owner = repoKey.split("/")[0];
  return [
    "hasna",
    "hasnaai",
    "hasnaeducation",
    "hasnafamily",
    "hasnafoundation",
    "hasnastudio",
    "hasnatools",
    "hasnaxyz",
  ].includes(owner ?? "");
}

function auxiliaryPathReason(finding: InternalRepoFinding): string | null {
  const path = finding.path;
  const lower = path.toLowerCase();
  const policyPath = finding.policy_path;
  if (/(^|\/)opensourcedev(\/|$)/.test(lower)) return "auxiliary-opensourcedev-checkout";
  if (policyPath.includes("/opensourcedev/")) return "auxiliary-opensourcedev-checkout";
  if (/(^|\/)\.codewith(\/|$)/.test(lower)) return "codewith-worktree";
  if (policyPath.includes("/.codewith")) return "codewith-worktree";
  if (/(^|\/)[^/]*(compact|improve|review|feature|worktree|codex|goal|pr-\d+)[^/]*(\/|$)/.test(lower)) {
    return "auxiliary-checkout";
  }
  return null;
}

function routeBlockedReason(finding: InternalRepoFinding, isCanonical: boolean): string | null {
  if (!isCanonical) return "duplicate-checkout";
  if (finding.repo_key === "hasna/cloud") return "cloud-package-final-tombstone-gated";
  if (isNoTouchRepoKey(finding.repo_key)) return "no-touch-repo";
  if (!isManagedRepoKey(finding.repo_key)) return "outside-managed-org";
  if (finding.nested_parent_path) return "nested-git-checkout";
  if (finding.dirty > 0) return "dirty-worktree";
  const pathReason = auxiliaryPathReason(finding);
  if (pathReason) return pathReason;
  if (finding.branch !== "main") return finding.branch ? "non-main-branch" : "detached-head";
  if (!finding.upstream) return "missing-upstream";
  if (finding.upstream !== "origin/main") return "non-origin-main-upstream";
  if (finding.ahead === null || finding.behind === null) return "unknown-upstream-drift";
  if (finding.behind > 0) return "behind-upstream";
  if (finding.ahead > 0) return "unpushed-commits";
  return null;
}

function publicFinding(finding: InternalRepoFinding): NoCloudRepoFinding {
  const { policy_path: _policyPath, nested_parent_path: _nestedParentPath, ...publicFields } = finding;
  return publicFields;
}

function classifyRouting(findings: InternalRepoFinding[]): NoCloudRepoFinding[] {
  const byKey = new Map<string, InternalRepoFinding[]>();
  const unkeyed: InternalRepoFinding[] = [];

  for (const finding of findings) {
    if (!finding.repo_key) {
      unkeyed.push(finding);
      continue;
    }
    const group = byKey.get(finding.repo_key) ?? [];
    group.push(finding);
    byKey.set(finding.repo_key, group);
  }

  const routed: NoCloudRepoFinding[] = [];
  for (const finding of unkeyed) {
    routed.push(publicFinding({ ...finding, routing: "unkeyed", routeable: false, route_blocked_reason: "missing-github-remote" }));
  }

  for (const group of byKey.values()) {
    const canonical = [...group].sort((a, b) => {
      const aScore = canonicalScore(a);
      const bScore = canonicalScore(b);
      return aScore[0] - bScore[0]
        || aScore[1] - bScore[1]
        || aScore[2] - bScore[2]
        || aScore[3].localeCompare(bScore[3]);
    })[0];
    if (!canonical) continue;

    for (const finding of group) {
      const isCanonical = finding.path === canonical.path;
      const blockedReason = routeBlockedReason(finding, isCanonical);
      routed.push(publicFinding({
        ...finding,
        routing: isCanonical ? "canonical" : "duplicate",
        routeable: isCanonical && !blockedReason,
        route_blocked_reason: blockedReason,
        canonical_path: canonical.path,
        duplicate_of: isCanonical ? null : canonical.path,
      }));
    }
  }

  return routed;
}

function npmFinding(pkg: string): NoCloudNpmFinding {
  try {
    const raw = execFileSync("npm", ["view", pkg, "version", "dependencies", "optionalDependencies", "peerDependencies", "deprecated", "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    const data = JSON.parse(raw) as {
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      deprecated?: string;
    } | string;
    if (typeof data === "string") {
      return { package: pkg, version: data, cloud_dep: null, status: "published" };
    }
    const dep = data.dependencies?.[CLOUD_PACKAGE]
      ?? data.optionalDependencies?.[CLOUD_PACKAGE]
      ?? data.peerDependencies?.[CLOUD_PACKAGE]
      ?? null;
    if (pkg === CLOUD_PACKAGE) {
      return { package: pkg, version: data.version ?? null, cloud_dep: data.deprecated ?? "active", status: "cloud-package" };
    }
    return {
      package: pkg,
      version: data.version ?? null,
      cloud_dep: dep,
      status: dep ? "published-cloud-dep" : "published",
    };
  } catch (error) {
    return { package: pkg, version: null, cloud_dep: null, status: classifyNpmViewFailure(describeExecFailure(error)) };
  }
}

export function getNoCloudInventory(options: NoCloudInventoryOptions = {}): NoCloudInventoryReport {
  const root = resolve(options.root ?? process.cwd());
  const limit = cap(options.limit, DEFAULT_LIMIT, 10_000);
  const maxDepth = cap(options.maxDepth, DEFAULT_MAX_DEPTH, 32);
  const { roots, excluded } = collectGitRoots(root, maxDepth);
  const repoFindings = classifyRouting(
    roots.map((repoRoot) => repoFinding(repoRoot, root, nearestNestedParent(repoRoot, roots))),
  )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "needs-remediation" ? -1 : 1;
      if (a.routeable !== b.routeable) return a.routeable ? -1 : 1;
      if (a.files !== b.files) return b.files - a.files;
      return a.path.localeCompare(b.path);
    });
  // An explicit --npm-package list is the caller naming exactly what to check, so
  // it is used verbatim; otherwise both sources are unioned.
  const explicit = options.includeNpm ? options.npmPackages?.filter(Boolean) ?? [] : [];
  const inventory: NpmPackageInventory = !options.includeNpm
    ? { packages: [], from_local_manifests: 0, from_registry: null, registry_enumeration: "skipped", registry_enumeration_detail: null, registry_enumeration_sources: null }
    : explicit.length > 0
      ? { packages: [...explicit], from_local_manifests: 0, from_registry: null, registry_enumeration: "skipped", registry_enumeration_detail: null, registry_enumeration_sources: null }
      : resolveNpmPackageChecks(roots, { enumerate: options.enumerateScopedPackages });
  const npm = inventory.packages.map(npmFinding);
  const truncated = repoFindings.length > limit || npm.length > limit;
  const repos = repoFindings.slice(0, limit);
  const npmLimited = npm.slice(0, limit);

  return {
    kind: "no_cloud_inventory",
    schema_version: SCHEMA_VERSION,
    root: redactPath(root),
    patterns: [...CLOUD_PATTERNS],
    summary: {
      repos: repoFindings.length,
      needs_remediation: repoFindings.filter((repo) => repo.status === "needs-remediation").length,
      verify_clean: repoFindings.filter((repo) => repo.status === "verify-clean").length,
      routeable: repoFindings.filter((repo) => repo.routeable).length,
      duplicate_repos: repoFindings.filter((repo) => repo.routing === "duplicate").length,
      unkeyed_repos: repoFindings.filter((repo) => repo.routing === "unkeyed").length,
      dirty: repoFindings.filter((repo) => repo.dirty > 0).length,
      registry_packages: npm.length,
      registry_cloud_deps: npm.filter((entry) => entry.status === "published-cloud-dep").length,
      registry_unpublished: npm.filter((entry) => entry.status === "unpublished").length,
      registry_from_local_manifests: inventory.from_local_manifests,
      registry_from_registry: inventory.from_registry,
      registry_enumeration: inventory.registry_enumeration,
      registry_enumeration_detail: inventory.registry_enumeration_detail,
      registry_enumeration_sources: inventory.registry_enumeration_sources,
    },
    repos,
    npm: npmLimited,
    excluded,
    truncated,
  };
}
