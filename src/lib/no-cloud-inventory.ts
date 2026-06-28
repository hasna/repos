import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

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
  status: "published" | "published-cloud-dep" | "cloud-package" | "npm-view-failed";
}

export interface NoCloudInventoryReport {
  kind: "no_cloud_inventory";
  schema_version: "1.2";
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
const SCHEMA_VERSION = "1.2" as const;

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

const DEFAULT_PACKAGE_CHECKS = [
  CLOUD_PACKAGE,
  "@hasna/connectors",
  "@hasna/secrets",
  "@hasna/repos",
  "@hasna/shortlinks",
  "@hasna/todos",
  "@hasna/terminal",
  "@hasna/sessions",
  "@hasna/brains",
  "@hasna/contacts",
  "@hasna/wallets",
  "@hasna/configs",
  "@hasna/context",
  "@hasna/telephony",
  "@hasna/swarm",
  "@hasna/tickets",
  "@hasna/signatures",
  "@hasna/hooks",
  "@hasna/trademarks",
  "@hasna/sandboxes",
  "@hasna/styles",
  "@hasna/mcps",
  "@hasna/testers",
  "@hasna/prompts",
  "@hasna/servers",
  "@hasna/deployment",
  "@hasna/implementations",
  "@hasna/analytics",
  "@hasna/predictor",
  "@hasna/transcriber",
  "@hasna/crm",
  "@hasna/scaffolds",
  "@hasna/assistants-mcp",
  "@hasna/assistants",
  "@hasna/evals",
  "@hasna/markdown",
  "@hasna/researcher",
  "@hasna/coders",
  "@hasna/calendar",
];

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
  if (!remote) return null;
  const trimmed = remote.trim();
  const scpLike = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (scpLike?.[1] && scpLike[2] && isSafeRepoSegment(scpLike[1]) && isSafeRepoSegment(scpLike[2].replace(/\.git$/, ""))) {
    return `${scpLike[1].toLowerCase()}/${scpLike[2].toLowerCase().replace(/\.git$/, "")}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    const owner = parts[0];
    const repo = parts[1];
    const repoName = repo?.replace(/\.git$/, "");
    if (!owner || !repoName || parts.length !== 2 || !isSafeRepoSegment(owner) || !isSafeRepoSegment(repoName)) return null;
    return `${owner.toLowerCase()}/${repoName.toLowerCase()}`;
  } catch {
    return null;
  }
}

function isSafeRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
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

function nearestAncestorGitRoot(root: string): string | null {
  let current = dirname(root);
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
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
    remote: remote ? redactText(remote) : null,
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
      stdio: ["ignore", "pipe", "ignore"],
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
  } catch {
    return { package: pkg, version: null, cloud_dep: null, status: "npm-view-failed" };
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
  const npmPackages = options.includeNpm
    ? (options.npmPackages?.length ? options.npmPackages : DEFAULT_PACKAGE_CHECKS)
    : [];
  const npm = npmPackages.map(npmFinding);
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
    },
    repos,
    npm: npmLimited,
    excluded,
    truncated,
  };
}
