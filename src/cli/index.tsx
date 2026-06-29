#!/usr/bin/env bun
import { registerEventsCommands } from "@hasna/events/commander";
import { execSync } from "node:child_process";
import { program } from "commander";
import { getCliVersion } from "./version.js";
import { parseIntOption } from "./args.js";
import chalk from "chalk";
import {
  listRepos,
  getRepo,
  listCommits,
  listBranches,
  listTags,
  listPullRequests,
  searchAll,
  getGlobalStats,
  getRepoStats,
} from "../db/repos.js";
import { ensureWorkspaceBootstrap, startAutoIndexWorker } from "../lib/auto-index.js";
import { getFilterAlias } from "../lib/config.js";
import { getReposStatus } from "../lib/status.js";
import { formatRepoNotFoundMessage } from "./messages.js";
import { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "../lib/github.js";
import { enumerateGithubRepoCatalog } from "../lib/github-catalog.js";
import { getActivityHeatmap, getContributorStats, getStaleRepos, getRecentActivity } from "../lib/analytics.js";
import { buildGraph, queryNode, queryRelated, findPath, getDeps, getCrossOrgAuthors, getGraphStats } from "../lib/graph.js";
import { buildPrQueue, inspectPackageHygiene, runGlobalCliSmoke, type TaskSeed } from "../lib/ops-producers.js";
import { upsertTaskSeeds, writeLoopReport } from "../lib/ops-loop-tasks.js";
import { findFile, whoIs, diffStats, getDirtyRepos, getUnpushedRepos, getBehindRepos, getHealthReport, getRepoPath, getReport, getChurn, getLanguages, exportRepos, importFromOrg, fuzzyFindRepo } from "../lib/utils.js";
import {
  getDocsDrift,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  triagePullRequests,
  withTodos,
} from "../lib/repo-ops.js";
import { getNoCloudInventory } from "../lib/no-cloud-inventory.js";

const ORG_ALIASES: Record<string, string> = {
  oss: "hasna",
  xyz: "hasnaxyz",
  studio: "hasnastudio",
  tools: "hasnatools",
  ai: "hasnaai",
  education: "hasnaeducation",
  family: "hasnafamily",
};

const AUTO_BOOTSTRAP_SKIP_COMMANDS = new Set([
  "scan",
  "watch",
  "backup",
  "restore",
  "completions",
  "import",
  "ops",
  "package",
  "ports",
  "triage",
  "docs",
  "release",
  "no-cloud",
  "release-health",
]);

program
  .name("repos")
  .description("Local repo intelligence — track all repos, search commits, PRs, branches")
  .version(getCliVersion());

function requireRepo(repoInput: string) {
  const repo = getRepo(repoInput);
  if (repo) return repo;

  const suggestion = fuzzyFindRepo(repoInput);
  console.error(
    chalk.red(
      formatRepoNotFoundMessage(
        repoInput,
        suggestion ? { name: suggestion.name, path: suggestion.path } : undefined
      )
    )
  );
  process.exit(1);
}

function intFlag(value: string, flagName: string, min = 0) {
  try {
    return parseIntOption(value, flagName, min);
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

function optionalIntFlag(value: string | undefined, flagName: string, min = 0) {
  return value === undefined ? undefined : intFlag(value, flagName, min);
}

function csvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function printOpsJson(report: unknown, pretty?: boolean) {
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
}

function collectValues(value: string, previous: string[] = []) {
  previous.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
  return previous;
}

function addOpsOptions(command: any) {
  return command
    .option("-n, --limit <n>", "Max returned items", "20")
    .option("--pretty", "Pretty-print JSON")
    .option("--todo <id>", "Attach a compact comment preview for this todos task")
    .option("--todo-apply", "Actually write the todos comment; without this it is a dry run")
    .option("--todo-agent <name>", "todos agent name for --todo-apply")
    .option("--todo-project <path>", "todos project path for --todo-apply");
}

function addLoopProducerOptions(command: any, defaultMaxActions = 20) {
  return command
    .option("--report-dir <path>", "Write the full JSON envelope to this directory for loop evidence")
    .option("--upsert-tasks", "Create deduped todos tasks from emitted task suggestions")
    .option("--todos-project <path>", "todos project path for --upsert-tasks")
    .option("--task-list <slug>", "Task list slug for --upsert-tasks")
    .option("--max-task-actions <n>", "Maximum new todos tasks to create per run; existing-task checks continue for dedupe", String(defaultMaxActions));
}

interface LoopProducerOpts {
  reportDir?: string;
  upsertTasks?: boolean;
  todosProject?: string;
  taskList?: string;
  maxTaskActions: string;
}

type LoopTaskUpsert = ReturnType<typeof upsertTaskSeeds>;
interface LoopArtifacts {
  report_path?: string;
  task_upsert?: LoopTaskUpsert;
}

type LoopProducerEnvelope<T extends object> = T & {
  loop?: LoopArtifacts;
};

function applyLoopProducerArtifacts<T extends object>(
  report: T,
  seeds: TaskSeed[],
  opts: LoopProducerOpts,
  defaults: {
    reportPrefix: string;
    taskList: string;
    taskListName: string;
    taskListDescription: string;
  },
): LoopProducerEnvelope<T> {
  const loop: LoopArtifacts = {};
  if (opts.upsertTasks) {
    loop.task_upsert = upsertTaskSeeds(seeds, {
      project: opts.todosProject || defaultLoopsTodosProject(),
      taskList: opts.taskList || defaults.taskList,
      taskListName: defaults.taskListName,
      taskListDescription: defaults.taskListDescription,
      maxActions: intFlag(opts.maxTaskActions, "--max-task-actions", 1),
    });
  }
  const envelope = Object.keys(loop).length > 0 ? { ...report, loop } : report;
  if (opts.reportDir) {
    loop.report_path = writeLoopReport(envelope, { reportDir: opts.reportDir, prefix: defaults.reportPrefix, annotatePath: true });
  }
  return Object.keys(loop).length > 0 ? { ...report, loop } : report;
}

function defaultLoopsTodosProject(): string {
  return process.env["LOOPS_TODOS_PROJECT"] || `${process.env["HOME"] || "/home/hasna"}/.hasna/loops`;
}

function loopProducerHadErrors(report: { loop?: { task_upsert?: LoopTaskUpsert } }): boolean {
  return Boolean(report.loop?.task_upsert && report.loop.task_upsert.summary.errors > 0);
}

function syncFailed(synced: { errors: string[] } | undefined, allowSyncErrors: boolean | undefined): boolean {
  return !allowSyncErrors && Boolean(synced && synced.errors.length > 0);
}

function todosOpts(opts: any, cwd: string) {
  return {
    taskId: opts.todo,
    apply: Boolean(opts.todoApply),
    agent: opts.todoAgent,
    project: opts.todoProject,
    cwd,
  };
}

async function bootstrapCliIfNeeded(argv: string[]) {
  if (process.env["HASNA_REPOS_AUTO_BOOTSTRAP"] === "0") {
    return;
  }

  if (argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-V")) {
    return;
  }

  const command = argv.find((arg) => !arg.startsWith("-"));
  if (!command || AUTO_BOOTSTRAP_SKIP_COMMANDS.has(command)) {
    return;
  }

  const quiet = argv.includes("--json");
  await ensureWorkspaceBootstrap(undefined, {
    syncRemote: false,
    onProgress: quiet ? undefined : (msg) => console.log(chalk.dim(`[auto-index] ${msg}`)),
  });
}

// ── Scan ──
program
  .command("scan")
  .description("Scan directories to discover and index git repos")
  .option("--root <paths...>", "Root directories to scan")
  .option("--filter <name>", "Use a saved filter alias to get root paths")
  .option("--full", "Full re-scan (not incremental)")
  .option("-w, --workers <n>", "Number of parallel workers", "4")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const roots = alias?.paths ?? opts.root;
    if (opts.filter && !roots?.length) {
      console.log(chalk.yellow(`Filter '${opts.filter}' has no paths defined`));
    }
    const result = await ensureWorkspaceBootstrap(roots, {
      force: true,
      full: opts.full,
      workers: intFlag(opts.workers, "--workers", 1),
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    const scan = result.scan ?? {
      repos_found: 0,
      repos_new: 0,
      repos_updated: 0,
      commits_indexed: 0,
      branches_indexed: 0,
      tags_indexed: 0,
      duration_ms: 0,
    };
    const hookSummary = {
      installed: result.hooks.installed,
      updated: result.hooks.updated,
      unchanged: result.hooks.unchanged,
      skipped: result.hooks.skipped,
    };
    if (opts.json) {
      console.log(JSON.stringify({ ...scan, hooks: hookSummary }, null, 2));
    } else {
      console.log(chalk.green(`\n✓ Scan complete in ${(scan.duration_ms / 1000).toFixed(1)}s`));
      console.log(`  Repos found: ${scan.repos_found} (${scan.repos_new} new, ${scan.repos_updated} updated)`);
      console.log(`  Commits indexed: ${scan.commits_indexed}`);
      console.log(`  Branches indexed: ${scan.branches_indexed}`);
      console.log(`  Tags indexed: ${scan.tags_indexed}`);
      console.log(`  Hooks: ${hookSummary.installed} installed, ${hookSummary.updated} updated, ${hookSummary.unchanged} unchanged`);
    }
  });

// ── Watch ──
program
  .command("watch")
  .description("Run the workspace auto-index worker (new repos + post-commit re-indexing)")
  .option("--root <paths...>", "Root directories to watch")
  .option("--filter <name>", "Use a saved filter alias to get root paths")
  .option("--full", "Full re-index on change (not incremental)")
  .option("-w, --workers <n>", "Number of parallel workers for bootstrap scans", "4")
  .action(async (opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config.`));
      process.exit(1);
    }
    const roots = alias?.paths ?? opts.root;
    console.log(chalk.blue("Starting auto-index worker..."));
    const worker = await startAutoIndexWorker(roots, {
      full: opts.full,
      workers: intFlag(opts.workers, "--workers", 1),
      onProgress: (msg) => console.log(chalk.dim(msg)),
    });

    process.on("SIGINT", () => {
      worker.stop();
      process.exit(0);
    });
  });

// ── Repos ──
program
  .command("repos")
  .description("List repositories")
  .option("--filter <name>", "Use a saved filter alias from config")
  .option("--org <org>", "Filter by org (also: --oss, --xyz, --studio, --tools, --ai, --education, --family)")
  .option("--oss", "Filter by hasna org (shorthand)")
  .option("--xyz", "Filter by hasnaxyz org (shorthand)")
  .option("--studio", "Filter by hasnastudio org (shorthand)")
  .option("--tools", "Filter by hasnatools org (shorthand)")
  .option("--ai", "Filter by hasnaai org (shorthand)")
  .option("--education", "Filter by hasnaeducation org (shorthand)")
  .option("--family", "Filter by hasnafamily org (shorthand)")
  .option("-q, --query <query>", "Filter by name")
  .option("-n, --limit <n>", "Max results", "50")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const org = alias?.org ?? (opts.oss ? "hasna" : opts.xyz ? "hasnaxyz" : opts.studio ? "hasnastudio" : opts.tools ? "hasnatools" : opts.ai ? "hasnaai" : opts.education ? "hasnaeducation" : opts.family ? "hasnafamily" : (opts.org ? ORG_ALIASES[opts.org] ?? opts.org : undefined));
    const query = alias?.query ?? opts.query;
    const repos = listRepos({ org, query, limit: intFlag(opts.limit, "--limit", 1), offset: intFlag(opts.offset, "--offset", 0) });
    if (opts.json) {
      console.log(JSON.stringify(repos, null, 2));
    } else {
      if (repos.length === 0) { console.log(chalk.dim("No repos found. Run: repos scan")); return; }
      for (const r of repos) {
        const org = r.org ? chalk.blue(`[${r.org}]`) : "";
        console.log(`${chalk.bold(r.name)} ${org} ${chalk.dim(r.path)}`);
        if (r.description) console.log(chalk.dim(`  ${r.description}`));
        console.log(chalk.dim(`  ${r.commit_count} commits, ${r.branch_count} branches, ${r.tag_count} tags`));
      }
      console.log(chalk.dim(`\n${repos.length} repo(s)`));
    }
  });

program
  .command("repo <name>")
  .description("Get repo details")
  .option("--json", "Output as JSON")
  .action((name, opts) => {
    const repo = requireRepo(name);
    const stats = getRepoStats(repo.id);
    if (opts.json) {
      console.log(JSON.stringify({ ...repo, ...stats }, null, 2));
    } else {
      console.log(chalk.bold(repo.name));
      console.log(`  Path: ${repo.path}`);
      if (repo.org) console.log(`  Org: ${chalk.blue(repo.org)}`);
      if (repo.remote_url) console.log(`  Remote: ${repo.remote_url}`);
      console.log(`  Branch: ${repo.default_branch}`);
      console.log(`  Commits: ${stats.commit_count}, Branches: ${stats.branch_count}, Tags: ${stats.tag_count}, PRs: ${stats.pr_count}`);
      if (stats.top_authors.length > 0) {
        console.log(chalk.dim("\n  Top authors:"));
        for (const a of stats.top_authors.slice(0, 5)) {
          console.log(`    ${a.author} (${a.count} commits)`);
        }
      }
      if (stats.recent_commits.length > 0) {
        console.log(chalk.dim("\n  Recent commits:"));
        for (const c of stats.recent_commits.slice(0, 5)) {
          console.log(`    ${chalk.yellow(c.sha.slice(0, 8))} ${c.message.slice(0, 80)} ${chalk.dim(c.date.slice(0, 10))}`);
        }
      }
    }
  });

// ── Commits ──
program
  .command("commits")
  .description("List commits")
  .option("--repo <name>", "Filter by repo name")
  .option("--author <author>", "Filter by author")
  .option("--since <date>", "After date")
  .option("--until <date>", "Before date")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const commits = listCommits({ repo_id, author: opts.author, since: opts.since, until: opts.until, limit: intFlag(opts.limit, "--limit", 1) });
    if (opts.json) {
      console.log(JSON.stringify(commits, null, 2));
    } else {
      for (const c of commits) {
        console.log(`${chalk.yellow(c.sha.slice(0, 8))} ${c.message.slice(0, 100)}`);
        console.log(chalk.dim(`  ${c.author_name} <${c.author_email}> ${c.date.slice(0, 19)} (+${c.insertions}/-${c.deletions})`));
      }
      console.log(chalk.dim(`\n${commits.length} commit(s)`));
    }
  });

// ── Branches ──
program
  .command("branches")
  .description("List branches")
  .option("--repo <name>", "Filter by repo")
  .option("--remote", "Only remote branches")
  .option("--local", "Only local branches")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const is_remote = opts.remote ? true : opts.local ? false : undefined;
    const branches = listBranches({ repo_id, is_remote });
    if (opts.json) {
      console.log(JSON.stringify(branches, null, 2));
    } else {
      for (const b of branches) {
        const remote = b.is_remote ? chalk.dim(" (remote)") : "";
        console.log(`  ${chalk.green(b.name)}${remote} ${chalk.dim(b.last_commit_sha?.slice(0, 8) || "")}`);
      }
      console.log(chalk.dim(`\n${branches.length} branch(es)`));
    }
  });

// ── Tags ──
program
  .command("tags")
  .description("List tags")
  .option("--repo <name>", "Filter by repo")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const tags = listTags({ repo_id });
    if (opts.json) {
      console.log(JSON.stringify(tags, null, 2));
    } else {
      for (const t of tags) {
        console.log(`  ${chalk.cyan(t.name)} ${chalk.yellow(t.sha.slice(0, 8))} ${chalk.dim(t.date?.slice(0, 10) || "")}`);
      }
      console.log(chalk.dim(`\n${tags.length} tag(s)`));
    }
  });

// ── PRs ──
program
  .command("prs")
  .description("List pull requests")
  .option("--repo <name>", "Filter by repo")
  .option("--state <state>", "Filter: open, closed, merged")
  .option("--author <author>", "Filter by author")
  .option("--mine", "Show only your PRs (via gh)")
  .option("--review", "Show PRs awaiting your review (via gh)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    // Handle --mine and --review flags
    let author = opts.author;
    if (opts.mine || opts.review) {
      try {
        const ghUser = execSync("gh api user -q .login", { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (opts.mine) author = ghUser;
        if (opts.review) {
          // For --review, get PRs where user is requested reviewer
          const reviewJson = execSync(`gh search prs --review-requested=${ghUser} --state=open --limit=50 --json repository,number,title,author,createdAt,url`, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
          const reviews = JSON.parse(reviewJson || "[]");
          if (opts.json) { console.log(JSON.stringify(reviews, null, 2)); return; }
          if (reviews.length === 0) { console.log(chalk.dim("No PRs awaiting your review")); return; }
          console.log(chalk.bold(`${reviews.length} PR(s) awaiting review:`));
          for (const pr of reviews) {
            console.log(`  ${chalk.green("[open]")} ${pr.repository.nameWithOwner}#${pr.number} ${pr.title}`);
            console.log(chalk.dim(`    by ${pr.author?.login || "?"} ${pr.createdAt?.slice(0, 10) || ""}`));
          }
          return;
        }
      } catch { /* gh not available */ }
    }
    const prs = listPullRequests({ repo_id, state: opts.state, author });
    if (opts.json) {
      console.log(JSON.stringify(prs, null, 2));
    } else {
      for (const pr of prs) {
        const stateColor = pr.state === "open" ? chalk.green : pr.state === "merged" ? chalk.magenta : chalk.red;
        console.log(`  ${stateColor(`[${pr.state}]`)} #${pr.number} ${pr.title}`);
        console.log(chalk.dim(`    by ${pr.author} ${pr.created_at.slice(0, 10)} +${pr.additions}/-${pr.deletions}`));
      }
      console.log(chalk.dim(`\n${prs.length} PR(s)`));
    }
  });

// ── Search ──
program
  .command("search <query>")
  .description("Search across all repos, commits, and PRs")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const results = searchAll(query, intFlag(opts.limit, "--limit", 1));
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) { console.log(chalk.dim("No results")); return; }
      for (const r of results) {
        const typeColor = r.type === "repo" ? chalk.blue : r.type === "commit" ? chalk.yellow : chalk.magenta;
        console.log(`${typeColor(`[${r.type}]`)} ${chalk.bold(r.title)} ${chalk.dim(`(${r.repo_name})`)}`);
        console.log(chalk.dim(`  ${r.snippet}`));
      }
      console.log(chalk.dim(`\n${results.length} result(s)`));
    }
  });

// ── Stats ──
program
  .command("stats")
  .description("Show global stats")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stats = getGlobalStats();
    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(chalk.bold("Global Stats"));
      console.log(`  Repos: ${stats.total_repos}`);
      console.log(`  Commits: ${stats.total_commits}`);
      console.log(`  Branches: ${stats.total_branches}`);
      console.log(`  Tags: ${stats.total_tags}`);
      console.log(`  PRs: ${stats.total_prs}`);
      if (Object.keys(stats.repos_by_org).length > 0) {
        console.log(chalk.dim("\nBy org:"));
        for (const [org, count] of Object.entries(stats.repos_by_org)) {
          console.log(`  ${chalk.blue(org)}: ${count} repos`);
        }
      }
      if (stats.most_active_repos.length > 0) {
        console.log(chalk.dim("\nMost active:"));
        for (const r of stats.most_active_repos.slice(0, 5)) {
          console.log(`  ${r.name}: ${r.commits} commits`);
        }
      }
    }
  });

// ── Status ──
program
  .command("status")
  .description("Show metadata-only workspace inventory status")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const status = getReposStatus();
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log(chalk.bold("Workspace Inventory Status"));
    console.log(`  Package:  ${status.package.version}`);
    console.log(`  Repos:    ${status.counts.repos.total} (${status.counts.repos.scanned} scanned, ${status.counts.repos.unscanned} unscanned)`);
    console.log(`  Remotes:  ${status.counts.repos.withRemote} configured, ${status.counts.repos.withCredentialLikeRemote} credential-like`);
    console.log(`  Commits:  ${status.counts.commits}`);
    console.log(`  Branches: ${status.counts.branches.total}`);
  });

// ── Analytics ──
program
  .command("activity")
  .description("Show recent activity across repos")
  .option("--days <n>", "Look back N days", "7")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const activity = getRecentActivity(intFlag(opts.days, "--days", 1));
    if (opts.json) {
      console.log(JSON.stringify(activity, null, 2));
    } else {
      console.log(chalk.bold(`Activity in last ${opts.days} days:`));
      for (const r of activity) {
        console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits`);
        console.log(chalk.dim(`    Authors: ${r.authors.join(", ")}`));
      }
    }
  });

program
  .command("contributors")
  .description("Show top contributors")
  .option("--repo <name>", "Filter by repo")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const contributors = getContributorStats({ repo_id, limit: intFlag(opts.limit, "--limit", 1) });
    if (opts.json) {
      console.log(JSON.stringify(contributors, null, 2));
    } else {
      console.log(chalk.bold("Top Contributors:"));
      for (const c of contributors) {
        console.log(`  ${chalk.bold(c.author_name)} <${c.author_email}>`);
        console.log(chalk.dim(`    ${c.commit_count} commits, +${c.insertions}/-${c.deletions}, ${c.repos.length} repos`));
      }
    }
  });

program
  .command("stale")
  .description("Show stale repos (no recent commits)")
  .option("--days <n>", "Stale threshold in days", "30")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stale = getStaleRepos(intFlag(opts.days, "--days", 1));
    if (opts.json) {
      console.log(JSON.stringify(stale, null, 2));
    } else {
      console.log(chalk.bold(`Repos with no commits in ${opts.days}+ days:`));
      for (const r of stale) {
        const lastDate = r.last_commit_date ? r.last_commit_date.slice(0, 10) : "never";
        console.log(`  ${chalk.yellow(r.name)} — last commit: ${lastDate} (${r.days_stale || "∞"} days ago)`);
      }
      console.log(chalk.dim(`\n${stale.length} stale repo(s)`));
    }
  });

program
  .command("heatmap")
  .description("Show commit activity heatmap")
  .option("--repo <name>", "Filter by repo")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const heatmap = getActivityHeatmap(repo_id);
    if (opts.json) {
      console.log(JSON.stringify(heatmap, null, 2));
    } else {
      console.log(chalk.bold("Commit Activity Heatmap"));
      console.log(`Total: ${heatmap.total} commits`);
      console.log(`Most active day: ${heatmap.most_active_day}`);
      console.log(`Most active hour: ${heatmap.most_active_hour}:00`);
    }
  });

// ── GitHub Sync ──
program
  .command("sync-github")
  .description("Sync PRs and metadata from GitHub")
  .option("--repo <name>", "Sync specific repo")
  .option("--org <org>", "Sync repos for a specific org")
  .option("-n, --limit <n>", "Max PRs per repo", "100")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (opts.repo) {
      try {
        const result = syncGithubPRs(opts.repo, { limit: intFlag(opts.limit, "--limit", 1) });
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(chalk.green(`✓ Synced ${result.synced} PRs for ${result.repo_name}`));
        }
      } catch (err: any) {
        console.log(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    } else {
      const result = syncAllGithubPRs({
        org: opts.org,
        limit: intFlag(opts.limit, "--limit", 1),
        onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(chalk.green(`\n✓ Synced ${result.total_synced} PRs across ${result.repos_synced} repos`));
        if (result.errors.length > 0) {
          console.log(chalk.yellow(`  ${result.errors.length} errors (repos without GitHub remote)`));
        }
      }
    }
  });

program
  .command("gh-catalog")
  .description("Enumerate the GitHub repository catalog for OpenLoops")
  .option("--sync", "Fetch GitHub repositories before listing")
  .option("--cache-only", "Read cache only; fail if combined with --sync")
  .option("--resume", "Resume from cached nextCursor when syncing")
  .option("--cursor <page>", "GitHub API page cursor to start from")
  .option("--max-pages <n>", "Maximum GitHub pages to sync this run")
  .option("--page-size <n>", "GitHub page size, max 100", "100")
  .option("--cache <path>", "Catalog cache path")
  .option("--stale-minutes <n>", "Minutes until synced cache is stale", "60")
  .option("--min-remaining <n>", "Minimum GitHub core rate-limit calls to preserve", "1")
  .option("--org <org>", "Filter by GitHub org/account")
  .option("--repo <repo>", "Filter by repo name or owner/name")
  .option("--language <language>", "Filter by primary language")
  .option("--package-scope <scope>", "Filter by package scope, for example @hasna")
  .option("--local-path <path>", "Filter by matched local workspace path prefix")
  .option("--tags <tags>", "Comma-separated topic or loop tag filters")
  .option("--include-archived", "Include archived repositories")
  .option("--include-disabled", "Include disabled repositories")
  .option("-n, --limit <n>", "Max records to return", "100")
  .option("-o, --offset <n>", "Skip first N matched records", "0")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (opts.sync && opts.cacheOnly) {
      console.error(chalk.red("Error: --sync and --cache-only cannot be combined"));
      process.exit(1);
    }

    try {
      const envelope = enumerateGithubRepoCatalog({
        cachePath: opts.cache,
        sync: Boolean(opts.sync),
        resume: Boolean(opts.resume),
        cursor: opts.cursor,
        maxPages: optionalIntFlag(opts.maxPages, "--max-pages", 1),
        pageSize: optionalIntFlag(opts.pageSize, "--page-size", 1),
        staleMs: intFlag(opts.staleMinutes, "--stale-minutes", 1) * 60_000,
        minRemaining: optionalIntFlag(opts.minRemaining, "--min-remaining", 0),
        limit: intFlag(opts.limit, "--limit", 1),
        offset: intFlag(opts.offset, "--offset", 0),
        filter: {
          org: opts.org,
          repo: opts.repo,
          language: opts.language,
          packageScope: opts.packageScope,
          localPath: opts.localPath,
          tags: csvFlag(opts.tags),
          includeArchived: Boolean(opts.includeArchived),
          includeDisabled: Boolean(opts.includeDisabled),
        },
      });

      if (opts.json) {
        console.log(JSON.stringify(envelope, null, 2));
        return;
      }

      console.log(chalk.bold("GitHub Repository Catalog"));
      console.log(`  Records: ${envelope.page.count}/${envelope.page.total}`);
      console.log(`  Cache:   ${envelope.source.cachePath}`);
      console.log(`  Synced:  ${envelope.source.cacheSyncedAt ?? "never"}`);
      console.log(`  Stale:   ${envelope.source.stale ? "yes" : "no"} (${envelope.source.staleAt ?? "unknown"})`);
      if (!envelope.source.completed && envelope.source.nextCursor) {
        console.log(`  Cursor:  ${envelope.source.nextCursor}`);
      }
      for (const warning of envelope.warnings) console.log(chalk.yellow(`  Warning: ${warning}`));
      for (const repo of envelope.repositories) {
        const local = repo.local ? chalk.dim(` ${repo.local.path}`) : "";
        console.log(`${chalk.bold(repo.full_name)} ${chalk.dim(`[${repo.visibility}]`)}${local}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

const ops = program.command("ops").description("Loop-safe operational producers");

addLoopProducerOptions(
  ops
    .command("pr-queue")
    .description("Emit normalized open PR queue items and task seeds")
    .option("--sync", "Sync GitHub PR metadata before reading the local queue")
    .option("--sync-orgs <orgs>", "Bounded comma-separated orgs to sync before reading the queue")
    .option("--sync-max-repos <n>", "Required maximum GitHub repositories to sync when using --sync-orgs")
    .option("--allow-sync-errors", "Keep exit code zero even if GitHub sync reports errors")
    .option("--org <org>", "Filter by GitHub org")
    .option("--repo <repo>", "Filter by repo name or local path")
    .option("--state <state>", "Filter PR state", "open")
    .option("-n, --limit <n>", "Maximum PRs to emit", "100")
    .option("--json", "Output JSON")
    .addHelpText("after", "\nLoop use: add --sync-orgs hasna,hasnaxyz --sync-max-repos 80 --report-dir <dir> --upsert-tasks --todos-project <path> --task-list repo-pr-merge-queue."),
  50,
)
  .action((opts: LoopProducerOpts & {
    sync?: boolean;
    syncOrgs?: string;
    syncMaxRepos?: string;
    allowSyncErrors?: boolean;
    org?: string;
    repo?: string;
    state?: string;
    limit: string;
    json?: boolean;
  }) => {
    const syncOrgs = csvFlag(opts.syncOrgs);
    const syncMaxRepos = optionalIntFlag(opts.syncMaxRepos, "--sync-max-repos", 1);
    if (syncOrgs?.length && !syncMaxRepos) {
      console.error(chalk.red("Error: --sync-orgs requires --sync-max-repos to keep multi-repo sync bounded."));
      process.exit(1);
    }
    const result = buildPrQueue({
      sync: Boolean(opts.sync || syncOrgs),
      syncOrgs,
      syncMaxRepos,
      org: opts.org,
      repo: opts.repo,
      state: opts.state,
      limit: intFlag(opts.limit, "--limit", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "repo-pr-queue",
      taskList: "repo-pr-merge-queue",
      taskListName: "Repo PR Merge Queue",
      taskListDescription: "Open PR tasks created by deterministic OpenRepos producers and consumed by headless worker/verifier workflows.",
    });
    if (opts.json) {
      console.log(JSON.stringify(envelope, null, 2));
      if (loopProducerHadErrors(envelope) || syncFailed(result.synced, opts.allowSyncErrors)) process.exitCode = 1;
      return;
    }
    console.log(chalk.bold(`PR queue: ${result.summary.items} item(s), ${result.summary.task_seeds} task seed(s)`));
    if (result.synced) {
      console.log(chalk.dim(`synced repos=${result.synced.repos_synced}/${result.synced.repos_checked} prs=${result.synced.total_synced} truncated=${result.synced.truncated ? "yes" : "no"} errors=${result.synced.errors.length}`));
    }
    for (const item of result.items.slice(0, 50)) {
      console.log(`${chalk.green(item.repo.full_name)}#${item.pr.number} ${item.pr.title}`);
      console.log(chalk.dim(`  ${item.repo.path}`));
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope) || syncFailed(result.synced, opts.allowSyncErrors)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("global-cli-smoke")
    .description("Smoke-check globally installed CLIs used by agents")
    .option("--commands <names>", "Comma-separated command names to check")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--json", "Output JSON"),
  20,
)
  .action((opts: LoopProducerOpts & { commands?: string; timeoutMs: string; json?: boolean }) => {
    const result = runGlobalCliSmoke({
      commands: csvFlag(opts.commands),
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "global-cli-smoke",
      taskList: "global-cli-smoke",
      taskListName: "Global CLI Smoke",
      taskListDescription: "CLI availability failures created by deterministic OpenRepos smoke checks.",
    });
    if (opts.json) {
      console.log(JSON.stringify(envelope, null, 2));
      if (result.summary.failed > 0 || result.summary.missing > 0 || loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.failed === 0 && result.summary.missing === 0 ? chalk.green("ok") : chalk.red("issues");
    console.log(`${status} checked=${result.summary.checked} ok=${result.summary.ok} failed=${result.summary.failed} missing=${result.summary.missing}`);
    for (const row of result.commands.filter((command) => command.status !== "ok").slice(0, 30)) {
      console.log(`${row.status === "missing" ? chalk.yellow("missing") : chalk.red("failed")} ${row.command} ${chalk.dim(row.stderr_preview)}`);
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (result.summary.failed > 0 || result.summary.missing > 0 || loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

ops
  .command("package-hygiene")
  .description("Inspect Hasna global package manager hygiene")
  .option("--scope <scopes>", "Comma-separated package scopes", "@hasna,@hasnaxyz")
  .option("--no-npm-global", "Skip npm global duplicate inspection")
  .option("--timeout-ms <n>", "Per-command timeout", "20000")
  .option("--json", "Output JSON")
  .action((opts: { scope: string; npmGlobal?: boolean; timeoutMs: string; json?: boolean }) => {
    const result = inspectPackageHygiene({
      scopes: csvFlag(opts.scope),
      includeNpmGlobal: opts.npmGlobal !== false,
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const status = result.summary.scoped_npm_duplicates === 0 ? chalk.green("ok") : chalk.yellow("review");
    console.log(`${status} bun=${result.summary.bun_packages_seen} npm=${result.summary.npm_packages_seen} duplicates=${result.summary.scoped_npm_duplicates} task_seeds=${result.summary.task_seeds}`);
    for (const row of result.npm_global_duplicates.slice(0, 30)) {
      console.log(`${chalk.yellow(row.name)}${row.version ? chalk.dim(`@${row.version}`) : ""}`);
    }
  });

// ── GitHub Metadata ──
program
  .command("gh-info <name>")
  .description("Fetch GitHub metadata for a repo")
  .option("--json", "Output as JSON")
  .action((name, opts) => {
    const meta = fetchRepoMetadata(name);
    if (!meta) { console.log(chalk.red("Cannot fetch metadata (no GitHub remote?)")); process.exit(1); }
    if (opts.json) {
      console.log(JSON.stringify(meta, null, 2));
    } else {
      if (meta.description) console.log(`Description: ${meta.description}`);
      if (meta.language) console.log(`Language: ${meta.language}`);
      console.log(`Stars: ${meta.stars}, Forks: ${meta.forks}`);
      if (meta.topics.length > 0) console.log(`Topics: ${meta.topics.join(", ")}`);
    }
  });

// ── Find ──
program
  .command("find <file>")
  .description("Find a file across all repos")
  .option("-n, --limit <n>", "Max repos", "50")
  .option("--json", "Output as JSON")
  .action((file, opts) => {
    const results = findFile(file, intFlag(opts.limit, "--limit", 1));
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("Not found in any repo")); return; }
    for (const r of results) {
      console.log(chalk.bold(r.repo_name));
      for (const m of r.matches.slice(0, 5)) console.log(chalk.dim(`  ${m}`));
      if (r.matches.length > 5) console.log(chalk.dim(`  ... and ${r.matches.length - 5} more`));
    }
    console.log(chalk.dim(`\nFound in ${results.length} repo(s)`));
  });

// ── Who ──
program
  .command("who <query>")
  .description("Find author activity across all repos")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const results = whoIs(query);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("No commits found for that author")); return; }
    console.log(chalk.bold(`Author: ${query}`));
    for (const r of results) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      console.log(chalk.dim(`    ${r.first_commit.slice(0, 10)} → ${r.last_commit.slice(0, 10)}`));
    }
  });

// ── Diff Stats ──
program
  .command("diff-stats")
  .description("What changed recently across repos")
  .option("--today", "Today only")
  .option("--week", "Last 7 days")
  .option("--days <n>", "Custom days", "1")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const days = opts.week ? 7 : opts.today ? 1 : intFlag(opts.days, "--days", 1);
    const results = diffStats(days);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim(`No activity in last ${days} day(s)`)); return; }
    console.log(chalk.bold(`Activity in last ${days} day(s):`));
    for (const r of results) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      console.log(chalk.dim(`    Authors: ${r.authors.join(", ")}`));
    }
  });

// ── Dirty ──
program
  .command("dirty")
  .description("List repos with uncommitted changes")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const dirty = getDirtyRepos();
    if (opts.json) { console.log(JSON.stringify(dirty, null, 2)); return; }
    if (dirty.length === 0) { console.log(chalk.green("✓ All repos clean")); return; }
    console.log(chalk.bold(`${dirty.length} dirty repo(s):`));
    for (const r of dirty) {
      const parts = [];
      if (r.modified) parts.push(chalk.yellow(`${r.modified} modified`));
      if (r.untracked) parts.push(chalk.red(`${r.untracked} untracked`));
      if (r.staged) parts.push(chalk.green(`${r.staged} staged`));
      console.log(`  ${chalk.bold(r.repo_name)}: ${parts.join(", ")}`);
    }
  });

// ── Unpushed ──
program
  .command("unpushed")
  .description("List repos with unpushed commits")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const unpushed = getUnpushedRepos();
    if (opts.json) { console.log(JSON.stringify(unpushed, null, 2)); return; }
    if (unpushed.length === 0) { console.log(chalk.green("✓ All repos pushed")); return; }
    console.log(chalk.bold(`${unpushed.length} repo(s) with unpushed commits:`));
    for (const r of unpushed) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.yellow(`${r.ahead} ahead`)} on ${r.branch}`);
    }
  });

// ── Behind ──
program
  .command("behind")
  .description("List repos behind remote")
  .option("--fetch", "Fetch from remote first")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const behind = getBehindRepos(opts.fetch);
    if (opts.json) { console.log(JSON.stringify(behind, null, 2)); return; }
    if (behind.length === 0) { console.log(chalk.green("✓ All repos up to date")); return; }
    console.log(chalk.bold(`${behind.length} repo(s) behind remote:`));
    for (const r of behind) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.red(`${r.behind} behind`)} on ${r.branch}`);
    }
  });

// ── Health ──
program
  .command("health")
  .description("Combined health check: dirty + unpushed + behind + stale")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const report = getHealthReport();
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }

    const issues = report.dirty.length + report.unpushed.length + report.behind.length + report.stale.length;
    if (issues === 0) { console.log(chalk.green("✓ All repos healthy")); return; }

    if (report.dirty.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.dirty.length} dirty repo(s):`));
      for (const r of report.dirty.slice(0, 10)) console.log(`    ${r.repo_name} (${r.modified}M ${r.untracked}U ${r.staged}S)`);
    }
    if (report.unpushed.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.unpushed.length} repo(s) with unpushed commits:`));
      for (const r of report.unpushed.slice(0, 10)) console.log(`    ${r.repo_name} (${r.ahead} ahead on ${r.branch})`);
    }
    if (report.behind.length > 0) {
      console.log(chalk.red(`\n✗ ${report.behind.length} repo(s) behind remote:`));
      for (const r of report.behind.slice(0, 10)) console.log(`    ${r.repo_name} (${r.behind} behind on ${r.branch})`);
    }
    if (report.stale.length > 0) {
      console.log(chalk.dim(`\n○ ${report.stale.length} stale repo(s) (30+ days):`));
      for (const r of report.stale.slice(0, 10)) console.log(`    ${r.repo_name} (${r.days_stale} days)`);
    }
  });

// ── CD / Open ──
program
  .command("cd <name>")
  .description("Print repo path (use: cd $(repos cd open-todos))")
  .action((name) => {
    const path = getRepoPath(name);
    if (!path) { console.error("Repo not found"); process.exit(1); }
    console.log(path);
  });

program
  .command("open <name>")
  .description("Open repo in VS Code")
  .action((name) => {
    const path = getRepoPath(name);
    if (!path) { console.error("Repo not found"); process.exit(1); }
    execSync(`code "${path}"`);
  });

// ── Report ──
program
  .command("report")
  .description("Weekly summary report")
  .option("--days <n>", "Look back N days", "7")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const report = getReport(intFlag(opts.days, "--days", 1));
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(chalk.bold(`Report: ${report.period}`));
    console.log(`  Repos touched: ${report.repos_touched}`);
    console.log(`  Commits: ${report.total_commits}`);
    console.log(`  LOC: +${report.total_insertions} / -${report.total_deletions}`);
    if (report.top_repos.length > 0) {
      console.log(chalk.dim("\n  Top repos:"));
      for (const r of report.top_repos.slice(0, 5)) console.log(`    ${r.name}: ${r.commits} commits`);
    }
    if (report.top_authors.length > 0) {
      console.log(chalk.dim("\n  Top authors:"));
      for (const a of report.top_authors.slice(0, 5)) console.log(`    ${a.author}: ${a.commits} commits`);
    }
  });

// ── Churn ──
program
  .command("churn")
  .description("Most frequently changed files across repos")
  .option("--days <n>", "Look back N days", "30")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const results = getChurn(intFlag(opts.days, "--days", 1), intFlag(opts.limit, "--limit", 1));
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("No file changes found")); return; }
    console.log(chalk.bold("Most changed files:"));
    for (const r of results) {
      console.log(`  ${chalk.yellow(`${r.change_count}x`)} ${r.file} ${chalk.dim(`(${r.repo_name})`)}`);
    }
  });

// ── Languages ──
program
  .command("languages")
  .description("Language breakdown per org")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const languages = getLanguages();
    if (opts.json) { console.log(JSON.stringify(languages, null, 2)); return; }
    console.log(chalk.bold("Languages:"));
    for (const l of languages) {
      const orgStr = Object.entries(l.orgs).map(([o, c]) => `${o}:${c}`).join(", ");
      console.log(`  ${chalk.cyan(l.language)}: ${l.repo_count} repos ${chalk.dim(`(${orgStr})`)}`);
    }
  });

// ── Import / Export ──
program
  .command("export")
  .description("Export repo list as JSON or CSV")
  .option("--csv", "Export as CSV")
  .option("--json", "Export as JSON (default)")
  .action((opts) => {
    console.log(exportRepos(opts.csv ? "csv" : "json"));
  });

program
  .command("import <org>")
  .description("Clone all repos from a GitHub org")
  .option("--dir <path>", "Target directory", ".")
  .option("--json", "Output as JSON")
  .action((org, opts) => {
    const result = importFromOrg(org, opts.dir, {
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    if (opts.json) { console.log(JSON.stringify(result)); return; }
    console.log(chalk.green(`\n✓ Cloned ${result.cloned}, skipped ${result.skipped}`));
    if (result.errors.length > 0) console.log(chalk.yellow(`  ${result.errors.length} errors`));
  });

// ── Agent Ops ──
const packageOps = program.command("package").description("Package health, drift, and bin resolution primitives");

addOpsOptions(packageOps
  .command("health [path]")
  .description("Check package.json, scripts, bins, and lockfiles (compact JSON default)"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getPackageHealth({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(packageOps
  .command("drift [path]")
  .description("Check package.json versus bun.lock drift (compact JSON default)"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getPackageDrift({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(packageOps
  .command("resolve-bin [name]")
  .description("Resolve a package bin from package.json, node_modules/.bin, or PATH")
  .option("--path <path>", "Package root", "."))
  .action((name: string | undefined, opts: any) => {
    const cwd = opts.path ?? process.cwd();
    const report = withTodos(
      resolvePackageBin({ cwd, name, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const portsOps = program.command("ports").description("Local port inspection primitives");

addOpsOptions(portsOps
  .command("scan [path]")
  .description("Scan listening TCP ports and annotate ports referenced by package scripts")
  .option("--port <n>", "Only return one port"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const port = opts.port === undefined ? undefined : intFlag(opts.port, "--port", 1);
    const report = withTodos(
      scanPorts({ cwd, port, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const triageOps = program.command("triage").description("Branch and pull request triage primitives");

addOpsOptions(triageOps
  .command("branches [path]")
  .description("Triage current git branch, dirty state, stale branches, and merged branches")
  .option("--stale-days <n>", "Stale local branch threshold", "30"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      triageBranches({
        cwd,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(triageOps
  .command("prs [path]")
  .description("Triage GitHub pull requests via gh")
  .option("--state <state>", "PR state passed to gh", "open")
  .option("--stale-days <n>", "Stale PR threshold", "14"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      triagePullRequests({
        cwd,
        state: opts.state,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const docsOps = program.command("docs").description("Documentation drift primitives");

addOpsOptions(docsOps
  .command("drift [path]")
  .description("Check README coverage for package name, bins, and agent ops commands"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getDocsDrift({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const releaseOps = program.command("release").description("Release readiness primitives");

addOpsOptions(releaseOps
  .command("health [path]")
  .description("Combine package, drift, docs, and branch checks for release readiness")
  .option("--no-git", "Skip git branch checks")
  .option("--stale-days <n>", "Stale local branch threshold", "30"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getReleaseHealth({
        cwd,
        includeGit: opts.git,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(program
  .command("release-health [path]")
  .description("Alias for release health"))
  .option("--no-git", "Skip git branch checks")
  .option("--stale-days <n>", "Stale local branch threshold", "30")
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getReleaseHealth({
        cwd,
        includeGit: opts.git,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const noCloudOps = program.command("no-cloud").description("No-cloud migration inventory primitives");

noCloudOps
  .command("inventory [path]")
  .description("Scan git repos for legacy Hasna cloud references and optional npm latest metadata")
  .option("-n, --limit <n>", "Max returned repos/npm packages", "200")
  .option("--max-depth <n>", "Max directory depth when discovering git roots", "8")
  .option("--include-npm", "Also query npm latest metadata for known @hasna packages")
  .option("--npm-package <name>", "Package name for npm metadata checks; repeat or comma-separate for multiple", collectValues, [])
  .option("--pretty", "Pretty-print JSON")
  .action((path: string | undefined, opts: any) => {
    const root = path ?? process.cwd();
    const report = getNoCloudInventory({
      root,
      limit: intFlag(opts.limit, "--limit", 1),
      maxDepth: intFlag(opts.maxDepth, "--max-depth", 1),
      includeNpm: Boolean(opts.includeNpm) || Boolean(opts.npmPackage?.length),
      npmPackages: opts.npmPackage,
    });
    printOpsJson(report, opts.pretty);
  });

// ── Knowledge Graph ──
const graph = program.command("graph").description("Knowledge graph commands");

graph
  .command("build")
  .description("Build knowledge graph from repo data")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const result = buildGraph({
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(chalk.green(`\n✓ Graph built in ${(result.duration_ms / 1000).toFixed(1)}s — ${result.edges_created} edges`));
    }
  });

graph
  .command("query <type> <id>")
  .description("Query a node (type: repo, author, org, language)")
  .option("--json", "Output as JSON")
  .action((type, id, opts) => {
    const node = queryNode(type, id);
    if (!node) { console.log(chalk.red("Node not found")); process.exit(1); }
    if (opts.json) {
      console.log(JSON.stringify(node, null, 2));
    } else {
      console.log(chalk.bold(`${node.type}: ${node.label}`));
      console.log(chalk.dim(`  ${node.edges.length} connections:`));
      for (const e of node.edges.slice(0, 20)) {
        console.log(`    ${e.relation} → ${e.target_type}:${e.target_id} (weight: ${e.weight})`);
      }
    }
  });

graph
  .command("related <repo>")
  .description("Find related repos")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const results = queryRelated(repo, intFlag(opts.limit, "--limit", 1));
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) { console.log(chalk.dim("No related repos found. Run: repos graph build")); return; }
      console.log(chalk.bold(`Repos related to ${repo}:`));
      for (const r of results) {
        console.log(`  ${chalk.bold(r.repo_name)} — ${r.relation} (weight: ${r.weight})`);
      }
    }
  });

graph
  .command("path <from-type> <from-id> <to-type> <to-id>")
  .description("Find shortest path between two nodes")
  .option("--json", "Output as JSON")
  .action((fromType, fromId, toType, toId, opts) => {
    const path = findPath(fromType, fromId, toType, toId);
    if (!path) { console.log(chalk.red("No path found")); process.exit(1); }
    if (opts.json) {
      console.log(JSON.stringify(path, null, 2));
    } else {
      console.log(chalk.bold(`Path (${path.length} hops):`));
      for (let i = 0; i < path.nodes.length; i++) {
        const n = path.nodes[i]!;
        console.log(`  ${chalk.cyan(n.type)}:${n.id}`);
        if (i < path.edges.length) console.log(`    ↓ ${path.edges[i]!.relation}`);
      }
    }
  });

graph
  .command("deps <repo>")
  .description("Show dependency tree for a repo")
  .option("--depth <n>", "Max depth", "3")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const deps = getDeps(repo, intFlag(opts.depth, "--depth", 1));
    if (opts.json) {
      console.log(JSON.stringify(deps, null, 2));
    } else {
      if (deps.length === 0) { console.log(chalk.dim("No dependencies found")); return; }
      console.log(chalk.bold(`Dependencies of ${repo}:`));
      for (const d of deps) {
        const indent = "  ".repeat(d.depth);
        console.log(`${indent}└── ${d.repo_name}`);
      }
    }
  });

graph
  .command("authors")
  .description("Show authors who work across multiple orgs")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const authors = getCrossOrgAuthors();
    if (opts.json) {
      console.log(JSON.stringify(authors, null, 2));
    } else {
      console.log(chalk.bold("Cross-org authors:"));
      for (const a of authors) {
        console.log(`  ${chalk.bold(a.author_email)} — ${a.orgs.join(", ")} (${a.total_commits} commits)`);
      }
    }
  });

graph
  .command("stats")
  .description("Show graph statistics")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stats = getGraphStats();
    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(chalk.bold(`Graph: ${stats.total_edges} edges`));
      console.log(chalk.dim("\nBy relation:"));
      for (const [rel, count] of Object.entries(stats.by_relation)) {
        console.log(`  ${rel}: ${count}`);
      }
      console.log(chalk.dim("\nBy source type:"));
      for (const [type, count] of Object.entries(stats.by_source_type)) {
        console.log(`  ${type}: ${count}`);
      }
    }
  });

// ── Shell Completions ──
const completions = program.command("completions").description("Output shell completion script");

completions
  .command("bash", { isDefault: true })
  .description("Generate bash completion script")
  .action(() => {
    const cmds = collectCommands(program);
    const subs = cmds.filter((c) => !c.startsWith("graph ")).map((c) => `"${c}"`).join(" ");
    console.log(`#!/usr/bin/env bash
_repos()
{
  local cur="\${3}"
  local cmds="${subs}"
  COMPREPLY=(\$(compgen -W "\${cmds}" -- "\${cur}"))
}
complete -F _repos repos`);
  });

completions
  .command("zsh")
  .description("Generate zsh completion script")
  .action(() => {
    const cmds = collectCommands(program).map((c) => `"${c}"`).join("\n");
    console.log(`#compdef repos
local -a cmds=(
${cmds}
)
_describe 'command' cmds`);
  });

completions
  .command("fish")
  .description("Generate fish completion script")
  .action(() => {
    const cmds = collectCommands(program).map((c) => `    ${c}`).join("\n");
    console.log(`# fish completion for repos
complete -c repos -f -a '
${cmds}
'`);
  });

// ── Backup ──
program
  .command("backup [path]")
  .description("Backup the repos database to a file (default: repos-backup-{date}.db)")
  .option("--json", "Output as JSON")
  .action(async (path, opts) => {
    const { getDbPath } = await import("../db/database.js");
    const { dirname, join } = await import("node:path");
    const { existsSync, copyFileSync, mkdirSync } = await import("node:fs");
    const src = getDbPath();
    const dest = path || join(
      dirname(src),
      `repos-backup-${new Date().toISOString().slice(0, 10)}.db`
    );
    const destDir = dirname(dest);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, source: src, backup: dest }));
    } else {
      console.log(chalk.green(`✓ Backed up ${src} → ${dest}`));
    }
  });

// ── Restore ──
program
  .command("restore <path>")
  .description("Restore the repos database from a backup file")
  .option("--force", "Overwrite existing database without prompting")
  .option("--json", "Output as JSON")
  .action(async (src, opts) => {
    const { getDbPath } = await import("../db/database.js");
    const { existsSync, copyFileSync } = await import("node:fs");
    if (!existsSync(src)) {
      const msg = `Backup file not found: ${src}`;
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(chalk.red(msg));
      process.exit(1);
    }
    const dest = getDbPath();
    if (existsSync(dest) && !opts.force) {
      process.stdout.write(chalk.yellow(`This will overwrite ${dest}. Continue? [y/N] `));
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });
      if (answer.toLowerCase() !== "y") {
        if (opts.json) console.log(JSON.stringify({ ok: false, cancelled: true }));
        else console.log(chalk.yellow("Restore cancelled."));
        process.exit(0);
      }
    }
    copyFileSync(src, dest);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, restored: dest, from: src }));
    } else {
      console.log(chalk.green(`✓ Restored ${dest} from ${src}`));
    }
  });

function collectCommands(cmd: any, prefix = ""): string[] {
  const results: string[] = [];
  if (cmd.commands) {
    for (const sub of cmd.commands) {
      const name = prefix + sub.name();
      results.push(name);
      results.push(...collectCommands(sub, name + " "));
    }
  }
  return results;
}

await bootstrapCliIfNeeded(process.argv.slice(2));
registerEventsCommands(program, { source: "repos" });
await program.parseAsync(process.argv);
