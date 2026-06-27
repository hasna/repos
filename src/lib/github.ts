import { execSync } from "node:child_process";
import { getDb } from "../db/database.js";
import { getRepo, bulkInsertPullRequests } from "../db/repos.js";
import type { PullRequest } from "../types/index.js";

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

interface GhPr {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function syncGithubPRs(
  repoIdOrName: string | number,
  opts: { limit?: number; state?: string } = {}
): { synced: number; repo_name: string } {
  const repo = typeof repoIdOrName === "number" ? getRepo(repoIdOrName) : getRepo(repoIdOrName);
  if (!repo) throw new Error(`Repo not found: ${repoIdOrName}`);
  if (!repo.remote_url) throw new Error(`Repo has no remote URL: ${repo.name}`);

  // Extract owner/repo from remote URL
  const match = repo.remote_url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) throw new Error(`Cannot parse GitHub repo from: ${repo.remote_url}`);
  const ghRepo = match[1]!.replace(/\.git$/, "");

  const { limit = 100, state = "all" } = opts;
  const stateArg = state === "all" ? "--state all" : `--state ${state}`;

  const output = gh(
    `pr list -R ${ghRepo} ${stateArg} --limit ${limit} --json number,title,state,author,createdAt,updatedAt,mergedAt,closedAt,url,baseRefName,headRefName,additions,deletions,changedFiles`
  );

  if (!output) return { synced: 0, repo_name: repo.name };

  let prs: GhPr[];
  try {
    prs = JSON.parse(output);
  } catch {
    return { synced: 0, repo_name: repo.name };
  }

  const prRows: Array<Omit<PullRequest, "id">> = prs.map((pr) => ({
    repo_id: repo.id,
    number: pr.number,
    title: pr.title,
    state: pr.mergedAt ? "merged" : (pr.state.toLowerCase() as "open" | "closed"),
    author: pr.author?.login || "unknown",
    created_at: pr.createdAt,
    updated_at: pr.updatedAt || null,
    merged_at: pr.mergedAt || null,
    closed_at: pr.closedAt || null,
    url: pr.url,
    base_branch: pr.baseRefName || null,
    head_branch: pr.headRefName || null,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changed_files: pr.changedFiles || 0,
  }));

  const synced = bulkInsertPullRequests(prRows);
  return { synced, repo_name: repo.name };
}

export function syncAllGithubPRs(
  opts: { org?: string; limit?: number; state?: string; onProgress?: (msg: string) => void } = {}
): { total_synced: number; repos_synced: number; errors: string[] } {
  const db = getDb();
  const { org, limit = 50, state = "all", onProgress } = opts;

  let repos;
  if (org) {
    repos = db.query("SELECT * FROM repos WHERE org = ? AND remote_url LIKE '%github.com%'").all(org) as any[];
  } else {
    repos = db.query("SELECT * FROM repos WHERE remote_url LIKE '%github.com%'").all() as any[];
  }

  let total_synced = 0;
  let repos_synced = 0;
  const errors: string[] = [];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    onProgress?.(`[${i + 1}/${repos.length}] Syncing PRs for ${repo.name}...`);
    try {
      const result = syncGithubPRs(repo.id, { limit, state });
      total_synced += result.synced;
      repos_synced++;
    } catch (err) {
      errors.push(`${repo.name}: ${err}`);
    }
  }

  return { total_synced, repos_synced, errors };
}

export function fetchRepoMetadata(repoIdOrName: string | number): {
  description: string | null;
  topics: string[];
  stars: number;
  forks: number;
  language: string | null;
} | null {
  const repo = typeof repoIdOrName === "number" ? getRepo(repoIdOrName) : getRepo(repoIdOrName);
  if (!repo?.remote_url) return null;

  const match = repo.remote_url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) return null;
  const ghRepo = match[1]!.replace(/\.git$/, "");

  const output = gh(`repo view ${ghRepo} --json description,repositoryTopics,stargazerCount,forkCount,primaryLanguage`);
  if (!output) return null;

  try {
    const data = JSON.parse(output);
    const description = data.description || null;
    const topics = (data.repositoryTopics || []).map((t: any) => t.name);
    const stars = data.stargazerCount || 0;
    const forks = data.forkCount || 0;
    const language = data.primaryLanguage?.name || null;

    // Update repo description in DB
    if (description) {
      const db = getDb();
      db.query("UPDATE repos SET description = ?, updated_at = datetime('now') WHERE id = ?")
        .run(description, repo.id);
    }

    return { description, topics, stars, forks, language };
  } catch {
    return null;
  }
}
