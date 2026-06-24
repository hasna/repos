import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listRepos } from "../db/repos.js";
import type { Repo } from "../types/index.js";

export const GITHUB_REPO_CATALOG_SCHEMA_VERSION = "open-repos.github-catalog.v1" as const;

export interface GithubCatalogAccount {
  login: string;
  type: "User" | "Organization" | string;
  url: string | null;
}

export interface GithubRateLimitSnapshot {
  resource: "core";
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset_at: string | null;
  checked_at: string;
}

export interface GithubPackageHints {
  ecosystem: string | null;
  package_manager: string | null;
  package_name: string | null;
  package_scope: string | null;
  manifests: string[];
}

export interface GithubLocalStatus {
  path: string;
  matched_by: "remote" | "name";
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  staged: number;
  modified: number;
  untracked: number;
  head_sha: string | null;
  last_checked_at: string;
}

export interface GithubRepoCatalogRecord {
  account: string;
  account_type: "User" | "Organization" | string;
  org: string | null;
  name: string;
  full_name: string;
  default_branch: string | null;
  visibility: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  topics: string[];
  description: string | null;
  html_url: string | null;
  clone_urls: {
    https: string | null;
    ssh: string | null;
  };
  pushed_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  primary_language: string | null;
  package_hints: GithubPackageHints;
  local: GithubLocalStatus | null;
  loop: {
    labels: string[];
    tags: string[];
  };
  sync: {
    github_synced_at: string;
    local_checked_at: string | null;
    stale_at: string;
  };
}

export interface GithubRepoCatalogCache {
  schemaVersion: typeof GITHUB_REPO_CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  staleAt: string;
  completed: boolean;
  nextCursor: string | null;
  accounts: GithubCatalogAccount[];
  repositories: GithubRepoCatalogRecord[];
  rateLimit: GithubRateLimitSnapshot | null;
  warnings: string[];
}

export interface GithubRepoCatalogFilter {
  org?: string;
  repo?: string;
  language?: string;
  packageScope?: string;
  localPath?: string;
  tags?: string[];
  includeArchived?: boolean;
  includeDisabled?: boolean;
}

export interface GithubRepoCatalogEnvelope {
  schemaVersion: typeof GITHUB_REPO_CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  source: {
    cachePath: string;
    cacheExists: boolean;
    cacheSyncedAt: string | null;
    staleAt: string | null;
    stale: boolean;
    completed: boolean;
    nextCursor: string | null;
  };
  query: GithubRepoCatalogFilter & {
    limit: number;
    offset: number;
  };
  page: {
    limit: number;
    offset: number;
    count: number;
    total: number;
    nextOffset: number | null;
  };
  accounts: GithubCatalogAccount[];
  rateLimit: GithubRateLimitSnapshot | null;
  warnings: string[];
  repositories: GithubRepoCatalogRecord[];
}

export interface SyncGithubRepoCatalogOptions {
  cachePath?: string;
  cursor?: string;
  maxPages?: number;
  pageSize?: number;
  resume?: boolean;
  staleMs?: number;
  minRemaining?: number;
  includeLocal?: boolean;
  now?: Date;
  localRepos?: Repo[];
  requestJson?: (endpoint: string) => unknown;
  git?: (repoPath: string, args: string[]) => string;
}

export interface EnumerateGithubRepoCatalogOptions {
  cachePath?: string;
  sync?: boolean;
  resume?: boolean;
  cursor?: string;
  maxPages?: number;
  pageSize?: number;
  staleMs?: number;
  minRemaining?: number;
  includeLocal?: boolean;
  limit?: number;
  offset?: number;
  filter?: GithubRepoCatalogFilter;
  now?: Date;
  localRepos?: Repo[];
  requestJson?: (endpoint: string) => unknown;
  git?: (repoPath: string, args: string[]) => string;
}

interface GithubApiOwner {
  login?: unknown;
  type?: unknown;
  html_url?: unknown;
}

interface GithubApiRepo {
  owner?: GithubApiOwner;
  name?: unknown;
  full_name?: unknown;
  default_branch?: unknown;
  visibility?: unknown;
  private?: unknown;
  archived?: unknown;
  disabled?: unknown;
  fork?: unknown;
  topics?: unknown;
  description?: unknown;
  html_url?: unknown;
  clone_url?: unknown;
  ssh_url?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  language?: unknown;
}

interface LocalRepoIndex {
  byFullName: Map<string, Repo>;
  byName: Map<string, Repo[]>;
}

const DEFAULT_STALE_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LIMIT = 100;

export function getDefaultGithubCatalogCachePath(homeDir = homedir()): string {
  return process.env["HASNA_REPOS_GITHUB_CACHE_PATH"] || join(homeDir, ".hasna", "repos", "github-catalog.json");
}

export function loadGithubRepoCatalog(cachePath = getDefaultGithubCatalogCachePath()): GithubRepoCatalogCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as GithubRepoCatalogCache;
    if (parsed.schemaVersion !== GITHUB_REPO_CATALOG_SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.repositories)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function syncGithubRepoCatalog(opts: SyncGithubRepoCatalogOptions = {}): GithubRepoCatalogCache {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const staleAt = new Date(now.getTime() + staleMs).toISOString();
  const cachePath = opts.cachePath ?? getDefaultGithubCatalogCachePath();
  const pageSize = clampPositiveInt(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1, 100);
  const maxPages = opts.maxPages === undefined ? Number.POSITIVE_INFINITY : clampPositiveInt(opts.maxPages, 1);
  const requestJson = opts.requestJson ?? ghApiJson;
  const existing = loadGithubRepoCatalog(cachePath);
  const warnings: string[] = [];

  if (opts.resume && existing?.completed && !opts.cursor && existing.nextCursor === null) {
    const refreshed = opts.includeLocal === false
      ? existing
      : {
          ...existing,
          repositories: refreshLocalStatuses(existing.repositories, opts.localRepos ?? safeListLocalRepos(), nowIso, opts.git),
        };
    return refreshed;
  }

  const minRemaining = opts.minRemaining ?? 1;
  const rateLimit = readRateLimit(requestJson, nowIso, warnings);
  const plannedRepoPages = Number.isFinite(maxPages) ? maxPages : 1;
  const minimumUsefulCalls = 2 + plannedRepoPages;
  if (!hasRateLimitBudget(rateLimit, 0, minimumUsefulCalls, minRemaining)) {
    return useRateLimitFallback(existing, cachePath, rateLimit, minRemaining, minimumUsefulCalls);
  }

  let estimatedCalls = 0;
  const guardedRequestJson = (endpoint: string): unknown => {
    if (!hasRateLimitBudget(rateLimit, estimatedCalls, 1, minRemaining)) {
      throw new Error(`GitHub core rate limit budget would fall below safety floor (${minRemaining}) before ${endpoint}.`);
    }
    const result = requestJson(endpoint);
    estimatedCalls++;
    return result;
  };

  const accounts = discoverAccounts(guardedRequestJson, warnings);
  const localRepos = opts.includeLocal === false ? [] : opts.localRepos ?? safeListLocalRepos();
  const localIndex = buildLocalRepoIndex(localRepos);
  const recordsByFullName = new Map<string, GithubRepoCatalogRecord>();

  if (opts.resume && existing) {
    for (const record of existing.repositories) {
      recordsByFullName.set(record.full_name.toLowerCase(), record);
    }
  }

  let page = parseCursor(opts.cursor ?? (opts.resume ? existing?.nextCursor : null)) ?? 1;
  let pagesRead = 0;
  let completed = false;
  let nextCursor: string | null = String(page);

  while (pagesRead < maxPages) {
    if (!hasRateLimitBudget(rateLimit, estimatedCalls, 1, minRemaining)) {
      warnings.push(`Stopped GitHub catalog sync before page ${page} to preserve rate-limit safety floor (${minRemaining}).`);
      nextCursor = String(page);
      break;
    }
    const repos = guardedRequestJson(`/user/repos?per_page=${pageSize}&page=${page}&affiliation=owner,collaborator,organization_member&sort=pushed`);
    if (!Array.isArray(repos)) {
      throw new Error("GitHub /user/repos returned a non-array response.");
    }

    for (const repo of repos) {
      const normalized = normalizeGithubRepo(repo as GithubApiRepo, localIndex, nowIso, staleAt, opts.git);
      if (normalized) recordsByFullName.set(normalized.full_name.toLowerCase(), normalized);
    }

    pagesRead++;
    if (repos.length < pageSize) {
      completed = true;
      nextCursor = null;
      break;
    }

    page++;
    nextCursor = String(page);

    const partial = buildCache(nowIso, staleAt, completed, nextCursor, accounts, recordsByFullName, adjustRateLimit(rateLimit, estimatedCalls), warnings);
    writeGithubRepoCatalogCache(cachePath, partial);
  }

  const cache = buildCache(nowIso, staleAt, completed, nextCursor, accounts, recordsByFullName, adjustRateLimit(rateLimit, estimatedCalls), warnings);
  writeGithubRepoCatalogCache(cachePath, cache);
  return cache;
}

export function enumerateGithubRepoCatalog(opts: EnumerateGithubRepoCatalogOptions = {}): GithubRepoCatalogEnvelope {
  const cachePath = opts.cachePath ?? getDefaultGithubCatalogCachePath();
  const now = opts.now ?? new Date();
  const limit = clampPositiveInt(opts.limit ?? DEFAULT_LIMIT, 1);
  const offset = clampPositiveInt(opts.offset ?? 0, 0);
  const filter = opts.filter ?? {};
  const warnings: string[] = [];
  let missingCache = false;
  let cache = opts.sync
    ? syncGithubRepoCatalog({
        cachePath,
        cursor: opts.cursor,
        maxPages: opts.maxPages,
        pageSize: opts.pageSize,
        resume: opts.resume,
        staleMs: opts.staleMs,
        minRemaining: opts.minRemaining,
        includeLocal: opts.includeLocal,
        now,
        localRepos: opts.localRepos,
        requestJson: opts.requestJson,
        git: opts.git,
      })
    : loadGithubRepoCatalog(cachePath);

  if (!cache) {
    missingCache = true;
    warnings.push("No github-catalog cache found. Run `repos gh-catalog --sync --json` to populate it.");
    cache = emptyCache(now, opts.staleMs ?? DEFAULT_STALE_MS);
  } else if (opts.includeLocal !== false) {
    cache = {
      ...cache,
      repositories: refreshLocalStatuses(cache.repositories, opts.localRepos ?? safeListLocalRepos(), now.toISOString(), opts.git),
    };
  }

  const stale = missingCache || (cache.staleAt ? Date.parse(cache.staleAt) <= now.getTime() : true);
  if (stale && cache.repositories.length > 0) {
    warnings.push(`github-catalog cache is stale as of ${cache.staleAt}.`);
  }

  const filtered = applyGithubCatalogFilter(cache.repositories, filter);
  const repositories = filtered.slice(offset, offset + limit);
  const nextOffset = offset + repositories.length < filtered.length ? offset + repositories.length : null;

  return {
    schemaVersion: GITHUB_REPO_CATALOG_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    source: {
      cachePath,
      cacheExists: existsSync(cachePath),
      cacheSyncedAt: missingCache ? null : cache.generatedAt,
      staleAt: missingCache ? null : cache.staleAt,
      stale,
      completed: cache.completed,
      nextCursor: cache.nextCursor,
    },
    query: { ...filter, limit, offset },
    page: {
      limit,
      offset,
      count: repositories.length,
      total: filtered.length,
      nextOffset,
    },
    accounts: cache.accounts,
    rateLimit: cache.rateLimit,
    warnings: [...cache.warnings, ...warnings],
    repositories,
  };
}

export function* iterateGithubRepoCatalog(opts: Omit<EnumerateGithubRepoCatalogOptions, "limit" | "offset"> = {}): Generator<GithubRepoCatalogRecord> {
  let offset = 0;
  const limit = 100;
  while (true) {
    const page = enumerateGithubRepoCatalog({ ...opts, sync: offset === 0 ? opts.sync : false, limit, offset });
    for (const repo of page.repositories) yield repo;
    if (page.page.nextOffset === null) return;
    offset = page.page.nextOffset;
  }
}

export function applyGithubCatalogFilter(
  repositories: GithubRepoCatalogRecord[],
  filter: GithubRepoCatalogFilter = {},
): GithubRepoCatalogRecord[] {
  const org = normalizeComparable(filter.org);
  const repo = normalizeComparable(filter.repo);
  const language = normalizeComparable(filter.language);
  const packageScope = normalizeScope(filter.packageScope);
  const tags = (filter.tags ?? []).map(normalizeComparable).filter((tag): tag is string => Boolean(tag));
  const localPath = filter.localPath ? resolve(filter.localPath) : null;

  return repositories.filter((record) => {
    if (!filter.includeArchived && record.archived) return false;
    if (!filter.includeDisabled && record.disabled) return false;
    if (org && normalizeComparable(record.org ?? record.account) !== org) return false;
    if (repo) {
      const name = normalizeComparable(record.name);
      const fullName = normalizeComparable(record.full_name);
      if (name !== repo && fullName !== repo) return false;
    }
    if (language && normalizeComparable(record.primary_language) !== language) return false;
    if (packageScope && normalizeScope(record.package_hints.package_scope) !== packageScope) return false;
    if (localPath) {
      const recordPath = record.local?.path ? resolve(record.local.path) : null;
      if (!recordPath || (recordPath !== localPath && !recordPath.startsWith(`${localPath}/`))) return false;
    }
    if (tags.length > 0) {
      const recordTags = new Set([...record.topics, ...record.loop.tags, ...record.loop.labels].map(normalizeComparable));
      for (const tag of tags) {
        if (!recordTags.has(tag)) return false;
      }
    }
    return true;
  });
}

export function extractGithubFullNameFromRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scp = trimmed.match(/^(?:[^@]+@)?github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/i);
  if (scp) return normalizeFullNameParts(scp[1], scp[2]);

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    return normalizeFullNameParts(parts[0], parts[1]);
  } catch {
    const generic = trimmed.match(/github\.com[:/]([^/\s]+)\/(.+?)(?:\.git)?(?:[?#].*)?$/i);
    if (!generic) return null;
    return normalizeFullNameParts(generic[1], generic[2]);
  }
}

function ghApiJson(endpoint: string): unknown {
  const output = execFileSync("gh", ["api", endpoint], {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return output ? JSON.parse(output) : null;
}

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function readRateLimit(
  requestJson: (endpoint: string) => unknown,
  checkedAt: string,
  warnings: string[],
): GithubRateLimitSnapshot | null {
  try {
    const data = requestJson("rate_limit") as Record<string, unknown> | null;
    const resources = data?.["resources"] as Record<string, unknown> | undefined;
    const core = (resources?.["core"] ?? data?.["rate"]) as Record<string, unknown> | undefined;
    if (!core) return null;
    return {
      resource: "core",
      limit: numberOrNull(core["limit"]),
      remaining: numberOrNull(core["remaining"]),
      used: numberOrNull(core["used"]),
      reset_at: resetToIso(core["reset"]),
      checked_at: checkedAt,
    };
  } catch {
    warnings.push("Unable to read GitHub rate limit status before catalog sync.");
    return null;
  }
}

function discoverAccounts(requestJson: (endpoint: string) => unknown, warnings: string[]): GithubCatalogAccount[] {
  const byLogin = new Map<string, GithubCatalogAccount>();
  try {
    const user = requestJson("user") as Record<string, unknown> | null;
    const login = stringOrNull(user?.["login"]);
    if (login) {
      byLogin.set(login.toLowerCase(), {
        login,
        type: stringOrNull(user?.["type"]) ?? "User",
        url: stringOrNull(user?.["html_url"]),
      });
    }
  } catch {
    warnings.push("Unable to read authenticated GitHub user while building catalog accounts.");
  }

  try {
    let page = 1;
    while (true) {
      const orgs = requestJson(`/user/orgs?per_page=100&page=${page}`) as unknown;
      if (!Array.isArray(orgs)) break;
      for (const org of orgs) {
        const row = org as Record<string, unknown>;
        const login = stringOrNull(row["login"]);
        if (!login) continue;
        byLogin.set(login.toLowerCase(), {
          login,
          type: "Organization",
          url: stringOrNull(row["html_url"]),
        });
      }
      if (orgs.length < 100) break;
      page++;
    }
  } catch {
    warnings.push("Unable to read GitHub organizations while building catalog accounts.");
  }

  return Array.from(byLogin.values()).sort((a, b) => a.login.localeCompare(b.login));
}

function normalizeGithubRepo(
  repo: GithubApiRepo,
  localIndex: LocalRepoIndex,
  syncedAt: string,
  staleAt: string,
  gitRunner = git,
): GithubRepoCatalogRecord | null {
  const fullName = stringOrNull(repo.full_name);
  const name = stringOrNull(repo.name);
  const ownerLogin = stringOrNull(repo.owner?.login);
  if (!fullName || !name || !ownerLogin) return null;

  const ownerType = stringOrNull(repo.owner?.type) ?? "User";
  const localMatch = findLocalRepo(fullName, name, localIndex);
  const packageHints = localMatch ? detectPackageHints(localMatch.repo.path) : emptyPackageHints();
  const local = localMatch ? readLocalStatus(localMatch.repo.path, localMatch.matchedBy, syncedAt, gitRunner) : null;
  const topics = normalizeStringArray(repo.topics);
  const primaryLanguage = stringOrNull(repo.language);
  const visibility = stringOrNull(repo.visibility) ?? (Boolean(repo.private) ? "private" : "public");
  const archived = Boolean(repo.archived);
  const disabled = Boolean(repo.disabled);
  const fork = Boolean(repo.fork);
  const tags = buildLoopTags({ topics, primaryLanguage, packageHints, visibility, archived, disabled, fork, local });

  return {
    account: ownerLogin,
    account_type: ownerType,
    org: ownerType === "Organization" ? ownerLogin : null,
    name,
    full_name: fullName,
    default_branch: stringOrNull(repo.default_branch),
    visibility,
    private: Boolean(repo.private),
    archived,
    disabled,
    fork,
    topics,
    description: stringOrNull(repo.description),
    html_url: sanitizeCloneUrl(stringOrNull(repo.html_url)),
    clone_urls: {
      https: sanitizeCloneUrl(stringOrNull(repo.clone_url)),
      ssh: sanitizeCloneUrl(stringOrNull(repo.ssh_url)),
    },
    pushed_at: stringOrNull(repo.pushed_at),
    updated_at: stringOrNull(repo.updated_at),
    created_at: stringOrNull(repo.created_at),
    primary_language: primaryLanguage,
    package_hints: packageHints,
    local,
    loop: {
      labels: topics,
      tags,
    },
    sync: {
      github_synced_at: syncedAt,
      local_checked_at: local?.last_checked_at ?? null,
      stale_at: staleAt,
    },
  };
}

function refreshLocalStatuses(
  records: GithubRepoCatalogRecord[],
  localRepos: Repo[],
  checkedAt: string,
  gitRunner = git,
): GithubRepoCatalogRecord[] {
  const index = buildLocalRepoIndex(localRepos);
  return records.map((record) => {
    const match = findLocalRepo(record.full_name, record.name, index);
    if (!match) return { ...record, local: null, package_hints: emptyPackageHints() };
    const packageHints = detectPackageHints(match.repo.path);
    const local = readLocalStatus(match.repo.path, match.matchedBy, checkedAt, gitRunner);
    const tags = buildLoopTags({
      topics: record.topics,
      primaryLanguage: record.primary_language,
      packageHints,
      visibility: record.visibility,
      archived: record.archived,
      disabled: record.disabled,
      fork: record.fork,
      local,
    });
    return {
      ...record,
      package_hints: packageHints,
      local,
      loop: {
        labels: record.topics,
        tags,
      },
      sync: {
        ...record.sync,
        local_checked_at: local.last_checked_at,
      },
    };
  });
}

function buildLocalRepoIndex(localRepos: Repo[]): LocalRepoIndex {
  const byFullName = new Map<string, Repo>();
  const byName = new Map<string, Repo[]>();

  for (const repo of localRepos) {
    const fullName = extractGithubFullNameFromRemote(repo.remote_url);
    if (fullName) byFullName.set(fullName.toLowerCase(), repo);
    const existing = byName.get(repo.name.toLowerCase()) ?? [];
    existing.push(repo);
    byName.set(repo.name.toLowerCase(), existing);
  }

  return { byFullName, byName };
}

function findLocalRepo(
  fullName: string,
  name: string,
  index: LocalRepoIndex,
): { repo: Repo; matchedBy: "remote" | "name" } | null {
  const byRemote = index.byFullName.get(fullName.toLowerCase());
  if (byRemote) return { repo: byRemote, matchedBy: "remote" };

  const byName = index.byName.get(name.toLowerCase()) ?? [];
  if (byName.length === 1) return { repo: byName[0]!, matchedBy: "name" };
  return null;
}

function readLocalStatus(
  repoPath: string,
  matchedBy: "remote" | "name",
  checkedAt: string,
  gitRunner: (repoPath: string, args: string[]) => string,
): GithubLocalStatus {
  const branch = gitRunner(repoPath, ["symbolic-ref", "--short", "HEAD"]) || null;
  const upstream = gitRunner(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || null;
  const revList = upstream ? gitRunner(repoPath, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]) : "";
  const counts = parseAheadBehind(revList);
  const statusLines = gitRunner(repoPath, ["status", "--porcelain=v1"]).split("\n").filter(Boolean);
  const headSha = gitRunner(repoPath, ["rev-parse", "HEAD"]) || null;
  const statusCounts = countGitStatus(statusLines);

  return {
    path: repoPath,
    matched_by: matchedBy,
    branch,
    upstream,
    ahead: upstream ? counts.ahead : null,
    behind: upstream ? counts.behind : null,
    dirty: statusLines.length > 0,
    staged: statusCounts.staged,
    modified: statusCounts.modified,
    untracked: statusCounts.untracked,
    head_sha: headSha,
    last_checked_at: checkedAt,
  };
}

function detectPackageHints(repoPath: string): GithubPackageHints {
  const manifests: string[] = [];
  let ecosystem: string | null = null;
  let packageManager: string | null = null;
  let packageName: string | null = null;
  let packageScope: string | null = null;

  const packageJsonPath = join(repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    manifests.push("package.json");
    ecosystem = "node";
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
      packageName = stringOrNull(parsed["name"]);
      packageScope = scopeFromPackageName(packageName);
      packageManager = stringOrNull(parsed["packageManager"]);
    } catch {
      packageManager = packageManager ?? "node";
    }
  }

  const manifestChecks: Array<[string, string, string]> = [
    ["bun.lock", "node", "bun"],
    ["pnpm-lock.yaml", "node", "pnpm"],
    ["yarn.lock", "node", "yarn"],
    ["package-lock.json", "node", "npm"],
    ["deno.json", "deno", "deno"],
    ["Cargo.toml", "rust", "cargo"],
    ["pyproject.toml", "python", "python"],
    ["go.mod", "go", "go"],
    ["pom.xml", "java", "maven"],
    ["build.gradle", "java", "gradle"],
    ["composer.json", "php", "composer"],
    ["Gemfile", "ruby", "bundler"],
  ];

  for (const [manifest, manifestEcosystem, manager] of manifestChecks) {
    if (!existsSync(join(repoPath, manifest))) continue;
    if (!manifests.includes(manifest)) manifests.push(manifest);
    ecosystem = ecosystem ?? manifestEcosystem;
    packageManager = packageManager ?? manager;
  }

  if (!packageName && existsSync(join(repoPath, "go.mod"))) {
    packageName = readFirstMatch(join(repoPath, "go.mod"), /^module\s+(.+)$/m);
  }
  if (!packageName && existsSync(join(repoPath, "Cargo.toml"))) {
    packageName = readFirstMatch(join(repoPath, "Cargo.toml"), /^name\s*=\s*"([^"]+)"/m);
  }
  if (!packageName && existsSync(join(repoPath, "pyproject.toml"))) {
    packageName = readFirstMatch(join(repoPath, "pyproject.toml"), /^name\s*=\s*"([^"]+)"/m);
  }

  return {
    ecosystem,
    package_manager: packageManager,
    package_name: packageName,
    package_scope: packageScope,
    manifests,
  };
}

function buildLoopTags(input: {
  topics: string[];
  primaryLanguage: string | null;
  packageHints: GithubPackageHints;
  visibility: string;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  local: GithubLocalStatus | null;
}): string[] {
  const tags = new Set<string>();
  for (const topic of input.topics) tags.add(slug(topic));
  if (input.primaryLanguage) tags.add(`language:${slug(input.primaryLanguage)}`);
  if (input.packageHints.ecosystem) tags.add(`ecosystem:${slug(input.packageHints.ecosystem)}`);
  if (input.packageHints.package_scope) tags.add(`scope:${slug(input.packageHints.package_scope)}`);
  if (input.visibility) tags.add(`visibility:${slug(input.visibility)}`);
  if (input.archived) tags.add("state:archived");
  if (input.disabled) tags.add("state:disabled");
  if (input.fork) tags.add("type:fork");
  if (input.local) tags.add("local");
  if (input.local?.dirty) tags.add("local:dirty");
  return Array.from(tags).sort();
}

function writeGithubRepoCatalogCache(cachePath: string, cache: GithubRepoCatalogCache): void {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, cachePath);
}

function useRateLimitFallback(
  existing: GithubRepoCatalogCache | null,
  cachePath: string,
  rateLimit: GithubRateLimitSnapshot | null,
  minRemaining: number,
  plannedCalls: number,
): GithubRepoCatalogCache {
  const remaining = rateLimit?.remaining ?? null;
  const warning = remaining === null
    ? `GitHub core rate limit could not be verified before spending ${plannedCalls} planned call(s).`
    : `GitHub core rate limit remaining (${remaining}) cannot preserve safety floor (${minRemaining}) for ${plannedCalls} planned call(s).`;
  if (existing) {
    const preserved = { ...existing, rateLimit, warnings: appendWarning(existing.warnings, warning) };
    writeGithubRepoCatalogCache(cachePath, preserved);
    return preserved;
  }
  throw new Error(`${warning} No usable github-catalog cache exists.`);
}

function hasRateLimitBudget(
  rateLimit: GithubRateLimitSnapshot | null,
  estimatedCallsSpent: number,
  plannedCalls: number,
  minRemaining: number,
): boolean {
  if (!rateLimit || rateLimit.remaining === null) return true;
  return rateLimit.remaining - estimatedCallsSpent - plannedCalls >= minRemaining;
}

function adjustRateLimit(
  rateLimit: GithubRateLimitSnapshot | null,
  estimatedCallsSpent: number,
): GithubRateLimitSnapshot | null {
  if (!rateLimit || rateLimit.remaining === null) return rateLimit;
  return {
    ...rateLimit,
    remaining: Math.max(0, rateLimit.remaining - estimatedCallsSpent),
    used: rateLimit.used === null ? null : rateLimit.used + estimatedCallsSpent,
  };
}

function buildCache(
  generatedAt: string,
  staleAt: string,
  completed: boolean,
  nextCursor: string | null,
  accounts: GithubCatalogAccount[],
  recordsByFullName: Map<string, GithubRepoCatalogRecord>,
  rateLimit: GithubRateLimitSnapshot | null,
  warnings: string[],
): GithubRepoCatalogCache {
  return {
    schemaVersion: GITHUB_REPO_CATALOG_SCHEMA_VERSION,
    generatedAt,
    staleAt,
    completed,
    nextCursor,
    accounts,
    repositories: Array.from(recordsByFullName.values()).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    rateLimit,
    warnings,
  };
}

function emptyCache(now: Date, staleMs: number): GithubRepoCatalogCache {
  const generatedAt = now.toISOString();
  return {
    schemaVersion: GITHUB_REPO_CATALOG_SCHEMA_VERSION,
    generatedAt,
    staleAt: new Date(now.getTime() + staleMs).toISOString(),
    completed: false,
    nextCursor: null,
    accounts: [],
    repositories: [],
    rateLimit: null,
    warnings: [],
  };
}

function safeListLocalRepos(): Repo[] {
  try {
    return listRepos({ limit: 100_000, offset: 0 });
  } catch {
    return [];
  }
}

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const parts = output.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(parts[0] ?? "0", 10) || 0,
    behind: Number.parseInt(parts[1] ?? "0", 10) || 0,
  };
}

function countGitStatus(lines: string[]): { staged: number; modified: number; untracked: number } {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    if (line[0] && line[0] !== " ") staged++;
    if (line[1] && line[1] !== " ") modified++;
  }
  return { staged, modified, untracked };
}

function sanitizeCloneUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    if (/github\.com[:/][^/\s]+\/[^/\s]+/i.test(value) && !/[A-Za-z0-9_]{20,}@/.test(value)) {
      return value;
    }
    return null;
  }
}

function normalizeFullNameParts(owner: string | undefined, repo: string | undefined): string | null {
  if (!owner || !repo) return null;
  const normalizedRepo = repo.replace(/\.git$/i, "").replace(/[?#].*$/, "");
  if (!normalizedRepo) return null;
  return `${owner}/${normalizedRepo}`;
}

function readFirstMatch(path: string, pattern: RegExp): string | null {
  try {
    const match = readFileSync(path, "utf-8").match(pattern);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function emptyPackageHints(): GithubPackageHints {
  return {
    ecosystem: null,
    package_manager: null,
    package_name: null,
    package_scope: null,
    manifests: [],
  };
}

function scopeFromPackageName(packageName: string | null): string | null {
  if (!packageName?.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  return slash > 1 ? packageName.slice(0, slash) : null;
}

function normalizeScope(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? (trimmed.startsWith("@") ? trimmed : `@${trimmed}`) : null;
}

function normalizeComparable(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringOrNull(item)).filter((item): item is string => Boolean(item));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resetToIso(value: unknown): string | null {
  const reset = numberOrNull(value);
  return reset === null ? null : new Date(reset * 1000).toISOString();
}

function parseCursor(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampPositiveInt(value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function appendWarning(warnings: string[], warning: string): string[] {
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
}
