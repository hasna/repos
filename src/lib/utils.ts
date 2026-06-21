import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/database.js";

function git(repoPath: string, args: string[], timeout = 10_000): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// ── repos find <file> ──

export function findFile(filename: string, limit = 50): Array<{
  repo_name: string;
  repo_path: string;
  matches: string[];
}> {
  const db = getDb();
  const repos = db.query("SELECT id, name, path FROM repos").all() as any[];
  const results: Array<{ repo_name: string; repo_path: string; matches: string[] }> = [];

  for (const repo of repos) {
    const output = git(repo.path, ["ls-files", `*${filename}*`], 5000);
    if (output) {
      const matches = output.split("\n").filter(Boolean);
      if (matches.length > 0) {
        results.push({ repo_name: repo.name, repo_path: repo.path, matches });
      }
    }
    if (results.length >= limit) break;
  }

  return results;
}

// ── repos who <email> ──

export function whoIs(query: string): Array<{
  repo_name: string;
  repo_id: number;
  commit_count: number;
  first_commit: string;
  last_commit: string;
  insertions: number;
  deletions: number;
}> {
  const db = getDb();
  return db.query(`
    SELECT r.name as repo_name, r.id as repo_id, COUNT(*) as commit_count,
      MIN(c.date) as first_commit, MAX(c.date) as last_commit,
      SUM(c.insertions) as insertions, SUM(c.deletions) as deletions
    FROM commits c JOIN repos r ON r.id = c.repo_id
    WHERE c.author_email LIKE ? OR c.author_name LIKE ?
    GROUP BY r.id ORDER BY commit_count DESC
  `).all(`%${query}%`, `%${query}%`) as any[];
}

// ── repos diff-stats ──

export function diffStats(days = 1): Array<{
  repo_name: string;
  commit_count: number;
  authors: string[];
  insertions: number;
  deletions: number;
}> {
  const db = getDb();
  return db.query(`
    SELECT r.name as repo_name, COUNT(*) as commit_count,
      GROUP_CONCAT(DISTINCT c.author_name) as authors,
      SUM(c.insertions) as insertions, SUM(c.deletions) as deletions
    FROM commits c JOIN repos r ON r.id = c.repo_id
    WHERE c.date >= datetime('now', '-' || ? || ' days')
    GROUP BY r.id ORDER BY commit_count DESC
  `).all(days).map((r: any) => ({
    ...r,
    authors: r.authors ? r.authors.split(",") : [],
  })) as any[];
}

// ── Fuzzy repo matching ──

export function fuzzyFindRepo(query: string): { id: number; name: string; path: string } | null {
  const db = getDb();

  // Exact match first
  const exact = db.query("SELECT id, name, path FROM repos WHERE name = ? OR path = ?").get(query, query) as any;
  if (exact) return exact;

  // Substring match
  const sub = db.query("SELECT id, name, path FROM repos WHERE name LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1").get(`%${query}%`) as any;
  if (sub) return sub;

  // Abbreviated match (plat-alum → platform-alumia)
  const parts = query.split(/[-_]/);
  if (parts.length >= 2) {
    const pattern = parts.map(p => `%${p}%`).join("");
    const abbrev = db.query("SELECT id, name, path FROM repos WHERE name LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1").get(pattern) as any;
    if (abbrev) return abbrev;
  }

  // Levenshtein-ish: find closest by sorting all repos and picking best substring overlap
  const allRepos = db.query("SELECT id, name, path FROM repos").all() as any[];
  let bestMatch: any = null;
  let bestScore = 0;

  for (const repo of allRepos) {
    const score = commonSubstringLength(query.toLowerCase(), repo.name.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestMatch = repo;
    }
  }

  return bestScore >= 3 ? bestMatch : null;
}

function commonSubstringLength(a: string, b: string): number {
  let maxLen = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) len++;
      if (len > maxLen) maxLen = len;
    }
  }
  return maxLen;
}

// ── repos dirty ──

export function getDirtyRepos(): Array<{
  repo_name: string;
  repo_path: string;
  modified: number;
  untracked: number;
  staged: number;
}> {
  const db = getDb();
  const repos = db.query("SELECT name, path FROM repos").all() as any[];
  const dirty: Array<{ repo_name: string; repo_path: string; modified: number; untracked: number; staged: number }> = [];

  for (const repo of repos) {
    const status = git(repo.path, ["status", "--porcelain"], 5000);
    if (!status) continue;

    let modified = 0, untracked = 0, staged = 0;
    for (const line of status.split("\n")) {
      if (!line) continue;
      const x = line[0], y = line[1];
      if (x === "?" || y === "?") untracked++;
      else if (x !== " " && x !== "?") staged++;
      else if (y !== " ") modified++;
    }

    dirty.push({ repo_name: repo.name, repo_path: repo.path, modified, untracked, staged });
  }

  return dirty;
}

// ── repos unpushed ──

export function getUnpushedRepos(): Array<{
  repo_name: string;
  repo_path: string;
  ahead: number;
  branch: string;
}> {
  const db = getDb();
  const repos = db.query("SELECT name, path FROM repos").all() as any[];
  const unpushed: Array<{ repo_name: string; repo_path: string; ahead: number; branch: string }> = [];

  for (const repo of repos) {
    const branch = git(repo.path, ["symbolic-ref", "--short", "HEAD"], 3000);
    if (!branch) continue;
    const aheadStr = git(repo.path, ["rev-list", "--count", "@{upstream}..HEAD"], 3000);
    const ahead = parseInt(aheadStr) || 0;
    if (ahead > 0) {
      unpushed.push({ repo_name: repo.name, repo_path: repo.path, ahead, branch });
    }
  }

  return unpushed;
}

// ── repos behind ──

export function getBehindRepos(fetch = false): Array<{
  repo_name: string;
  repo_path: string;
  behind: number;
  branch: string;
}> {
  const db = getDb();
  const repos = db.query("SELECT name, path FROM repos").all() as any[];
  const behindRepos: Array<{ repo_name: string; repo_path: string; behind: number; branch: string }> = [];

  for (const repo of repos) {
    if (fetch) git(repo.path, ["fetch", "--quiet"], 10000);
    const branch = git(repo.path, ["symbolic-ref", "--short", "HEAD"], 3000);
    if (!branch) continue;
    const behindStr = git(repo.path, ["rev-list", "--count", "HEAD..@{upstream}"], 3000);
    const behind = parseInt(behindStr) || 0;
    if (behind > 0) {
      behindRepos.push({ repo_name: repo.name, repo_path: repo.path, behind, branch });
    }
  }

  return behindRepos;
}

// ── repos health ──

export interface HealthReport {
  dirty: Array<{ repo_name: string; modified: number; untracked: number; staged: number }>;
  unpushed: Array<{ repo_name: string; ahead: number; branch: string }>;
  behind: Array<{ repo_name: string; behind: number; branch: string }>;
  stale: Array<{ repo_name: string; days_stale: number }>;
}

export function getHealthReport(): HealthReport {
  const db = getDb();

  const dirty = getDirtyRepos().map(r => ({ repo_name: r.repo_name, modified: r.modified, untracked: r.untracked, staged: r.staged }));
  const unpushed = getUnpushedRepos().map(r => ({ repo_name: r.repo_name, ahead: r.ahead, branch: r.branch }));
  const behind = getBehindRepos(false).map(r => ({ repo_name: r.repo_name, behind: r.behind, branch: r.branch }));

  const staleRows = db.query(`
    SELECT r.name as repo_name, CAST(julianday('now') - julianday(MAX(c.date)) AS INTEGER) as days_stale
    FROM repos r LEFT JOIN commits c ON c.repo_id = r.id
    GROUP BY r.id HAVING days_stale > 30 OR days_stale IS NULL
    ORDER BY days_stale DESC LIMIT 20
  `).all() as any[];

  return { dirty, unpushed, behind, stale: staleRows };
}

// ── repos cd / open ──

export function getRepoPath(query: string): string | null {
  const repo = fuzzyFindRepo(query);
  return repo ? repo.path : null;
}

// ── repos report ──

export function getReport(days = 7): {
  period: string;
  repos_touched: number;
  total_commits: number;
  total_insertions: number;
  total_deletions: number;
  top_repos: Array<{ name: string; commits: number }>;
  top_authors: Array<{ author: string; commits: number }>;
} {
  const db = getDb();

  const repos_touched = (db.query(
    "SELECT COUNT(DISTINCT repo_id) as c FROM commits WHERE date >= datetime('now', '-' || ? || ' days')"
  ).get(days) as any).c;

  const totals = db.query(
    "SELECT COUNT(*) as commits, SUM(insertions) as ins, SUM(deletions) as del FROM commits WHERE date >= datetime('now', '-' || ? || ' days')"
  ).get(days) as any;

  const top_repos = db.query(`
    SELECT r.name, COUNT(*) as commits FROM commits c JOIN repos r ON r.id = c.repo_id
    WHERE c.date >= datetime('now', '-' || ? || ' days')
    GROUP BY r.id ORDER BY commits DESC LIMIT 10
  `).all(days) as any[];

  const top_authors = db.query(`
    SELECT author_name as author, COUNT(*) as commits FROM commits
    WHERE date >= datetime('now', '-' || ? || ' days')
    GROUP BY author_email ORDER BY commits DESC LIMIT 10
  `).all(days) as any[];

  return {
    period: `Last ${days} days`,
    repos_touched,
    total_commits: totals.commits,
    total_insertions: totals.ins || 0,
    total_deletions: totals.del || 0,
    top_repos,
    top_authors,
  };
}

// ── repos churn ──

export function getChurn(days = 30, limit = 20): Array<{
  file: string;
  repo_name: string;
  change_count: number;
}> {
  const db = getDb();
  const repos = db.query("SELECT id, name, path FROM repos").all() as any[];
  const fileChanges = new Map<string, { repo_name: string; count: number }>();

  for (const repo of repos) {
    const output = git(repo.path, ["log", `--since=${days} days ago`, "--name-only", "--pretty=format:", "--diff-filter=M"], 10000);
    if (!output) continue;
    for (const file of output.split("\n").filter(Boolean)) {
      const key = `${repo.name}:${file}`;
      const existing = fileChanges.get(key) || { repo_name: repo.name, count: 0 };
      existing.count++;
      fileChanges.set(key, existing);
    }
  }

  return Array.from(fileChanges.entries())
    .map(([key, val]) => ({ file: key.split(":").slice(1).join(":"), repo_name: val.repo_name, change_count: val.count }))
    .sort((a, b) => b.change_count - a.change_count)
    .slice(0, limit);
}

// ── repos languages ──

export function getLanguages(): Array<{
  language: string;
  repo_count: number;
  orgs: Record<string, number>;
}> {
  const db = getDb();
  const edges = db.query(`
    SELECT e.target_id as language, COUNT(*) as repo_count
    FROM edges e WHERE e.relation = 'uses_lang'
    GROUP BY e.target_id ORDER BY repo_count DESC
  `).all() as any[];

  return edges.map((e: any) => {
    const orgRows = db.query(`
      SELECT r.org, COUNT(*) as c
      FROM edges e JOIN repos r ON r.id = CAST(e.source_id AS INTEGER)
      WHERE e.relation = 'uses_lang' AND e.target_id = ? AND r.org IS NOT NULL
      GROUP BY r.org ORDER BY c DESC
    `).all(e.language) as any[];
    const orgs: Record<string, number> = {};
    for (const o of orgRows) orgs[o.org] = o.c;
    return { language: e.language, repo_count: e.repo_count, orgs };
  });
}

// ── repos import/export ──

export function exportRepos(format: "json" | "csv" = "json"): string {
  const db = getDb();
  const repos = db.query("SELECT name, path, org, remote_url, default_branch, commit_count, branch_count, tag_count, last_scanned FROM repos ORDER BY name").all() as any[];

  if (format === "csv") {
    const header = "name,path,org,remote_url,default_branch,commits,branches,tags,last_scanned";
    const rows = repos.map((r: any) =>
      `"${r.name}","${r.path}","${r.org || ""}","${r.remote_url || ""}","${r.default_branch}",${r.commit_count},${r.branch_count},${r.tag_count},"${r.last_scanned || ""}"`
    );
    return [header, ...rows].join("\n");
  }

  return JSON.stringify(repos, null, 2);
}

export function importFromOrg(org: string, targetDir: string, opts: { onProgress?: (msg: string) => void } = {}): {
  cloned: number;
  skipped: number;
  errors: string[];
} {
  let cloned = 0, skipped = 0;
  const errors: string[] = [];

  let output: string;
  try {
    output = execFileSync("gh", ["repo", "list", org, "--limit", "500", "--json", "name,sshUrl,isArchived", "--no-archived"], {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return { cloned: 0, skipped: 0, errors: ["Failed to list repos from GitHub"] };
  }

  const ghRepos = JSON.parse(output || "[]") as Array<{ name: string; sshUrl: string }>;
  opts.onProgress?.(`Found ${ghRepos.length} repos in ${org}`);

  for (const ghRepo of ghRepos) {
    const dest = join(targetDir, ghRepo.name);
    if (existsSync(dest)) {
      opts.onProgress?.(`  Skip ${ghRepo.name} (exists)`);
      skipped++;
      continue;
    }
    opts.onProgress?.(`  Cloning ${ghRepo.name}...`);
    try {
      execFileSync("git", ["clone", ghRepo.sshUrl, dest], { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
      cloned++;
    } catch (err) {
      errors.push(`${ghRepo.name}: ${err}`);
    }
  }

  return { cloned, skipped, errors };
}
