import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  opts: { timeoutMs: number },
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

function spawnCommand(command: string, args: string[], opts: { timeoutMs: number }) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
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
