#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { basename } from "node:path";
import { program } from "commander";
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
import { scanRepos, watchRepos } from "../lib/scanner.js";
import { getFilterAlias } from "../lib/config.js";
import { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "../lib/github.js";
import { getActivityHeatmap, getContributorStats, getStaleRepos, getRecentActivity } from "../lib/analytics.js";
import { buildGraph, queryNode, queryRelated, findPath, getDeps, getCrossOrgAuthors, getGraphStats } from "../lib/graph.js";
import { findFile, whoIs, diffStats, getDirtyRepos, getUnpushedRepos, getBehindRepos, getHealthReport, getRepoPath, getReport, getChurn, getLanguages, exportRepos, importFromOrg } from "../lib/utils.js";

const ORG_ALIASES: Record<string, string> = {
  oss: "hasna",
  xyz: "hasnaxyz",
  studio: "hasnastudio",
  tools: "hasnatools",
  ai: "hasnaai",
  education: "hasnaeducation",
  family: "hasnafamily",
};

program
  .name("repos")
  .description("Local repo intelligence — track all repos, search commits, PRs, branches")
  .version("0.1.0");

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
    const result = await scanRepos(roots, {
      full: opts.full,
      workers: parseInt(opts.workers),
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(chalk.green(`\n✓ Scan complete in ${(result.duration_ms / 1000).toFixed(1)}s`));
      console.log(`  Repos found: ${result.repos_found} (${result.repos_new} new, ${result.repos_updated} updated)`);
      console.log(`  Commits indexed: ${result.commits_indexed}`);
      console.log(`  Branches indexed: ${result.branches_indexed}`);
      console.log(`  Tags indexed: ${result.tags_indexed}`);
    }
  });

// ── Watch ──
program
  .command("watch")
  .description("Watch repos for changes and re-index on changes")
  .option("--root <paths...>", "Root directories to watch")
  .option("--filter <name>", "Use a saved filter alias to get root paths")
  .option("--full", "Full re-index on change (not incremental)")
  .action((opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config.`));
      process.exit(1);
    }
    const roots = alias?.paths ?? opts.root;
    console.log(chalk.blue("Starting watch mode..."));
    const watcher = watchRepos(roots, {
      full: opts.full,
      onProgress: (msg) => console.log(chalk.dim(msg)),
      onRepoChanged: async (repoPath) => {
        console.log(chalk.yellow(`\n→ Re-scanning ${basename(repoPath)}...`));
        await scanRepos([repoPath], {
          full: opts.full,
          onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
        });
      },
    });

    process.on("SIGINT", () => {
      watcher.stop();
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
  .option("--json", "Output as JSON")
  .action((opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const org = alias?.org ?? (opts.oss ? "hasna" : opts.xyz ? "hasnaxyz" : opts.studio ? "hasnastudio" : opts.tools ? "hasnatools" : opts.ai ? "hasnaai" : opts.education ? "hasnaeducation" : opts.family ? "hasnafamily" : (opts.org ? ORG_ALIASES[opts.org] ?? opts.org : undefined));
    const query = alias?.query ?? opts.query;
    const repos = listRepos({ org, query, limit: parseInt(opts.limit) });
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
    const repo = getRepo(name);
    if (!repo) { console.log(chalk.red("Repo not found")); process.exit(1); }
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
      repo_id = repo.id;
    }
    const commits = listCommits({ repo_id, author: opts.author, since: opts.since, until: opts.until, limit: parseInt(opts.limit) });
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
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
    const results = searchAll(query, parseInt(opts.limit));
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

// ── Analytics ──
program
  .command("activity")
  .description("Show recent activity across repos")
  .option("--days <n>", "Look back N days", "7")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const activity = getRecentActivity(parseInt(opts.days));
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
      repo_id = repo.id;
    }
    const contributors = getContributorStats({ repo_id, limit: parseInt(opts.limit) });
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
    const stale = getStaleRepos(parseInt(opts.days));
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
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
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
        const result = syncGithubPRs(opts.repo, { limit: parseInt(opts.limit) });
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
        limit: parseInt(opts.limit),
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
  .option("--json", "Output as JSON")
  .action((file, opts) => {
    const results = findFile(file, parseInt(opts.limit));
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
    const days = opts.week ? 7 : opts.today ? 1 : parseInt(opts.days);
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
    const report = getReport(parseInt(opts.days));
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
    const results = getChurn(parseInt(opts.days), parseInt(opts.limit));
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
    const results = queryRelated(repo, parseInt(opts.limit));
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
    const deps = getDeps(repo, parseInt(opts.depth));
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

program.parse();
