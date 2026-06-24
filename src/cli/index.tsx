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
import { getActivityHeatmap, getContributorStats, getStaleRepos, getRecentActivity } from "../lib/analytics.js";
import { buildGraph, queryNode, queryRelated, findPath, getDeps, getCrossOrgAuthors, getGraphStats } from "../lib/graph.js";
import { findFile, whoIs, diffStats, getDirtyRepos, getUnpushedRepos, getBehindRepos, getHealthReport, getRepoPath, getReport, getChurn, getLanguages, exportRepos, importFromOrg, fuzzyFindRepo } from "../lib/utils.js";

const ORG_ALIASES: Record<string, string> = {
  oss: "hasna",
  xyz: "hasnaxyz",
  studio: "hasnastudio",
  tools: "hasnatools",
  ai: "hasnaai",
  education: "hasnaeducation",
  family: "hasnafamily",
};

const AUTO_BOOTSTRAP_SKIP_COMMANDS = new Set(["scan", "watch", "backup", "restore", "completions", "import"]);

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

const COMPACT_LIMIT = 20;

function compactText(value: unknown, max = 96): string {
  const text = String(value ?? "")
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1***@")
    .replace(/\b(token|password|secret)=([^&\s]+)/gi, "$1=***")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function compactList(values: string[], maxItems = 3, maxChars = 72): string {
  const shown = values.slice(0, maxItems).join(", ");
  const suffix = values.length > maxItems ? ` +${values.length - maxItems} more` : "";
  return compactText(`${shown}${suffix}`, maxChars);
}

function day(value?: string | null): string {
  return value ? value.slice(0, 10) : "-";
}

function resolveLimit(opts: any, humanDefault = COMPACT_LIMIT, jsonDefault = humanDefault): number {
  return intFlag(String(opts.limit ?? (opts.json ? jsonDefault : humanDefault)), "--limit", 1);
}

function resolveOffset(opts: any): number {
  const flagName = opts.cursor !== undefined ? "--cursor" : "--offset";
  return intFlag(String(opts.cursor ?? opts.offset ?? "0"), flagName, 0);
}

function printCompactHint(opts: {
  count: number;
  noun: string;
  limit?: number;
  offset?: number;
  pageable?: boolean;
  detail?: string;
  verbose?: boolean;
  json?: boolean;
}): void {
  const parts = [`Showing ${opts.count} ${opts.noun}`];
  if (opts.pageable && opts.limit && opts.count >= opts.limit) {
    parts.push(`next page: --cursor ${(opts.offset ?? 0) + opts.limit}`);
  }
  if (opts.detail) parts.push(opts.detail);
  if (!opts.verbose) parts.push("use --verbose for wider rows");
  if (!opts.json) parts.push("use --json for full records");
  console.log(chalk.dim(`\n${parts.join(". ")}.`));
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
    syncCloud: false,
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
  .option("-n, --limit <n>", "Max results (default: 20 human, 50 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show descriptions and full paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const org = alias?.org ?? (opts.oss ? "hasna" : opts.xyz ? "hasnaxyz" : opts.studio ? "hasnastudio" : opts.tools ? "hasnatools" : opts.ai ? "hasnaai" : opts.education ? "hasnaeducation" : opts.family ? "hasnafamily" : (opts.org ? ORG_ALIASES[opts.org] ?? opts.org : undefined));
    const query = alias?.query ?? opts.query;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const offset = resolveOffset(opts);
    const repos = listRepos({ org, query, limit, offset });
    if (opts.json) {
      console.log(JSON.stringify(repos, null, 2));
    } else {
      if (repos.length === 0) { console.log(chalk.dim("No repos found. Run: repos scan")); return; }
      for (const r of repos) {
        const org = r.org ? chalk.blue(`[${r.org}]`) : "";
        console.log(`${chalk.bold(r.name)} ${org} ${chalk.dim(`${r.commit_count} commits, ${r.branch_count} branches, ${r.tag_count} tags`)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`  ${compactText(r.path, 140)}`));
          if (r.description) console.log(chalk.dim(`  ${compactText(r.description, 140)}`));
        }
      }
      printCompactHint({
        count: repos.length,
        noun: "repo(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: "use `repos show <name>` for repo details",
      });
    }
  });

function printRepoDetails(name: string, opts: any) {
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
        for (const a of stats.top_authors.slice(0, opts.verbose ? 10 : 5)) {
          console.log(`    ${a.author} (${a.count} commits)`);
        }
      }
      if (stats.recent_commits.length > 0) {
        console.log(chalk.dim("\n  Recent commits:"));
        for (const c of stats.recent_commits.slice(0, opts.verbose ? 10 : 5)) {
          console.log(`    ${chalk.yellow(c.sha.slice(0, 8))} ${compactText(c.message, opts.verbose ? 160 : 80)} ${chalk.dim(day(c.date))}`);
        }
      }
      if (!opts.verbose) {
        console.log(chalk.dim("\nUse --verbose for more authors and commits, or --json for the full record."));
      }
    }
}

program
  .command("repo <name>")
  .description("Get repo details")
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

program
  .command("show <name>")
  .description("Show repo details")
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

program
  .command("inspect <name>")
  .description("Inspect repo details")
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

// ── Commits ──
program
  .command("commits")
  .description("List commits")
  .option("--repo <name>", "Filter by repo name")
  .option("--author <author>", "Filter by author")
  .option("--since <date>", "After date")
  .option("--until <date>", "Before date")
  .option("-n, --limit <n>", "Max results", "20")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show author email and diff stats on separate lines")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const offset = resolveOffset(opts);
    const commits = listCommits({ repo_id, author: opts.author, since: opts.since, until: opts.until, limit, offset });
    if (opts.json) {
      console.log(JSON.stringify(commits, null, 2));
    } else {
      for (const c of commits) {
        console.log(`${chalk.yellow(c.sha.slice(0, 8))} ${compactText(c.message, opts.verbose ? 180 : 100)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`  ${c.author_name} <${c.author_email}> ${c.date.slice(0, 19)} (+${c.insertions}/-${c.deletions})`));
        } else {
          console.log(chalk.dim(`  ${c.author_name} ${day(c.date)}`));
        }
      }
      printCompactHint({
        count: commits.length,
        noun: "commit(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use `repos show <repo>` for repo context" : "filter with --repo, --author, --since, or --until",
      });
    }
  });

// ── Branches ──
program
  .command("branches")
  .description("List branches")
  .option("--repo <name>", "Filter by repo")
  .option("--remote", "Only remote branches")
  .option("--local", "Only local branches")
  .option("-n, --limit <n>", "Max results (default: 20 human, 100 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show dates and ahead/behind counts")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const is_remote = opts.remote ? true : opts.local ? false : undefined;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 100);
    const offset = resolveOffset(opts);
    const branches = listBranches({ repo_id, is_remote, limit, offset });
    if (opts.json) {
      console.log(JSON.stringify(branches, null, 2));
    } else {
      for (const b of branches) {
        const remote = b.is_remote ? chalk.dim(" (remote)") : "";
        console.log(`  ${chalk.green(compactText(b.name, opts.verbose ? 120 : 72))}${remote} ${chalk.dim(b.last_commit_sha?.slice(0, 8) || "")}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    ${day(b.last_commit_date)} ahead ${b.ahead}, behind ${b.behind}`));
        }
      }
      printCompactHint({
        count: branches.length,
        noun: "branch(es)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use --json for full branch records" : "filter with --repo, --remote, or --local",
      });
    }
  });

// ── Tags ──
program
  .command("tags")
  .description("List tags")
  .option("--repo <name>", "Filter by repo")
  .option("-n, --limit <n>", "Max results (default: 20 human, 100 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show tag messages")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 100);
    const offset = resolveOffset(opts);
    const tags = listTags({ repo_id, limit, offset });
    if (opts.json) {
      console.log(JSON.stringify(tags, null, 2));
    } else {
      for (const t of tags) {
        console.log(`  ${chalk.cyan(compactText(t.name, 72))} ${chalk.yellow(t.sha.slice(0, 8))} ${chalk.dim(day(t.date))}`);
        if (opts.verbose && t.message) console.log(chalk.dim(`    ${compactText(t.message, 140)}`));
      }
      printCompactHint({
        count: tags.length,
        noun: "tag(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use --json for full tag records" : "filter with --repo",
      });
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
  .option("-n, --limit <n>", "Max results (default: 20 human, 50 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show author, date, diff stats, and URL")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    // Handle --mine and --review flags
    let author = opts.author;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const offset = resolveOffset(opts);
    if (opts.mine || opts.review) {
      try {
        const ghUser = execSync("gh api user -q .login", { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (opts.mine) author = ghUser;
        if (opts.review) {
          // For --review, get PRs where user is requested reviewer
          const reviewJson = execSync(`gh search prs --review-requested=${ghUser} --state=open --limit=${limit} --json repository,number,title,author,createdAt,url`, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
          const reviews = JSON.parse(reviewJson || "[]");
          if (opts.json) { console.log(JSON.stringify(reviews, null, 2)); return; }
          if (reviews.length === 0) { console.log(chalk.dim("No PRs awaiting your review")); return; }
          console.log(chalk.bold(`${reviews.length} PR(s) awaiting review:`));
          for (const pr of reviews) {
            console.log(`  ${chalk.green("[open]")} ${pr.repository.nameWithOwner}#${pr.number} ${compactText(pr.title, 100)}`);
            if (opts.verbose) console.log(chalk.dim(`    by ${pr.author?.login || "?"} ${day(pr.createdAt)} ${pr.url || ""}`));
          }
          printCompactHint({ count: reviews.length, noun: "PR(s)", limit, verbose: opts.verbose, detail: "use --json for full GitHub records" });
          return;
        }
      } catch { /* gh not available */ }
    }
    const prs = listPullRequests({ repo_id, state: opts.state, author, limit, offset });
    if (opts.json) {
      console.log(JSON.stringify(prs, null, 2));
    } else {
      for (const pr of prs) {
        const stateColor = pr.state === "open" ? chalk.green : pr.state === "merged" ? chalk.magenta : chalk.red;
        console.log(`  ${stateColor(`[${pr.state}]`)} #${pr.number} ${compactText(pr.title, opts.verbose ? 160 : 100)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    by ${pr.author} ${day(pr.created_at)} +${pr.additions}/-${pr.deletions} files ${pr.changed_files}${pr.url ? ` ${pr.url}` : ""}`));
        }
      }
      printCompactHint({
        count: prs.length,
        noun: "PR(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: "filter with --repo, --state, --author, --mine, or --review",
      });
    }
  });

// ── Search ──
program
  .command("search <query>")
  .description("Search across all repos, commits, and PRs")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show wider snippets")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const results = searchAll(query, limit);
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) { console.log(chalk.dim("No results")); return; }
      for (const r of results) {
        const typeColor = r.type === "repo" ? chalk.blue : r.type === "commit" ? chalk.yellow : chalk.magenta;
        console.log(`${typeColor(`[${r.type}]`)} ${chalk.bold(compactText(r.title, opts.verbose ? 140 : 90))} ${chalk.dim(`(${r.repo_name})`)}`);
        console.log(chalk.dim(`  ${compactText(r.snippet, opts.verbose ? 180 : 100)}`));
      }
      printCompactHint({
        count: results.length,
        noun: "result(s)",
        limit,
        verbose: opts.verbose,
        detail: "use `repos show <repo>` for repo details",
      });
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
    console.log(chalk.dim("\nMetadata only. Use --json for the stable status contract or list commands for names/details."));
  });

// ── Analytics ──
program
  .command("activity")
  .description("Show recent activity across repos")
  .option("--days <n>", "Look back N days", "7")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show more authors per row")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const activity = getRecentActivity(intFlag(opts.days, "--days", 1), limit);
    if (opts.json) {
      console.log(JSON.stringify(activity, null, 2));
    } else {
      console.log(chalk.bold(`Activity in last ${opts.days} days:`));
      for (const r of activity) {
        console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits`);
        console.log(chalk.dim(`    Authors: ${compactList(r.authors, opts.verbose ? 10 : 3, opts.verbose ? 140 : 72)}`));
      }
      printCompactHint({ count: activity.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use `repos commits --repo <name>` for commit details" });
    }
  });

program
  .command("contributors")
  .description("Show top contributors")
  .option("--repo <name>", "Filter by repo")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show repo lists for contributors")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const contributors = getContributorStats({ repo_id, limit });
    if (opts.json) {
      console.log(JSON.stringify(contributors, null, 2));
    } else {
      console.log(chalk.bold("Top Contributors:"));
      for (const c of contributors) {
        console.log(`  ${chalk.bold(compactText(c.author_name, 64))} ${chalk.dim(`${c.commit_count} commits, +${c.insertions}/-${c.deletions}, ${c.repos.length} repos`)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    ${c.author_email} ${compactList(c.repos, 10, 140)}`));
        }
      }
      printCompactHint({ count: contributors.length, noun: "contributor(s)", limit, verbose: opts.verbose, detail: opts.repo ? "use `repos commits --repo <name> --author <author>` for commits" : "filter with --repo" });
    }
  });

program
  .command("stale")
  .description("Show stale repos (no recent commits)")
  .option("--days <n>", "Stale threshold in days", "30")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show paths and orgs")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stale = getStaleRepos(intFlag(opts.days, "--days", 1));
    if (opts.json) {
      console.log(JSON.stringify(stale, null, 2));
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, stale.length || COMPACT_LIMIT);
      const shown = stale.slice(0, limit);
      console.log(chalk.bold(`Repos with no commits in ${opts.days}+ days:`));
      for (const r of shown) {
        const lastDate = r.last_commit_date ? r.last_commit_date.slice(0, 10) : "never";
        console.log(`  ${chalk.yellow(r.name)} — last commit: ${lastDate} (${r.days_stale || "∞"} days ago)`);
        if (opts.verbose) console.log(chalk.dim(`    ${r.org ? `[${r.org}] ` : ""}${compactText(r.path, 140)}`));
      }
      printCompactHint({ count: shown.length, noun: `of ${stale.length} stale repo(s)`, limit, verbose: opts.verbose, detail: "use `repos show <name>` for repo details" });
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
  .option("--verbose", "Show up to 20 matches per repo")
  .option("--json", "Output as JSON")
  .action((file, opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const results = findFile(file, limit);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("Not found in any repo")); return; }
    for (const r of results) {
      console.log(chalk.bold(r.repo_name));
      const matchLimit = opts.verbose ? 20 : 3;
      for (const m of r.matches.slice(0, matchLimit)) console.log(chalk.dim(`  ${compactText(m, opts.verbose ? 160 : 100)}`));
      if (r.matches.length > matchLimit) console.log(chalk.dim(`  ... and ${r.matches.length - matchLimit} more`));
    }
    printCompactHint({ count: results.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use --json for every match path" });
  });

// ── Who ──
program
  .command("who <query>")
  .description("Find author activity across all repos")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show full date range rows")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const results = whoIs(query);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("No commits found for that author")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, results.length || COMPACT_LIMIT);
    const shown = results.slice(0, limit);
    console.log(chalk.bold(`Author: ${query}`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      if (opts.verbose) console.log(chalk.dim(`    ${day(r.first_commit)} → ${day(r.last_commit)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${results.length} repo(s)`, limit, verbose: opts.verbose, detail: "use `repos commits --author <query>` for commit rows" });
  });

// ── Diff Stats ──
program
  .command("diff-stats")
  .description("What changed recently across repos")
  .option("--today", "Today only")
  .option("--week", "Last 7 days")
  .option("--days <n>", "Custom days", "1")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show more authors per repo")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const days = opts.week ? 7 : opts.today ? 1 : intFlag(opts.days, "--days", 1);
    const results = diffStats(days);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim(`No activity in last ${days} day(s)`)); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, results.length || COMPACT_LIMIT);
    const shown = results.slice(0, limit);
    console.log(chalk.bold(`Activity in last ${days} day(s):`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      if (opts.verbose) console.log(chalk.dim(`    Authors: ${compactList(r.authors, 10, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${results.length} repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full aggregate rows" });
  });

// ── Dirty ──
program
  .command("dirty")
  .description("List repos with uncommitted changes")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const dirty = getDirtyRepos();
    if (opts.json) { console.log(JSON.stringify(dirty, null, 2)); return; }
    if (dirty.length === 0) { console.log(chalk.green("✓ All repos clean")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, dirty.length || COMPACT_LIMIT);
    const shown = dirty.slice(0, limit);
    console.log(chalk.bold(`${dirty.length} dirty repo(s):`));
    for (const r of shown) {
      const parts = [];
      if (r.modified) parts.push(chalk.yellow(`${r.modified} modified`));
      if (r.untracked) parts.push(chalk.red(`${r.untracked} untracked`));
      if (r.staged) parts.push(chalk.green(`${r.staged} staged`));
      console.log(`  ${chalk.bold(r.repo_name)}: ${parts.join(", ")}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${dirty.length} dirty repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full paths" });
  });

// ── Unpushed ──
program
  .command("unpushed")
  .description("List repos with unpushed commits")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const unpushed = getUnpushedRepos();
    if (opts.json) { console.log(JSON.stringify(unpushed, null, 2)); return; }
    if (unpushed.length === 0) { console.log(chalk.green("✓ All repos pushed")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, unpushed.length || COMPACT_LIMIT);
    const shown = unpushed.slice(0, limit);
    console.log(chalk.bold(`${unpushed.length} repo(s) with unpushed commits:`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.yellow(`${r.ahead} ahead`)} on ${r.branch}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${unpushed.length} repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full paths" });
  });

// ── Behind ──
program
  .command("behind")
  .description("List repos behind remote")
  .option("--fetch", "Fetch from remote first")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const behind = getBehindRepos(opts.fetch);
    if (opts.json) { console.log(JSON.stringify(behind, null, 2)); return; }
    if (behind.length === 0) { console.log(chalk.green("✓ All repos up to date")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, behind.length || COMPACT_LIMIT);
    const shown = behind.slice(0, limit);
    console.log(chalk.bold(`${behind.length} repo(s) behind remote:`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.red(`${r.behind} behind`)} on ${r.branch}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${behind.length} repo(s)`, limit, verbose: opts.verbose, detail: opts.fetch ? "fetch already ran" : "pass --fetch to refresh remotes first" });
  });

// ── Health ──
program
  .command("health")
  .description("Combined health check: dirty + unpushed + behind + stale")
  .option("-n, --limit <n>", "Max rows per section", "10")
  .option("--verbose", "Show larger sections")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const report = getHealthReport();
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }

    const issues = report.dirty.length + report.unpushed.length + report.behind.length + report.stale.length;
    if (issues === 0) { console.log(chalk.green("✓ All repos healthy")); return; }
    const sectionLimit = opts.verbose ? resolveLimit(opts, 25, 25) : resolveLimit(opts, 10, 10);

    if (report.dirty.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.dirty.length} dirty repo(s):`));
      for (const r of report.dirty.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.modified}M ${r.untracked}U ${r.staged}S)`);
    }
    if (report.unpushed.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.unpushed.length} repo(s) with unpushed commits:`));
      for (const r of report.unpushed.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.ahead} ahead on ${r.branch})`);
    }
    if (report.behind.length > 0) {
      console.log(chalk.red(`\n✗ ${report.behind.length} repo(s) behind remote:`));
      for (const r of report.behind.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.behind} behind on ${r.branch})`);
    }
    if (report.stale.length > 0) {
      console.log(chalk.dim(`\n○ ${report.stale.length} stale repo(s) (30+ days):`));
      for (const r of report.stale.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.days_stale} days)`);
    }
    console.log(chalk.dim("\nUse --verbose or --limit to widen sections, and --json for the full health report."));
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
  .option("--verbose", "Show larger top lists")
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
      for (const r of report.top_repos.slice(0, opts.verbose ? 10 : 5)) console.log(`    ${r.name}: ${r.commits} commits`);
    }
    if (report.top_authors.length > 0) {
      console.log(chalk.dim("\n  Top authors:"));
      for (const a of report.top_authors.slice(0, opts.verbose ? 10 : 5)) console.log(`    ${a.author}: ${a.commits} commits`);
    }
    if (!opts.verbose) console.log(chalk.dim("\nUse --verbose for larger top lists, or --json for the full report."));
  });

// ── Churn ──
program
  .command("churn")
  .description("Most frequently changed files across repos")
  .option("--days <n>", "Look back N days", "30")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show wider file paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const results = getChurn(intFlag(opts.days, "--days", 1), limit);
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (results.length === 0) { console.log(chalk.dim("No file changes found")); return; }
    console.log(chalk.bold("Most changed files:"));
    for (const r of results) {
      console.log(`  ${chalk.yellow(`${r.change_count}x`)} ${compactText(r.file, opts.verbose ? 160 : 96)} ${chalk.dim(`(${r.repo_name})`)}`);
    }
    printCompactHint({ count: results.length, noun: "file(s)", limit, verbose: opts.verbose, detail: "use --days to change the window" });
  });

// ── Languages ──
program
  .command("languages")
  .description("Language breakdown per org")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show more org counts")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const languages = getLanguages();
    if (opts.json) { console.log(JSON.stringify(languages, null, 2)); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, languages.length || COMPACT_LIMIT);
    const shown = languages.slice(0, limit);
    console.log(chalk.bold("Languages:"));
    for (const l of shown) {
      const entries = Object.entries(l.orgs);
      const orgEntries = opts.verbose ? entries : entries.slice(0, 4);
      const orgStr = orgEntries.map(([o, c]) => `${o}:${c}`).join(", ");
      const suffix = !opts.verbose && entries.length > orgEntries.length ? ` +${entries.length - orgEntries.length} more` : "";
      console.log(`  ${chalk.cyan(l.language)}: ${l.repo_count} repos ${chalk.dim(`(${orgStr})`)}`);
      if (suffix) console.log(chalk.dim(`    ${suffix}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${languages.length} language(s)`, limit, verbose: opts.verbose, detail: "use --json for full org breakdowns" });
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
  .option("-n, --limit <n>", "Max connection rows", "20")
  .option("--verbose", "Show wider connection IDs")
  .option("--json", "Output as JSON")
  .action((type, id, opts) => {
    const node = queryNode(type, id);
    if (!node) { console.log(chalk.red("Node not found")); process.exit(1); }
    if (opts.json) {
      console.log(JSON.stringify(node, null, 2));
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, node.edges.length || COMPACT_LIMIT);
      console.log(chalk.bold(`${node.type}: ${node.label}`));
      console.log(chalk.dim(`  ${node.edges.length} connections:`));
      for (const e of node.edges.slice(0, limit)) {
        console.log(`    ${e.relation} → ${e.target_type}:${compactText(e.target_id, opts.verbose ? 120 : 72)} (weight: ${e.weight})`);
      }
      printCompactHint({ count: Math.min(node.edges.length, limit), noun: `of ${node.edges.length} connection(s)`, limit, verbose: opts.verbose, detail: "use --json for full node data" });
    }
  });

graph
  .command("related <repo>")
  .description("Find related repos")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--verbose", "Show wider rows")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const limit = resolveLimit(opts, 10, 10);
    const results = queryRelated(repo, limit);
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) { console.log(chalk.dim("No related repos found. Run: repos graph build")); return; }
      console.log(chalk.bold(`Repos related to ${repo}:`));
      for (const r of results) {
        console.log(`  ${chalk.bold(compactText(r.repo_name, opts.verbose ? 120 : 72))} — ${r.relation} (weight: ${r.weight})`);
      }
      printCompactHint({ count: results.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use --json for full related records" });
    }
  });

graph
  .command("path <from-type> <from-id> <to-type> <to-id>")
  .description("Find shortest path between two nodes")
  .option("--verbose", "Show wider node IDs")
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
        console.log(`  ${chalk.cyan(n.type)}:${compactText(n.id, opts.verbose ? 120 : 72)}`);
        if (i < path.edges.length) console.log(`    ↓ ${path.edges[i]!.relation}`);
      }
      if (!opts.verbose) console.log(chalk.dim("\nUse --verbose for wider node IDs, or --json for full path data."));
    }
  });

graph
  .command("deps <repo>")
  .description("Show dependency tree for a repo")
  .option("--depth <n>", "Max depth", "3")
  .option("-n, --limit <n>", "Max dependency rows (human output only)", "50")
  .option("--verbose", "Show wider dependency names")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const deps = getDeps(repo, intFlag(opts.depth, "--depth", 1));
    if (opts.json) {
      console.log(JSON.stringify(deps, null, 2));
    } else {
      if (deps.length === 0) { console.log(chalk.dim("No dependencies found")); return; }
      const limit = resolveLimit(opts, 50, deps.length || 50);
      const shown = deps.slice(0, limit);
      console.log(chalk.bold(`Dependencies of ${repo}:`));
      for (const d of shown) {
        const indent = "  ".repeat(d.depth);
        console.log(`${indent}└── ${compactText(d.repo_name, opts.verbose ? 120 : 72)}`);
      }
      printCompactHint({ count: shown.length, noun: `of ${deps.length} dependency row(s)`, limit, verbose: opts.verbose, detail: "use --json for full dependency data" });
    }
  });

graph
  .command("authors")
  .description("Show authors who work across multiple orgs")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show wider org lists")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const authors = getCrossOrgAuthors();
    if (opts.json) {
      console.log(JSON.stringify(authors, null, 2));
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, authors.length || COMPACT_LIMIT);
      const shown = authors.slice(0, limit);
      console.log(chalk.bold("Cross-org authors:"));
      for (const a of shown) {
        console.log(`  ${chalk.bold(compactText(a.author_email, 72))} — ${compactList(a.orgs, opts.verbose ? 10 : 4, opts.verbose ? 140 : 80)} (${a.total_commits} commits)`);
      }
      printCompactHint({ count: shown.length, noun: `of ${authors.length} author(s)`, limit, verbose: opts.verbose, detail: "use --json for full author records" });
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
