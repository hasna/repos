#!/usr/bin/env bun
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
import { scanRepos } from "../lib/scanner.js";
import { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "../lib/github.js";
import { getActivityHeatmap, getContributorStats, getStaleRepos, getRecentActivity } from "../lib/analytics.js";

program
  .name("git-local")
  .description("Local git intelligence — track all repos, search commits, PRs, branches")
  .version("0.1.0");

// ── Scan ──
program
  .command("scan")
  .description("Scan directories to discover and index git repos")
  .option("--root <paths...>", "Root directories to scan")
  .option("--full", "Full re-scan (not incremental)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const result = scanRepos(opts.root, {
      full: opts.full,
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

// ── Repos ──
program
  .command("repos")
  .description("List repositories")
  .option("--org <org>", "Filter by org")
  .option("-q, --query <query>", "Filter by name")
  .option("-n, --limit <n>", "Max results", "50")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repos = listRepos({ org: opts.org, query: opts.query, limit: parseInt(opts.limit) });
    if (opts.json) {
      console.log(JSON.stringify(repos, null, 2));
    } else {
      if (repos.length === 0) { console.log(chalk.dim("No repos found. Run: git-local scan")); return; }
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
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = getRepo(opts.repo);
      if (!repo) { console.log(chalk.red(`Repo not found: ${opts.repo}`)); process.exit(1); }
      repo_id = repo.id;
    }
    const prs = listPullRequests({ repo_id, state: opts.state, author: opts.author });
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

program.parse();
