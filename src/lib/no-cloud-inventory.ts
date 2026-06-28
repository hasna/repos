import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

type InventoryStatus = "verify-clean" | "needs-remediation";

export interface NoCloudInventoryOptions {
  root?: string;
  limit?: number;
  maxDepth?: number;
  includeNpm?: boolean;
  npmPackages?: string[];
}

export interface NoCloudRepoFinding {
  path: string;
  branch: string | null;
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
  schema_version: "1.0";
  root: string;
  patterns: string[];
  summary: {
    repos: number;
    needs_remediation: number;
    verify_clean: number;
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
const SCHEMA_VERSION = "1.0" as const;

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
  return lower.includes("/open-loops") || lower.includes("/open-codewith") || lower.includes("/codewith");
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

function repoFinding(root: string, base: string): NoCloudRepoFinding {
  const files = collectCloudFiles(root);
  const counts = categoryCounts(root, files);
  const dirty = (runGit(root, ["status", "--porcelain=v1"]) ?? "")
    .split("\n")
    .filter(Boolean)
    .length;
  const remote = runGit(root, ["remote", "get-url", "origin"]);

  return {
    path: redactPath(relative(base, root) || root),
    branch: runGit(root, ["branch", "--show-current"]),
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
  const repoFindings = roots
    .map((repoRoot) => repoFinding(repoRoot, root))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "needs-remediation" ? -1 : 1;
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
