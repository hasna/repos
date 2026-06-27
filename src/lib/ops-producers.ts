import { spawnSync } from "node:child_process";
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
