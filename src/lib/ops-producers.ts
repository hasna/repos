import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getDb } from "../db/database.js";
import { syncAllGithubPRs, syncGithubPRs } from "./github.js";
import type { PullRequest } from "../types/index.js";

export interface TaskSeed {
  fingerprint: string;
  title: string;
  body: string;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface RepoPrQueueItem {
  repo: {
    id: number;
    name: string;
    full_name: string;
    org: string | null;
    path: string;
  };
  pr: {
    number: number;
    title: string;
    state: PullRequest["state"];
    author: string;
    url: string | null;
    base_branch: string | null;
    head_branch: string | null;
    updated_at: string | null;
    changed_files: number;
    additions: number;
    deletions: number;
  };
  task_seed: TaskSeed;
}

export interface RepoPrQueueResult {
  schema: "open-repos.pr-queue.v1";
  generated_at: string;
  synced?: {
    repos_seen: number;
    repos_checked: number;
    repos_synced: number;
    total_synced: number;
    truncated: boolean;
    errors: string[];
  };
  filters: {
    org?: string;
    repo?: string;
    state: string;
    limit: number;
  };
  summary: {
    items: number;
    task_seeds: number;
  };
  task_suggestions: TaskSeed[];
  items: RepoPrQueueItem[];
}

export interface PrQueueOptions {
  sync?: boolean;
  syncOrgs?: string[];
  syncMaxRepos?: number;
  org?: string;
  repo?: string;
  state?: string;
  limit?: number;
}

interface PrRow extends PullRequest {
  repo_name: string;
  repo_org: string | null;
  repo_path: string;
  repo_remote_url: string | null;
}

export function buildPrQueue(options: PrQueueOptions = {}): RepoPrQueueResult {
  const limit = normalizePositiveInteger(options.limit, 100);
  const state = options.state ?? "open";
  let synced: RepoPrQueueResult["synced"];

  if (options.sync) {
    if (options.repo) {
      const result = syncGithubPRs(options.repo, { limit, state });
      synced = { repos_seen: 1, repos_checked: 1, repos_synced: 1, total_synced: result.synced, truncated: false, errors: [] };
    } else if (options.syncOrgs?.length) {
      synced = { repos_seen: 0, repos_checked: 0, repos_synced: 0, total_synced: 0, truncated: false, errors: [] };
      let remainingRepos = normalizePositiveInteger(options.syncMaxRepos, 0);
      for (const org of options.syncOrgs) {
        if (options.syncMaxRepos && remainingRepos <= 0) {
          synced.truncated = true;
          break;
        }
        const result = syncAllGithubPRs({
          org,
          limit,
          state,
          ...(options.syncMaxRepos ? { maxRepos: remainingRepos } : {}),
        });
        synced.repos_seen += result.repos_seen;
        synced.repos_checked += result.repos_checked;
        synced.repos_synced += result.repos_synced;
        synced.total_synced += result.total_synced;
        synced.truncated = synced.truncated || result.truncated;
        synced.errors.push(...result.errors.map((error) => `${org}: ${error}`));
        remainingRepos -= result.repos_checked;
      }
    } else {
      synced = syncAllGithubPRs({ org: options.org, limit, state, maxRepos: options.syncMaxRepos });
    }
  }

  const rows = listPrRows({ org: options.org, repo: options.repo, state, limit });
  const items = rows.map(prRowToQueueItem);
  return {
    schema: "open-repos.pr-queue.v1",
    generated_at: new Date().toISOString(),
    ...(synced ? { synced } : {}),
    filters: {
      ...(options.org ? { org: options.org } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      state,
      limit,
    },
    summary: {
      items: items.length,
      task_seeds: items.length,
    },
    task_suggestions: items.map((item) => item.task_seed),
    items,
  };
}

export interface CliSmokeCommandSpec {
  command: string;
  args: string[];
}

export interface CliSmokeOptions {
  commands?: string[];
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface CliSmokeResult {
  schema: "open-repos.global-cli-smoke.v1";
  generated_at: string;
  limits: {
    timeout_ms: number;
  };
  summary: {
    checked: number;
    ok: number;
    failed: number;
    missing: number;
  };
  task_suggestions: TaskSeed[];
  commands: Array<{
    command: string;
    args: string[];
    status: "ok" | "failed" | "missing";
    exit_code: number | null;
    stdout_preview: string;
    stderr_preview: string;
    task_seed?: TaskSeed;
  }>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
) => { status: number | null; stdout: string; stderr: string; error?: { code?: string; message: string } };

const DEFAULT_CLI_SMOKE_COMMANDS: CliSmokeCommandSpec[] = [
  { command: "loops", args: ["--version"] },
  { command: "loops-daemon", args: ["--version"] },
  { command: "codewith", args: ["--version"] },
  { command: "claude", args: ["--version"] },
  { command: "cursor", args: ["agent", "--version"] },
  { command: "opencode", args: ["--version"] },
  { command: "codex", args: ["--version"] },
  { command: "accounts", args: ["--help"] },
  { command: "machines", args: ["--help"] },
  { command: "knowledge", args: ["--help"] },
  { command: "notes", args: ["--help"] },
  { command: "todos", args: ["--help"] },
  { command: "secrets", args: ["--help"] },
  { command: "files", args: ["--version"] },
  { command: "mailery", args: ["--help"] },
  { command: "calendar", args: ["--help"] },
  { command: "contacts", args: ["--help"] },
  { command: "economy", args: ["--version"] },
  { command: "dispatch", args: ["--help"] },
  { command: "repos", args: ["--version"] },
  { command: "gh", args: ["--version"] },
  { command: "bun", args: ["--version"] },
];

export function runGlobalCliSmoke(options: CliSmokeOptions = {}): CliSmokeResult {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const runner = options.runner ?? spawnCommand;
  const commandSpecs = resolveCliSmokeCommands(options.commands);
  const commands = commandSpecs.map((spec) => {
    const { command, args, result, missing } = runCliSmokeSpec(spec, runner, timeoutMs);
    const ok = !missing && result.status === 0;
    const status = ok ? "ok" : missing ? "missing" : "failed";
    const row: CliSmokeResult["commands"][number] = {
      command: command === spec.command ? spec.command : `${spec.command} via ${command}`,
      args,
      status,
      exit_code: result.status,
      stdout_preview: compactPreview(result.stdout),
      stderr_preview: compactPreview(result.stderr || result.error?.message || ""),
    };
    if (status !== "ok") row.task_seed = cliSmokeTaskSeed(row);
    return row;
  });

  return {
    schema: "open-repos.global-cli-smoke.v1",
    generated_at: new Date().toISOString(),
    limits: { timeout_ms: timeoutMs },
    summary: {
      checked: commands.length,
      ok: commands.filter((command) => command.status === "ok").length,
      failed: commands.filter((command) => command.status === "failed").length,
      missing: commands.filter((command) => command.status === "missing").length,
    },
    task_suggestions: commands
      .map((command) => command.task_seed)
      .filter((seed): seed is TaskSeed => Boolean(seed)),
    commands,
  };
}

export interface PackageHygieneOptions {
  scopes?: string[];
  includeNpmGlobal?: boolean;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface PackageHygieneResult {
  schema: "open-repos.package-hygiene.v1";
  generated_at: string;
  scopes: string[];
  summary: {
    bun_packages_seen: number;
    npm_packages_seen: number;
    scoped_npm_duplicates: number;
    task_seeds: number;
  };
  bun_global: Array<{
    name: string;
    version?: string;
    raw: string;
  }>;
  npm_global_duplicates: Array<{
    name: string;
    version?: string;
  }>;
  task_seeds: TaskSeed[];
}

export interface ReleaseCandidateOptions {
  repo: string;
  githubRepo?: string;
  packageName?: string;
  branch?: string;
  tagPrefix?: string;
  versionFile?: string;
  quietMinutes?: number;
  requireGreenCi?: boolean;
  includeOpenPrBlocker?: boolean;
  fetch?: boolean;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface ReleaseCandidateResult {
  schema: "open-repos.release-candidates.v1";
  generated_at: string;
  repo: {
    input: string;
    path: string;
    github_repo: string;
    branch: string;
    package_name: string;
    tag_prefix: string;
    version_file: string;
  };
  state: {
    head_sha: string | null;
    head_committed_at: string | null;
    intended_version: string | null;
    intended_tag: string | null;
    latest_reachable_tag: string | null;
    latest_github_release: string | null;
    latest_npm_version: string | null;
    commits_since_reachable_tag: number | null;
    minutes_since_head_commit: number | null;
    open_prs: number | null;
    ci: {
      checked: boolean;
      ok: boolean;
      summary: string;
    };
    checks: {
      github_release: ExternalCheck<string>;
      npm_package: ExternalCheck<string>;
      open_prs: ExternalCheck<number>;
    };
  };
  gates: Array<{
    id: string;
    status: "pass" | "block" | "warn";
    message: string;
  }>;
  summary: {
    status: "noop" | "candidate" | "blocked";
    candidates: number;
    blockers: number;
    task_seeds: number;
  };
  task_suggestions: TaskSeed[];
}

export interface DocsRulesDriftOptions {
  repo: string;
  githubRepo?: string;
  branch?: string;
  fetch?: boolean;
  timeoutMs?: number;
  docsPaths?: string[];
  sourcePaths?: string[];
  runner?: CommandRunner;
}

export interface DocsRulesDriftResult {
  schema: "open-repos.docs-rules-drift.v1";
  generated_at: string;
  repo: {
    input: string;
    path: string;
    github_repo: string;
    branch: string;
  };
  config: {
    docs_paths: string[];
    source_paths: string[];
  };
  state: {
    head_sha: string | null;
    latest_docs_commit: string | null;
    source_commits_since_docs: number | null;
    changed_source_files: string[];
  };
  summary: {
    status: "ok" | "drift" | "blocked";
    task_seeds: number;
  };
  issues: Array<{ id: string; severity: "medium" | "high"; message: string }>;
  task_suggestions: TaskSeed[];
}

export interface DependencyRefreshOptions {
  repo: string;
  githubRepo?: string;
  maxLockAgeDays?: number;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface DependencyRefreshResult {
  schema: "open-repos.dependency-refresh.v1";
  generated_at: string;
  repo: {
    input: string;
    path: string;
    github_repo: string;
    package_name: string | null;
  };
  limits: {
    max_lock_age_days: number;
  };
  checks: Array<{
    id: string;
    status: "ok" | "issue" | "skipped";
    message: string;
    count?: number;
  }>;
  summary: {
    status: "ok" | "needs-refresh";
    task_seeds: number;
  };
  task_suggestions: TaskSeed[];
}

export interface WorkspaceWorktreeHygieneOptions {
  roots?: string[];
  worktreeRoot?: string;
  staleDays?: number;
  limit?: number;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface WorkspaceWorktreeHygieneResult {
  schema: "open-repos.workspace-worktree-hygiene.v1";
  generated_at: string;
  roots: string[];
  worktree_root: string | null;
  limits: {
    stale_days: number;
    limit: number;
  };
  summary: {
    repos_checked: number;
    worktrees_checked: number;
    issue_worktrees: number;
    task_seeds: number;
  };
  worktrees: Array<{
    repo_path: string;
    path: string;
    branch: string | null;
    head: string | null;
    age_days: number | null;
    dirty: boolean;
    exists: boolean;
    issues: string[];
    task_seed?: TaskSeed;
  }>;
  task_suggestions: TaskSeed[];
}

export interface TaskRouteHealthOptions {
  routerLoop: string;
  project?: string;
  maxAgeMinutes?: number;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export interface TaskRouteHealthResult {
  schema: "open-repos.task-route-health.v1";
  generated_at: string;
  router_loop: string;
  project: string | null;
  state: {
    loop_status: string | null;
    latest_run_status: string | null;
    latest_run_started_at: string | null;
    latest_run_age_minutes: number | null;
  };
  summary: {
    status: "ok" | "issue";
    task_seeds: number;
  };
  issues: Array<{ id: string; severity: "high" | "medium"; message: string }>;
  task_suggestions: TaskSeed[];
}

export interface ProtectedReleaseOptions extends ReleaseCandidateOptions {
  approvalLabel?: string;
}

export interface ProtectedReleaseResult {
  schema: "open-repos.protected-release.v1";
  generated_at: string;
  release: ReleaseCandidateResult;
  summary: {
    status: "blocked" | "noop" | "ready";
    task_seeds: number;
  };
  task_suggestions: TaskSeed[];
}

interface ExternalCheck<T> {
  checked: boolean;
  ok: boolean;
  value: T | null;
  error: string | null;
}

export function inspectPackageHygiene(options: PackageHygieneOptions = {}): PackageHygieneResult {
  const scopes = options.scopes?.length ? options.scopes : ["@hasna", "@hasnaxyz"];
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const runner = options.runner ?? spawnCommand;
  const bunRows = parseBunGlobalList(runner("bun", ["pm", "ls", "-g"], { timeoutMs }).stdout, scopes);
  const npmRows = options.includeNpmGlobal === false
    ? []
    : parseNpmGlobalList(runner("npm", ["list", "-g", "--depth=0", "--json"], { timeoutMs }).stdout, scopes);
  const duplicates = npmRows.filter((row) => bunRows.some((bunRow) => bunRow.name === row.name));
  const taskSeeds = duplicates.map((row) => packageDuplicateTaskSeed(row));

  return {
    schema: "open-repos.package-hygiene.v1",
    generated_at: new Date().toISOString(),
    scopes,
    summary: {
      bun_packages_seen: bunRows.length,
      npm_packages_seen: npmRows.length,
      scoped_npm_duplicates: duplicates.length,
      task_seeds: taskSeeds.length,
    },
    bun_global: bunRows,
    npm_global_duplicates: duplicates,
    task_seeds: taskSeeds,
  };
}

export function buildReleaseCandidates(options: ReleaseCandidateOptions): ReleaseCandidateResult {
  const repoPath = resolveRepoPath(options.repo);
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const branch = options.branch ?? "main";
  const packageName = options.packageName ?? inferPackageName(repoPath) ?? "unknown";
  const tagPrefix = options.tagPrefix ?? "v";
  const versionFile = options.versionFile ?? inferVersionFile(repoPath) ?? "package.json";
  const quietMinutes = normalizeNonNegativeInteger(options.quietMinutes, 60);
  const githubRepo = options.githubRepo ?? inferGithubRepo(repoPath, runner, timeoutMs) ?? "unknown/unknown";
  const ref = `origin/${branch}`;

  const gates: ReleaseCandidateResult["gates"] = [];
  if (options.fetch !== false) {
    const fetched = runner("git", ["-C", repoPath, "fetch", "--tags", "origin", branch], { timeoutMs });
    if (fetched.status !== 0) {
      gates.push({ id: "fetch", status: "block", message: `git fetch failed: ${compactPreview(fetched.stderr || fetched.stdout)}` });
    }
  }

  const headSha = gitOutput(repoPath, runner, timeoutMs, ["rev-parse", ref]);
  const headCommittedAt = gitOutput(repoPath, runner, timeoutMs, ["show", "-s", "--format=%cI", ref]);
  const latestReachableTag = gitOutput(repoPath, runner, timeoutMs, ["describe", "--tags", "--match", `${tagPrefix}*`, "--abbrev=0", ref]);
  const commitsSinceReachableTag = latestReachableTag
    ? Number(gitOutput(repoPath, runner, timeoutMs, ["rev-list", "--count", `${latestReachableTag}..${ref}`]) ?? "0")
    : null;
  const intendedVersion = readVersion(repoPath, versionFile);
  const intendedTag = intendedVersion ? `${tagPrefix}${intendedVersion}` : null;
  const githubReleaseCheck = latestGithubReleaseTag(githubRepo, tagPrefix, runner, timeoutMs);
  const npmPackageCheck = latestNpmPackageVersion(packageName, runner, timeoutMs);
  const openPrsCheck = countOpenPrs(githubRepo, runner, timeoutMs);
  const latestGithubRelease = githubReleaseCheck.value;
  const latestNpmVersion = npmPackageCheck.value;
  const openPrs = openPrsCheck.value;
  const ci = options.requireGreenCi === false
    ? { checked: false, ok: true, summary: "green CI not required by options" }
    : checkCi(githubRepo, headSha, runner, timeoutMs);
  const minutesSinceHeadCommit = headCommittedAt ? minutesSince(headCommittedAt) : null;

  if (!headSha) gates.push({ id: "head", status: "block", message: `could not resolve ${ref}` });
  if (packageName === "unknown") gates.push({ id: "package-name", status: "block", message: "could not infer package name; pass --package explicitly" });
  if (!intendedVersion || !intendedTag) gates.push({ id: "version", status: "block", message: `could not read release version from ${versionFile}` });
  if (!githubReleaseCheck.ok) {
    gates.push({ id: "github-release-check", status: "block", message: githubReleaseCheck.error ?? `could not verify GitHub releases for ${githubRepo}` });
  }
  if (!npmPackageCheck.ok) {
    gates.push({ id: "npm-registry-check", status: "block", message: npmPackageCheck.error ?? `could not verify npm package ${packageName}` });
  }
  if (options.includeOpenPrBlocker !== false && !openPrsCheck.ok) {
    gates.push({ id: "open-pr-check", status: "block", message: openPrsCheck.error ?? `could not verify open PRs for ${githubRepo}` });
  }
  if (latestNpmVersion && intendedVersion && compareVersions(intendedVersion, latestNpmVersion) < 0) {
    gates.push({
      id: "version-regression",
      status: "block",
      message: `${versionFile} version ${intendedVersion} is behind npm ${packageName}@${latestNpmVersion}`,
    });
  }
  if (latestGithubRelease && intendedTag && compareTags(intendedTag, latestGithubRelease, tagPrefix) < 0) {
    gates.push({
      id: "tag-regression",
      status: "block",
      message: `intended tag ${intendedTag} is behind GitHub release ${latestGithubRelease}`,
    });
  }
  if (latestGithubRelease) {
    const ancestor = runner("git", ["-C", repoPath, "merge-base", "--is-ancestor", latestGithubRelease, ref], { timeoutMs });
    if (ancestor.status !== 0) {
      gates.push({
        id: "latest-release-not-ancestor",
        status: "block",
        message: `latest GitHub release ${latestGithubRelease} is not an ancestor of ${ref}`,
      });
    }
  }
  if (intendedTag) {
    const exists = runner("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", intendedTag], { timeoutMs });
    if (exists.status === 0) {
      gates.push({ id: "tag-exists", status: "block", message: `intended tag ${intendedTag} already exists locally` });
    }
  }
  if (latestNpmVersion && intendedVersion && latestNpmVersion === intendedVersion) {
    gates.push({ id: "npm-version-exists", status: "block", message: `${packageName}@${intendedVersion} already exists on npm` });
  }
  if (latestGithubRelease && intendedTag && latestGithubRelease === intendedTag) {
    gates.push({ id: "github-release-exists", status: "block", message: `GitHub release ${intendedTag} already exists` });
  }
  if (minutesSinceHeadCommit != null && minutesSinceHeadCommit < quietMinutes) {
    gates.push({
      id: "quiet-window",
      status: "block",
      message: `${ref} changed ${minutesSinceHeadCommit} minute(s) ago; quiet window is ${quietMinutes} minute(s)`,
    });
  }
  if (options.includeOpenPrBlocker !== false && openPrs != null && openPrs > 0) {
    gates.push({ id: "open-prs", status: "block", message: `${githubRepo} has ${openPrs} open PR(s)` });
  }
  if (!ci.ok) gates.push({ id: "ci", status: "block", message: ci.summary });
  if (!latestReachableTag) gates.push({ id: "no-baseline-tag", status: "block", message: `no reachable ${tagPrefix}* release tag found on ${ref}` });
  if (commitsSinceReachableTag === 0) gates.push({ id: "no-new-commits", status: "pass", message: `${ref} has no commits since ${latestReachableTag}` });

  const blockers = gates.filter((gate) => gate.status === "block");
  const taskSeeds: TaskSeed[] = [];
  if (blockers.length > 0) {
    taskSeeds.push(releaseBlockerTaskSeed({
      repoPath,
      githubRepo,
      packageName,
      branch,
      ref,
      headSha,
      intendedVersion,
      intendedTag,
      latestGithubRelease,
      latestNpmVersion,
      blockers,
    }));
  } else if (headSha && intendedVersion && intendedTag && (commitsSinceReachableTag ?? 0) > 0) {
    taskSeeds.push(releaseCandidateTaskSeed({
      repoPath,
      githubRepo,
      packageName,
      branch,
      ref,
      headSha,
      intendedVersion,
      intendedTag,
      latestReachableTag,
      latestGithubRelease,
      latestNpmVersion,
      commitsSinceReachableTag,
    }));
  }

  const status = blockers.length > 0 ? "blocked" : taskSeeds.length > 0 ? "candidate" : "noop";
  return {
    schema: "open-repos.release-candidates.v1",
    generated_at: new Date().toISOString(),
    repo: {
      input: options.repo,
      path: repoPath,
      github_repo: githubRepo,
      branch,
      package_name: packageName,
      tag_prefix: tagPrefix,
      version_file: versionFile,
    },
    state: {
      head_sha: headSha,
      head_committed_at: headCommittedAt,
      intended_version: intendedVersion,
      intended_tag: intendedTag,
      latest_reachable_tag: latestReachableTag,
      latest_github_release: latestGithubRelease,
      latest_npm_version: latestNpmVersion,
      commits_since_reachable_tag: Number.isFinite(commitsSinceReachableTag) ? commitsSinceReachableTag : null,
      minutes_since_head_commit: minutesSinceHeadCommit,
      open_prs: openPrs,
      ci,
      checks: {
        github_release: githubReleaseCheck,
        npm_package: npmPackageCheck,
        open_prs: openPrsCheck,
      },
    },
    gates,
    summary: {
      status,
      candidates: status === "candidate" ? 1 : 0,
      blockers: blockers.length,
      task_seeds: taskSeeds.length,
    },
    task_suggestions: taskSeeds,
  };
}

const DEFAULT_DOCS_PATHS = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEWITH.md",
  "docs",
  ".codewith/skills",
  ".agents/skills",
];

const DEFAULT_SOURCE_PATHS = [
  "src",
  "codex-rs",
  "codex-cli",
  "app",
  "packages",
  "crates",
  "package.json",
  "Cargo.toml",
  "bun.lock",
  "Cargo.lock",
  ".github/workflows",
];

export function buildDocsRulesDrift(options: DocsRulesDriftOptions): DocsRulesDriftResult {
  const repoPath = resolveRepoPath(options.repo);
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const branch = options.branch ?? "main";
  const githubRepo = options.githubRepo ?? inferGithubRepo(repoPath, runner, timeoutMs) ?? "unknown/unknown";
  const docsPaths = existingRelativePaths(repoPath, options.docsPaths?.length ? options.docsPaths : DEFAULT_DOCS_PATHS);
  const sourcePaths = existingRelativePaths(repoPath, options.sourcePaths?.length ? options.sourcePaths : DEFAULT_SOURCE_PATHS);
  const ref = `origin/${branch}`;
  const issues: DocsRulesDriftResult["issues"] = [];

  if (options.fetch !== false) {
    const fetched = runner("git", ["-C", repoPath, "fetch", "origin", branch], { timeoutMs });
    if (fetched.status !== 0) {
      issues.push({ id: "fetch", severity: "high", message: `git fetch failed: ${compactPreview(fetched.stderr || fetched.stdout)}` });
    }
  }

  const headSha = gitOutput(repoPath, runner, timeoutMs, ["rev-parse", ref]);
  const latestDocsCommit = docsPaths.length > 0
    ? gitOutput(repoPath, runner, timeoutMs, ["log", "-1", "--format=%H", ref, "--", ...docsPaths])
    : null;
  const sourceCommitsSinceDocs = latestDocsCommit && sourcePaths.length > 0
    ? Number(gitOutput(repoPath, runner, timeoutMs, ["rev-list", "--count", `${latestDocsCommit}..${ref}`, "--", ...sourcePaths]) ?? "0")
    : null;
  const changedSourceFiles = latestDocsCommit && sourcePaths.length > 0
    ? gitOutput(repoPath, runner, timeoutMs, ["diff", "--name-only", `${latestDocsCommit}..${ref}`, "--", ...sourcePaths])
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 50) ?? []
    : [];

  if (!headSha) issues.push({ id: "head", severity: "high", message: `could not resolve ${ref}` });
  if (docsPaths.length === 0) issues.push({ id: "docs-paths", severity: "medium", message: "no docs/rules paths exist in this repo" });
  if (sourcePaths.length === 0) issues.push({ id: "source-paths", severity: "medium", message: "no source paths exist in this repo" });
  if (sourcePaths.length > 0 && !latestDocsCommit) {
    issues.push({ id: "docs-baseline", severity: "high", message: "no docs/rules baseline commit found for tracked docs paths" });
  }
  if ((sourceCommitsSinceDocs ?? 0) > 0) {
    issues.push({
      id: "source-after-docs",
      severity: "medium",
      message: `${sourceCommitsSinceDocs} source commit(s) landed after the latest docs/rules update`,
    });
  }

  const blocking = issues.filter((issue) => issue.severity === "high");
  const drift = issues.length > 0;
  const taskSeeds = drift
    ? [docsRulesDriftTaskSeed({
      repoPath,
      githubRepo,
      branch,
      headSha,
      latestDocsCommit,
      sourceCommitsSinceDocs,
      changedSourceFiles,
      issues,
    })]
    : [];

  return {
    schema: "open-repos.docs-rules-drift.v1",
    generated_at: new Date().toISOString(),
    repo: { input: options.repo, path: repoPath, github_repo: githubRepo, branch },
    config: { docs_paths: docsPaths, source_paths: sourcePaths },
    state: {
      head_sha: headSha,
      latest_docs_commit: latestDocsCommit,
      source_commits_since_docs: Number.isFinite(sourceCommitsSinceDocs) ? sourceCommitsSinceDocs : null,
      changed_source_files: changedSourceFiles,
    },
    summary: {
      status: blocking.length > 0 ? "blocked" : drift ? "drift" : "ok",
      task_seeds: taskSeeds.length,
    },
    issues,
    task_suggestions: taskSeeds,
  };
}

export function buildDependencyRefresh(options: DependencyRefreshOptions): DependencyRefreshResult {
  const repoPath = resolveRepoPath(options.repo);
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 30_000);
  const maxLockAgeDays = normalizePositiveInteger(options.maxLockAgeDays, 7);
  const githubRepo = options.githubRepo ?? inferGithubRepo(repoPath, runner, timeoutMs) ?? "unknown/unknown";
  const packageName = inferPackageName(repoPath);
  const checks: DependencyRefreshResult["checks"] = [];

  if (existsSync(join(repoPath, "package.json"))) {
    const outdated = runner("bun", ["outdated", "--json"], { timeoutMs, cwd: repoPath });
    const count = parseOutdatedCount(outdated.stdout);
    if (outdated.status === 0 && count === 0) {
      checks.push({ id: "bun-outdated", status: "ok", message: "bun outdated reported no package updates", count: 0 });
    } else if (count > 0) {
      checks.push({ id: "bun-outdated", status: "issue", message: `${count} Bun/npm package update(s) available`, count });
    } else {
      checks.push({
        id: "bun-outdated",
        status: "issue",
        message: `could not determine Bun/npm outdated state: ${compactPreview(outdated.stderr || outdated.stdout || outdated.error?.message || "")}`,
      });
    }
  } else {
    checks.push({ id: "bun-outdated", status: "skipped", message: "package.json not present" });
  }

  for (const lockFile of ["bun.lock", "bun.lockb", "Cargo.lock"]) {
    const lockPath = join(repoPath, lockFile);
    if (!existsSync(lockPath)) continue;
    const ageDays = daysSinceMtime(lockPath);
    if (ageDays != null && ageDays > maxLockAgeDays) {
      checks.push({ id: `stale-${lockFile}`, status: "issue", message: `${lockFile} is ${ageDays} day(s) old; refresh review is due`, count: ageDays });
    } else {
      checks.push({ id: `fresh-${lockFile}`, status: "ok", message: `${lockFile} age is within ${maxLockAgeDays} day(s)`, ...(ageDays == null ? {} : { count: ageDays }) });
    }
  }

  if (existsSync(join(repoPath, "Cargo.toml")) || existsSync(join(repoPath, "codex-rs", "Cargo.toml"))) {
    const cargo = runner("cargo", ["--version"], { timeoutMs, cwd: repoPath });
    checks.push(cargo.status === 0
      ? { id: "cargo-available", status: "ok", message: "cargo is available for Rust dependency refresh checks" }
      : { id: "cargo-available", status: "issue", message: `cargo unavailable: ${compactPreview(cargo.stderr || cargo.error?.message || "")}` });
  }

  const issues = checks.filter((check) => check.status === "issue");
  const taskSeeds = issues.length > 0 ? [dependencyRefreshTaskSeed({ repoPath, githubRepo, packageName, maxLockAgeDays, issues })] : [];
  return {
    schema: "open-repos.dependency-refresh.v1",
    generated_at: new Date().toISOString(),
    repo: { input: options.repo, path: repoPath, github_repo: githubRepo, package_name: packageName },
    limits: { max_lock_age_days: maxLockAgeDays },
    checks,
    summary: { status: issues.length > 0 ? "needs-refresh" : "ok", task_seeds: taskSeeds.length },
    task_suggestions: taskSeeds,
  };
}

export function buildWorkspaceWorktreeHygiene(options: WorkspaceWorktreeHygieneOptions = {}): WorkspaceWorktreeHygieneResult {
  const roots = options.roots?.length ? options.roots : [`${process.env["HOME"] || "/home/hasna"}/workspace/hasna/opensource`];
  const worktreeRoot = options.worktreeRoot ?? `${process.env["HOME"] || "/home/hasna"}/.hasna/loops/worktrees`;
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const staleDays = normalizePositiveInteger(options.staleDays, 7);
  const limit = normalizePositiveInteger(options.limit, 200);
  const repos = discoverGitRepos(roots).slice(0, limit);
  const worktrees: WorkspaceWorktreeHygieneResult["worktrees"] = [];
  let worktreesChecked = 0;

  for (const repoPath of repos) {
    const listed = runner("git", ["-C", repoPath, "worktree", "list", "--porcelain"], { timeoutMs });
    if (listed.status !== 0) continue;
    const primaryPath = statSafe(repoPath)?.realpath ?? repoPath;
    for (const entry of parseWorktreeList(listed.stdout)) {
      const normalizedPath = statSafe(entry.path)?.realpath ?? entry.path;
      if (normalizedPath === primaryPath) continue;
      if (worktreeRoot && !normalizedPath.startsWith(worktreeRoot)) continue;
      worktreesChecked += 1;
      const exists = existsSync(entry.path);
      const dirty = exists ? Boolean(runner("git", ["-C", entry.path, "status", "--porcelain"], { timeoutMs }).stdout.trim()) : false;
      const committedAt = exists ? gitOutput(entry.path, runner, timeoutMs, ["show", "-s", "--format=%cI", "HEAD"]) : null;
      const ageDays = committedAt ? daysSince(committedAt) : null;
      const issues: string[] = [];
      if (!exists) issues.push("missing-worktree-path");
      if (!entry.branch) issues.push("detached-or-unknown-branch");
      if (dirty) issues.push("dirty-worktree");
      if (ageDays != null && ageDays > staleDays) issues.push("stale-worktree");
      if (issues.length === 0) continue;
      const row = {
        repo_path: repoPath,
        path: entry.path,
        branch: entry.branch,
        head: entry.head,
        age_days: ageDays,
        dirty,
        exists,
        issues,
      };
      worktrees.push({ ...row, task_seed: worktreeHygieneTaskSeed(row) });
    }
  }

  return {
    schema: "open-repos.workspace-worktree-hygiene.v1",
    generated_at: new Date().toISOString(),
    roots,
    worktree_root: worktreeRoot,
    limits: { stale_days: staleDays, limit },
    summary: {
      repos_checked: repos.length,
      worktrees_checked: worktreesChecked,
      issue_worktrees: worktrees.length,
      task_seeds: worktrees.length,
    },
    worktrees,
    task_suggestions: worktrees.map((worktree) => worktree.task_seed).filter((seed): seed is TaskSeed => Boolean(seed)),
  };
}

export function buildTaskRouteHealth(options: TaskRouteHealthOptions): TaskRouteHealthResult {
  const runner = options.runner ?? spawnCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 20_000);
  const maxAgeMinutes = normalizePositiveInteger(options.maxAgeMinutes, 15);
  const issues: TaskRouteHealthResult["issues"] = [];
  const show = runner("loops", ["show", options.routerLoop, "--json"], { timeoutMs });
  const loop = parseJsonObject<{ status?: unknown }>(show.stdout);
  const runs = runner("loops", ["runs", options.routerLoop, "--limit", "1", "--json"], { timeoutMs });
  const latest = parseJsonArray<{ status?: unknown; startedAt?: unknown }>(runs.stdout)[0];
  const latestStartedAt = typeof latest?.startedAt === "string" ? latest.startedAt : null;
  const latestRunAgeMinutes = latestStartedAt ? minutesSince(latestStartedAt) : null;
  const loopStatus = typeof loop?.status === "string" ? loop.status : null;
  const latestRunStatus = typeof latest?.status === "string" ? latest.status : null;

  if (show.status !== 0 || !loopStatus) {
    issues.push({ id: "router-loop-missing", severity: "high", message: `could not read router loop ${options.routerLoop}` });
  } else if (loopStatus !== "active") {
    issues.push({ id: "router-loop-inactive", severity: "high", message: `router loop ${options.routerLoop} is ${loopStatus}` });
  }
  if (runs.status !== 0 || !latestRunStatus) {
    issues.push({ id: "router-run-missing", severity: "high", message: `could not read latest run for router loop ${options.routerLoop}` });
  } else if (latestRunStatus !== "succeeded") {
    issues.push({ id: "router-run-not-succeeded", severity: "high", message: `latest router run status is ${latestRunStatus}` });
  }
  if (latestRunAgeMinutes != null && latestRunAgeMinutes > maxAgeMinutes) {
    issues.push({ id: "router-run-stale", severity: "medium", message: `latest router run is ${latestRunAgeMinutes} minute(s) old; max is ${maxAgeMinutes}` });
  }

  const taskSeeds = issues.length > 0 ? [taskRouteHealthTaskSeed({ routerLoop: options.routerLoop, project: options.project, issues })] : [];
  return {
    schema: "open-repos.task-route-health.v1",
    generated_at: new Date().toISOString(),
    router_loop: options.routerLoop,
    project: options.project ?? null,
    state: {
      loop_status: loopStatus,
      latest_run_status: latestRunStatus,
      latest_run_started_at: latestStartedAt,
      latest_run_age_minutes: latestRunAgeMinutes,
    },
    summary: { status: issues.length > 0 ? "issue" : "ok", task_seeds: taskSeeds.length },
    issues,
    task_suggestions: taskSeeds,
  };
}

export function buildProtectedRelease(options: ProtectedReleaseOptions): ProtectedReleaseResult {
  const release = buildReleaseCandidates(options);
  const taskSeeds = release.summary.status === "candidate" && release.state.head_sha && release.state.intended_tag
    ? [protectedReleaseTaskSeed(release, options.approvalLabel)]
    : [];
  return {
    schema: "open-repos.protected-release.v1",
    generated_at: new Date().toISOString(),
    release,
    summary: {
      status: release.summary.status === "blocked" ? "blocked" : taskSeeds.length > 0 ? "ready" : "noop",
      task_seeds: taskSeeds.length,
    },
    task_suggestions: taskSeeds,
  };
}

function listPrRows(opts: { org?: string; repo?: string; state: string; limit: number }): PrRow[] {
  const db = getDb();
  const params: Array<string | number> = [];
  const where = ["pr.state = ?"];
  params.push(opts.state);
  if (opts.org) {
    where.push("r.org = ?");
    params.push(opts.org);
  }
  if (opts.repo) {
    where.push("(r.name = ? OR r.path = ?)");
    params.push(opts.repo, opts.repo);
  }
  params.push(opts.limit);
  return db.query<PrRow, Array<string | number>>(`
    SELECT pr.*, r.name AS repo_name, r.org AS repo_org, r.path AS repo_path, r.remote_url AS repo_remote_url
    FROM pull_requests pr
    JOIN repos r ON r.id = pr.repo_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(pr.updated_at, pr.created_at) DESC
    LIMIT ?
  `).all(...params);
}

function prRowToQueueItem(row: PrRow): RepoPrQueueItem {
  const fullName = githubFullNameFromRepoRow(row);
  const prUrl = row.url || `https://github.com/${fullName}/pull/${row.number}`;
  return {
    repo: {
      id: row.repo_id,
      name: row.repo_name,
      full_name: fullName,
      org: row.repo_org,
      path: row.repo_path,
    },
    pr: {
      number: row.number,
      title: row.title,
      state: row.state,
      author: row.author,
      url: row.url || null,
      base_branch: row.base_branch,
      head_branch: row.head_branch,
      updated_at: row.updated_at,
      changed_files: row.changed_files,
      additions: row.additions,
      deletions: row.deletions,
    },
    task_seed: {
      fingerprint: `github-pr:${fullName}#${row.number}`,
      title: `Review and safely merge ${fullName}#${row.number}: ${row.title}`,
      body: [
        `Repository: ${row.repo_path}`,
        `PR: ${prUrl}`,
        `Base: ${row.base_branch ?? "unknown"}`,
        `Head: ${row.head_branch ?? "unknown"}`,
        "",
        "Start a durable goal. Inspect GitHub PR state, checks, branch freshness, review status, and conflicts. Use an adversarial reviewer for non-trivial changes. Merge only when validation and policy allow it; otherwise update the PR/task with exact blockers.",
      ].join("\n"),
      priority: "high",
      tags: ["auto:route", "area:repoops", "github-pr", "pr-merge-queue"],
      metadata: {
        repo_path: row.repo_path,
        repo_full_name: fullName,
        pr_number: row.number,
        pr_url: prUrl,
        source: "open-repos.pr-queue.v1",
      },
    },
  };
}

function githubFullNameFromRepoRow(row: Pick<PrRow, "repo_org" | "repo_name" | "repo_remote_url">): string {
  const parsed = row.repo_remote_url?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (parsed?.[1]) return parsed[1].replace(/\.git$/, "");
  return `${row.repo_org ?? "unknown"}/${row.repo_name}`;
}

function resolveCliSmokeCommands(commands?: string[]): CliSmokeCommandSpec[] {
  if (!commands?.length) return DEFAULT_CLI_SMOKE_COMMANDS;
  const defaults = new Map(DEFAULT_CLI_SMOKE_COMMANDS.map((spec) => [spec.command, spec]));
  return commands.map((command) => defaults.get(command) ?? { command, args: ["--help"] });
}

function runCliSmokeSpec(
  spec: CliSmokeCommandSpec,
  runner: CommandRunner,
  timeoutMs: number,
): { command: string; args: string[]; result: ReturnType<CommandRunner>; missing: boolean } {
  const probes = cliSmokeProbes(spec);
  let last = { command: spec.command, args: spec.args, result: runner(spec.command, spec.args, { timeoutMs }) };
  if (!last.result.error || last.result.error.code !== "ENOENT") {
    if (last.result.status === 0) return { ...last, missing: false };
  }
  let sawExecutable = !last.result.error || last.result.error.code !== "ENOENT";

  for (const probe of probes.slice(1)) {
    const result = runner(probe.command, probe.args, { timeoutMs });
    last = { command: probe.command, args: probe.args, result };
    if (!result.error || result.error.code !== "ENOENT") sawExecutable = true;
    if (result.status === 0) return { ...last, missing: false };
  }

  return { ...last, missing: !sawExecutable };
}

function cliSmokeProbes(spec: CliSmokeCommandSpec): CliSmokeCommandSpec[] {
  if (spec.command === "cursor" && spec.args[0] === "agent") {
    return [
      { command: "cursor", args: ["agent", "--version"] },
      { command: "cursor", args: ["agent", "--help"] },
      { command: "agent", args: ["--version"] },
      { command: "agent", args: ["--help"] },
    ];
  }
  const candidates = [spec.args, ["--version"], ["version"], ["help"], []];
  const seen = new Set<string>();
  return candidates
    .filter((args) => {
      const key = args.join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((args) => ({ command: spec.command, args }));
}

function spawnCommand(command: string, args: string[], opts: { timeoutMs: number; cwd?: string }) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    cwd: opts.cwd,
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } } : {}),
  };
}

function resolveRepoPath(repoInput: string): string {
  if (existsSync(repoInput)) return repoInput;
  try {
    const row = getDb().query<{ path: string }, [string, string, string]>(`
      SELECT path
      FROM repos
      WHERE name = ? OR path = ? OR (org || '/' || name) = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(repoInput, repoInput, repoInput);
    if (row?.path) return row.path;
  } catch {
    // The producer must also work in fresh/temp contexts without an initialized repos DB.
  }
  return repoInput;
}

function inferGithubRepo(repoPath: string, runner: CommandRunner, timeoutMs: number): string | null {
  const remoteUrl = gitOutput(repoPath, runner, timeoutMs, ["config", "--get", "remote.origin.url"]);
  return remoteUrl ? parseGithubRepo(remoteUrl) : null;
}

function parseGithubRepo(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const match = normalized.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/);
  return match?.[1] ?? null;
}

function gitOutput(repoPath: string, runner: CommandRunner, timeoutMs: number, args: string[]): string | null {
  const result = runner("git", ["-C", repoPath, ...args], { timeoutMs });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function readVersion(repoPath: string, versionFile: string): string | null {
  const path = `${repoPath.replace(/\/+$/, "")}/${versionFile}`;
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const cargoMatch = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (cargoMatch?.[1]) return cargoMatch[1];
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function inferPackageName(repoPath: string): string | null {
  const packageJsonPath = `${repoPath.replace(/\/+$/, "")}/package.json`;
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

function inferVersionFile(repoPath: string): string | null {
  for (const candidate of ["package.json", "Cargo.toml", "codex-rs/Cargo.toml"]) {
    if (readVersion(repoPath, candidate)) return candidate;
  }
  return null;
}

function latestGithubReleaseTag(githubRepo: string, tagPrefix: string, runner: CommandRunner, timeoutMs: number): ExternalCheck<string> {
  if (!isGithubRepoName(githubRepo)) return failedCheck(`invalid GitHub repo ${githubRepo}`);
  const result = runner("gh", ["-R", githubRepo, "release", "list", "--limit", "50", "--json", "tagName"], { timeoutMs });
  if (result.status !== 0) {
    return failedCheck(`could not read GitHub releases for ${githubRepo}: ${compactPreview(result.stderr || result.stdout || result.error?.message || "")}`);
  }
  let releases: Array<{ tagName?: unknown }>;
  try {
    releases = JSON.parse(result.stdout) as Array<{ tagName?: unknown }>;
  } catch {
    return failedCheck(`could not parse GitHub releases for ${githubRepo}`);
  }
  if (!Array.isArray(releases)) return failedCheck(`GitHub releases response for ${githubRepo} was not an array`);
  const tags = releases
    .map((release) => release.tagName)
    .filter((tagName): tagName is string => typeof tagName === "string" && tagName.startsWith(tagPrefix));
  if (tags.length === 0) return okCheck<string>(null);
  tags.sort((a, b) => compareTags(b, a, tagPrefix));
  return okCheck<string>(tags[0] ?? null);
}

function latestNpmPackageVersion(packageName: string, runner: CommandRunner, timeoutMs: number): ExternalCheck<string> {
  if (packageName === "unknown") return failedCheck("cannot read npm package state without a package name");
  const registryName = packageName.replace("/", "%2F");
  const result = runner("curl", ["-fsS", `https://registry.npmjs.org/${registryName}`], { timeoutMs });
  if (result.status !== 0) {
    return failedCheck(`could not read npm package ${packageName}: ${compactPreview(result.stderr || result.stdout || result.error?.message || "")}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as { "dist-tags"?: { latest?: unknown } };
    const latest = parsed["dist-tags"]?.latest;
    return typeof latest === "string" && latest.length > 0
      ? okCheck(latest)
      : failedCheck(`npm package ${packageName} has no dist-tags.latest`);
  } catch {
    return failedCheck(`could not parse npm package ${packageName} registry response`);
  }
}

function countOpenPrs(githubRepo: string, runner: CommandRunner, timeoutMs: number): ExternalCheck<number> {
  if (!isGithubRepoName(githubRepo)) return failedCheck(`invalid GitHub repo ${githubRepo}`);
  const result = runner("gh", ["-R", githubRepo, "pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { timeoutMs });
  if (result.status !== 0) {
    return failedCheck(`could not read open PRs for ${githubRepo}: ${compactPreview(result.stderr || result.stdout || result.error?.message || "")}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? okCheck(parsed.length) : failedCheck(`open PR response for ${githubRepo} was not an array`);
  } catch {
    return failedCheck(`could not parse open PR response for ${githubRepo}`);
  }
}

function okCheck<T>(value: T | null): ExternalCheck<T> {
  return { checked: true, ok: true, value, error: null };
}

function failedCheck<T>(error: string): ExternalCheck<T> {
  return { checked: true, ok: false, value: null, error };
}

function checkCi(githubRepo: string, headSha: string | null, runner: CommandRunner, timeoutMs: number): ReleaseCandidateResult["state"]["ci"] {
  if (!headSha) return { checked: false, ok: false, summary: "cannot check CI without a head SHA" };
  if (!isGithubRepoName(githubRepo)) return { checked: false, ok: false, summary: `cannot check CI for invalid GitHub repo ${githubRepo}` };
  const result = runner("gh", ["-R", githubRepo, "run", "list", "--commit", headSha, "--limit", "10", "--json", "status,conclusion,name,workflowName,createdAt"], { timeoutMs });
  if (result.status !== 0) {
    return { checked: false, ok: false, summary: `could not read GitHub Actions runs: ${compactPreview(result.stderr || result.stdout)}` };
  }
  const runs = parseJsonArray<{ status?: unknown; conclusion?: unknown; name?: unknown; workflowName?: unknown }>(result.stdout);
  if (runs.length === 0) return { checked: true, ok: false, summary: `no GitHub Actions runs found for ${headSha.slice(0, 12)}` };
  const pending = runs.filter((run) => run.status !== "completed");
  const failed = runs.filter((run) => run.status === "completed" && !["success", "skipped", "neutral"].includes(String(run.conclusion ?? "")));
  const names = (pending.length > 0 ? pending : failed)
    .slice(0, 5)
    .map((run) => String(run.workflowName || run.name || "unnamed"))
    .join(", ");
  if (pending.length > 0) return { checked: true, ok: false, summary: `${pending.length} CI run(s) still pending: ${names}` };
  if (failed.length > 0) return { checked: true, ok: false, summary: `${failed.length} CI run(s) not green: ${names}` };
  return { checked: true, ok: true, summary: `${runs.length} GitHub Actions run(s) green` };
}

function minutesSince(iso: string): number | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 60_000));
}

function compareTags(a: string, b: string, tagPrefix: string): number {
  return compareVersions(stripTagPrefix(a, tagPrefix), stripTagPrefix(b, tagPrefix));
}

function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = parsedA.parts[index]! - parsedB.parts[index]!;
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

function parseVersion(value: string): { parts: [number, number, number]; prerelease: string } {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return { parts: [0, 0, 0], prerelease: value };
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

function stripTagPrefix(tag: string, tagPrefix: string): string {
  return tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : tag;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function isGithubRepoName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function releaseBlockerTaskSeed(opts: {
  repoPath: string;
  githubRepo: string;
  packageName: string;
  branch: string;
  ref: string;
  headSha: string | null;
  intendedVersion: string | null;
  intendedTag: string | null;
  latestGithubRelease: string | null;
  latestNpmVersion: string | null;
  blockers: ReleaseCandidateResult["gates"];
}): TaskSeed {
  const shortHead = opts.headSha ? opts.headSha.slice(0, 12) : "unknown";
  return {
    fingerprint: `release-blocker:${opts.githubRepo}:${opts.branch}:${shortHead}:${opts.intendedTag ?? "unknown"}`,
    title: `Resolve release blockers for ${opts.githubRepo} ${shortHead}`,
    body: [
      `Repository: ${opts.repoPath}`,
      `GitHub repo: ${opts.githubRepo}`,
      `Branch/ref: ${opts.ref}`,
      `Head SHA: ${opts.headSha ?? "unknown"}`,
      `Intended version/tag: ${opts.intendedVersion ?? "unknown"} / ${opts.intendedTag ?? "unknown"}`,
      `Latest GitHub release: ${opts.latestGithubRelease ?? "unknown"}`,
      `Latest npm version: ${opts.packageName}@${opts.latestNpmVersion ?? "unknown"}`,
      "",
      "Blockers:",
      ...opts.blockers.map((blocker) => `- ${blocker.id}: ${blocker.message}`),
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      `  repo: ${repoSlug(opts.githubRepo)}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      `  fingerprint: release-blocker:${opts.githubRepo}:${opts.branch}:${shortHead}:${opts.intendedTag ?? "unknown"}`,
      "",
      "Start a durable goal in an isolated worktree. Inspect the release state first, reconcile branch/tag/npm drift, update evidence, and prepare a PR only when the release line is safe. Do not create or push release tags, run npm/bun publish, or dispatch release workflows from this automatic task.",
    ].join("\n"),
    priority: "high",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "release-blocker", `repo:${repoSlug(opts.githubRepo)}`],
    metadata: {
      source: "open-repos.release-candidates.v1",
      repo_path: opts.repoPath,
      repo_full_name: opts.githubRepo,
      package_name: opts.packageName,
      branch: opts.branch,
      head_sha: opts.headSha,
      intended_version: opts.intendedVersion,
      intended_tag: opts.intendedTag,
      latest_github_release: opts.latestGithubRelease,
      latest_npm_version: opts.latestNpmVersion,
      blocker_ids: opts.blockers.map((blocker) => blocker.id),
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
      worktree: "required",
    },
  };
}

function releaseCandidateTaskSeed(opts: {
  repoPath: string;
  githubRepo: string;
  packageName: string;
  branch: string;
  ref: string;
  headSha: string;
  intendedVersion: string;
  intendedTag: string;
  latestReachableTag: string | null;
  latestGithubRelease: string | null;
  latestNpmVersion: string | null;
  commitsSinceReachableTag: number | null;
}): TaskSeed {
  return {
    fingerprint: `release-candidate:${opts.githubRepo}:${opts.intendedTag}:${opts.headSha.slice(0, 12)}`,
    title: `Prepare release ${opts.githubRepo} ${opts.intendedTag}`,
    body: [
      `Repository: ${opts.repoPath}`,
      `GitHub repo: ${opts.githubRepo}`,
      `Branch/ref: ${opts.ref}`,
      `Head SHA: ${opts.headSha}`,
      `Release version/tag: ${opts.intendedVersion} / ${opts.intendedTag}`,
      `Latest reachable tag: ${opts.latestReachableTag ?? "none"}`,
      `Latest GitHub release: ${opts.latestGithubRelease ?? "unknown"}`,
      `Latest npm version: ${opts.packageName}@${opts.latestNpmVersion ?? "unknown"}`,
      `Commits since reachable tag: ${opts.commitsSinceReachableTag ?? "unknown"}`,
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      `  repo: ${repoSlug(opts.githubRepo)}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      `  fingerprint: release-candidate:${opts.githubRepo}:${opts.intendedTag}:${opts.headSha.slice(0, 12)}`,
      "",
      "Start a durable goal in an isolated worktree. Review commits since the last release, update changelog/release notes, verify tests/checks, use an adversarial reviewer, and prepare a release PR or handoff evidence. Do not create or push release tags, run npm/bun publish, or dispatch release workflows from this automatic task; actual publishing requires a separate approval or protected release step.",
    ].join("\n"),
    priority: "high",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "release-candidate", `repo:${repoSlug(opts.githubRepo)}`],
    metadata: {
      source: "open-repos.release-candidates.v1",
      repo_path: opts.repoPath,
      repo_full_name: opts.githubRepo,
      package_name: opts.packageName,
      branch: opts.branch,
      head_sha: opts.headSha,
      intended_version: opts.intendedVersion,
      intended_tag: opts.intendedTag,
      latest_reachable_tag: opts.latestReachableTag,
      latest_github_release: opts.latestGithubRelease,
      latest_npm_version: opts.latestNpmVersion,
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
      worktree: "required",
      publish_path: "separate-approved-protected-release-step",
    },
  };
}

function docsRulesDriftTaskSeed(opts: {
  repoPath: string;
  githubRepo: string;
  branch: string;
  headSha: string | null;
  latestDocsCommit: string | null;
  sourceCommitsSinceDocs: number | null;
  changedSourceFiles: string[];
  issues: DocsRulesDriftResult["issues"];
}): TaskSeed {
  const shortHead = opts.headSha?.slice(0, 12) ?? "unknown";
  return {
    fingerprint: `docs-rules-drift:${opts.githubRepo}:${opts.branch}:${shortHead}:${opts.latestDocsCommit?.slice(0, 12) ?? "no-docs"}`,
    title: `Update docs, changelog, and agent rules for ${opts.githubRepo}`,
    body: [
      `Repository: ${opts.repoPath}`,
      `GitHub repo: ${opts.githubRepo}`,
      `Branch: ${opts.branch}`,
      `Head SHA: ${opts.headSha ?? "unknown"}`,
      `Latest docs/rules commit: ${opts.latestDocsCommit ?? "unknown"}`,
      `Source commits since docs/rules update: ${opts.sourceCommitsSinceDocs ?? "unknown"}`,
      "",
      "Issues:",
      ...opts.issues.map((issue) => `- ${issue.id}: ${issue.message}`),
      "",
      "Changed source files sample:",
      ...(opts.changedSourceFiles.length ? opts.changedSourceFiles.map((file) => `- ${file}`) : ["- none captured"]),
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      `  repo: ${repoSlug(opts.githubRepo)}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      "",
      "Start a durable goal in an isolated worktree. Review recent code changes, update CHANGELOG/README/docs and repo-local AGENTS.md, CLAUDE.md, CODEWITH.md, skills, and rules where applicable. Preserve unrelated changes, validate docs references, use an adversarial reviewer for non-trivial changes, commit logically, and open/update a PR.",
    ].join("\n"),
    priority: "medium",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "docs-rules-drift", `repo:${repoSlug(opts.githubRepo)}`],
    metadata: {
      source: "open-repos.docs-rules-drift.v1",
      repo_path: opts.repoPath,
      repo_full_name: opts.githubRepo,
      branch: opts.branch,
      head_sha: opts.headSha,
      latest_docs_commit: opts.latestDocsCommit,
      source_commits_since_docs: opts.sourceCommitsSinceDocs,
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
      worktree: "required",
    },
  };
}

function dependencyRefreshTaskSeed(opts: {
  repoPath: string;
  githubRepo: string;
  packageName: string | null;
  maxLockAgeDays: number;
  issues: DependencyRefreshResult["checks"];
}): TaskSeed {
  return {
    fingerprint: `dependency-refresh:${opts.githubRepo}:${opts.packageName ?? "no-package"}:${opts.issues.map((issue) => issue.id).join("+")}`,
    title: `Refresh dependencies for ${opts.githubRepo}`,
    body: [
      `Repository: ${opts.repoPath}`,
      `GitHub repo: ${opts.githubRepo}`,
      `Package: ${opts.packageName ?? "unknown"}`,
      `Max lock age policy: ${opts.maxLockAgeDays} day(s)`,
      "",
      "Issues:",
      ...opts.issues.map((issue) => `- ${issue.id}: ${issue.message}`),
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      `  repo: ${repoSlug(opts.githubRepo)}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      "",
      "Start a durable goal in an isolated worktree. Inspect package manager state first, update dependencies conservatively, run tests/builds, check changelog/security notes for dependency changes, use an adversarial reviewer for risky updates, commit logically, and open/update a PR. Do not bypass supply-chain policy for third-party packages.",
    ].join("\n"),
    priority: "medium",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "dependency-refresh", `repo:${repoSlug(opts.githubRepo)}`],
    metadata: {
      source: "open-repos.dependency-refresh.v1",
      repo_path: opts.repoPath,
      repo_full_name: opts.githubRepo,
      package_name: opts.packageName,
      issue_ids: opts.issues.map((issue) => issue.id),
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
      worktree: "required",
    },
  };
}

function worktreeHygieneTaskSeed(opts: {
  repo_path: string;
  path: string;
  branch: string | null;
  head: string | null;
  age_days: number | null;
  dirty: boolean;
  exists: boolean;
  issues: string[];
}): TaskSeed {
  const repoName = basename(opts.repo_path);
  return {
    fingerprint: `worktree-hygiene:${repoName}:${opts.path}:${opts.issues.join("+")}`,
    title: `Triage stale or unsafe worktree for ${repoName}`,
    body: [
      `Repository: ${opts.repo_path}`,
      `Worktree: ${opts.path}`,
      `Branch: ${opts.branch ?? "unknown"}`,
      `Head: ${opts.head ?? "unknown"}`,
      `Age days: ${opts.age_days ?? "unknown"}`,
      `Dirty: ${opts.dirty ? "yes" : "no"}`,
      `Path exists: ${opts.exists ? "yes" : "no"}`,
      "",
      "Issues:",
      ...opts.issues.map((issue) => `- ${issue}`),
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      `  repo: ${repoName}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      "",
      "Start a durable goal. Inspect before deleting or pruning anything. Preserve user work and active workflow state. If cleanup is safe, commit or archive evidence first where appropriate; otherwise update this task with exact blockers and leave the worktree untouched.",
    ].join("\n"),
    priority: opts.dirty ? "high" : "medium",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "worktree-hygiene", `repo:${repoName}`],
    metadata: {
      source: "open-repos.workspace-worktree-hygiene.v1",
      repo_path: opts.repo_path,
      worktree_path: opts.path,
      branch: opts.branch,
      head: opts.head,
      issue_ids: opts.issues,
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
      worktree: "required",
    },
  };
}

function taskRouteHealthTaskSeed(opts: {
  routerLoop: string;
  project?: string;
  issues: TaskRouteHealthResult["issues"];
}): TaskSeed {
  return {
    fingerprint: `task-route-health:${opts.routerLoop}:${opts.issues.map((issue) => issue.id).join("+")}`,
    title: `Fix task lifecycle route health for ${opts.routerLoop}`,
    body: [
      `Router loop: ${opts.routerLoop}`,
      `Project: ${opts.project ?? "unknown"}`,
      "",
      "Issues:",
      ...opts.issues.map((issue) => `- ${issue.id}: ${issue.message}`),
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: auto",
      "  project_group: ops",
      "  workflow: task-lifecycle",
      "",
      "Investigate OpenLoops route health first. Preserve loop history and databases. Fix the narrow route, template, account/profile, or daemon issue; validate with a fresh route run and report evidence.",
    ].join("\n"),
    priority: opts.issues.some((issue) => issue.severity === "high") ? "high" : "medium",
    tags: ["auto:route", "area:repoops", "task-route-health"],
    metadata: {
      source: "open-repos.task-route-health.v1",
      router_loop: opts.routerLoop,
      project: opts.project,
      issue_ids: opts.issues.map((issue) => issue.id),
      automation_mode: "auto:route",
      workflow: "task-lifecycle",
    },
  };
}

function protectedReleaseTaskSeed(release: ReleaseCandidateResult, approvalLabel?: string): TaskSeed {
  const head = release.state.head_sha!;
  const tag = release.state.intended_tag!;
  return {
    fingerprint: `protected-release:${release.repo.github_repo}:${tag}:${head.slice(0, 12)}`,
    title: `Protected release publish for ${release.repo.github_repo} ${tag}`,
    body: [
      `Repository: ${release.repo.path}`,
      `GitHub repo: ${release.repo.github_repo}`,
      `Package: ${release.repo.package_name}`,
      `Branch: ${release.repo.branch}`,
      `Head SHA: ${head}`,
      `Release tag: ${tag}`,
      `Latest reachable tag: ${release.state.latest_reachable_tag ?? "none"}`,
      `Latest GitHub release: ${release.state.latest_github_release ?? "unknown"}`,
      `Latest npm version: ${release.repo.package_name}@${release.state.latest_npm_version ?? "unknown"}`,
      `Approval label/check: ${approvalLabel ?? "repo policy and protected release workflow"}`,
      "",
      "Routing metadata:",
      "  route_enabled: true",
      "  automation.allowed: true",
      "  automation.mode: protected",
      `  repo: ${repoSlug(release.repo.github_repo)}`,
      "  project_group: oss",
      "  workflow: task-lifecycle",
      "  worktree_mode: required",
      "",
      "Start a durable goal in an isolated worktree. Re-check CI, tag existence, npm registry state, changelog, and release notes. Use an adversarial reviewer. Publish only if the protected release policy explicitly allows it in this environment; otherwise prepare the final release PR/handoff and leave exact blockers.",
    ].join("\n"),
    priority: "critical",
    tags: ["auto:route", "area:repoops", "task-lifecycle", "protected-release", `repo:${repoSlug(release.repo.github_repo)}`],
    metadata: {
      source: "open-repos.protected-release.v1",
      repo_path: release.repo.path,
      repo_full_name: release.repo.github_repo,
      package_name: release.repo.package_name,
      branch: release.repo.branch,
      head_sha: head,
      intended_tag: tag,
      automation_mode: "protected",
      workflow: "task-lifecycle",
      worktree: "required",
    },
  };
}

function existingRelativePaths(repoPath: string, candidates: string[]): string[] {
  return candidates.filter((candidate) => existsSync(join(repoPath, candidate)));
}

function daysSinceMtime(path: string): number | null {
  try {
    const mtime = statSync(path).mtimeMs;
    return Math.max(0, Math.floor((Date.now() - mtime) / 86_400_000));
  } catch {
    return null;
  }
}

function daysSince(iso: string): number | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function parseOutdatedCount(stdout: string): number {
  if (!stdout.trim()) return 0;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") {
      if (Array.isArray((parsed as { outdated?: unknown }).outdated)) return ((parsed as { outdated: unknown[] }).outdated).length;
      return Object.keys(parsed).length;
    }
  } catch {
    return 0;
  }
  return 0;
}

function discoverGitRepos(roots: string[]): string[] {
  const repos: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (existsSync(join(path, ".git"))) repos.push(path);
    }
  }
  return repos.sort();
}

function statSafe(path: string): { realpath: string } | null {
  try {
    return { realpath: realpathSync(path) };
  } catch {
    return null;
  }
}

function parseWorktreeList(stdout: string): Array<{ path: string; head: string | null; branch: string | null }> {
  const records: Array<{ path: string; head: string | null; branch: string | null }> = [];
  let current: { path?: string; head?: string | null; branch?: string | null } = {};
  const flush = () => {
    if (current.path) records.push({ path: current.path, head: current.head ?? null, branch: current.branch ?? null });
    current = {};
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    if (key === "detached") current.branch = null;
  }
  flush();
  return records;
}

function parseJsonObject<T extends object>(value: string): T | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function repoSlug(githubRepo: string): string {
  return githubRepo.split("/").pop() ?? githubRepo;
}

function compactPreview(value: string, max = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`;
}

function cliSmokeTaskSeed(row: CliSmokeResult["commands"][number]): TaskSeed {
  return {
    fingerprint: `cli-smoke:${row.command}`,
    title: `Fix CLI smoke failure for ${row.command}`,
    body: [
      `Command: ${row.command} ${row.args.join(" ")}`,
      `Status: ${row.status}`,
      `Exit code: ${row.exit_code ?? "none"}`,
      `stderr: ${row.stderr_preview || "empty"}`,
    ].join("\n"),
    priority: row.status === "missing" ? "high" : "medium",
    tags: ["auto:route", "area:repoops", "global-cli-smoke"],
    metadata: {
      command: row.command,
      args: row.args,
      status: row.status,
      source: "open-repos.global-cli-smoke.v1",
    },
  };
}

function parseBunGlobalList(stdout: string, scopes: string[]): PackageHygieneResult["bun_global"] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => scopes.some((scope) => line.includes(scope)))
    .map((line) => {
      const match = line.match(/(@[^@\s]+\/[^@\s]+)(?:@([^\s]+))?/);
      return match ? { name: match[1]!, ...(match[2] ? { version: match[2]! } : {}), raw: line } : undefined;
    })
    .filter((row): row is PackageHygieneResult["bun_global"][number] => Boolean(row));
}

function parseNpmGlobalList(stdout: string, scopes: string[]): PackageHygieneResult["npm_global_duplicates"] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    return Object.entries(parsed.dependencies ?? {})
      .filter(([name]) => scopes.some((scope) => name.startsWith(`${scope}/`)))
      .map(([name, entry]) => ({ name, ...(entry.version ? { version: entry.version } : {}) }));
  } catch {
    return [];
  }
}

function packageDuplicateTaskSeed(row: PackageHygieneResult["npm_global_duplicates"][number]): TaskSeed {
  return {
    fingerprint: `package-hygiene:npm-global-duplicate:${row.name}`,
    title: `Remove npm global duplicate for ${row.name}`,
    body: [
      `${row.name}${row.version ? `@${row.version}` : ""} is installed globally through npm while Hasna packages should be managed with Bun.`,
      "Verify the package is available through Bun first, then remove the npm global duplicate without deleting package data.",
    ].join("\n"),
    priority: "medium",
    tags: ["auto:route", "area:repoops", "package-hygiene"],
    metadata: {
      package_name: row.name,
      npm_version: row.version,
      source: "open-repos.package-hygiene.v1",
    },
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
