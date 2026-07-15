import { getDb } from "./database.js";
import type {
  Repo,
  Commit,
  Branch,
  Tag,
  Remote,
  PullRequest,
  SearchResult,
  RepoStats,
  ListOptions,
} from "../types/index.js";
import { sanitizeRemoteIdentity } from "../lib/remote-identity.js";

// ── Repos ──

export class AmbiguousRepoNameError extends Error {
  constructor(public readonly repoName: string) {
    super(`Multiple repos have the exact name '${repoName}'; use an explicit repo ID or path`);
    this.name = "AmbiguousRepoNameError";
  }
}

export function sanitizeRepoForOutput(repo: Repo): Repo {
  return { ...repo, remote_url: sanitizeRemoteIdentity(repo.remote_url) };
}

export function sanitizeRemoteForOutput(remote: Remote): Remote | null {
  const url = sanitizeRemoteIdentity(remote.url);
  if (!url) return null;
  return {
    ...remote,
    url,
    fetch_url: sanitizeRemoteIdentity(remote.fetch_url),
  };
}

export function listRepos(opts: ListOptions & { org?: string; query?: string } = {}): Repo[] {
  const db = getDb();
  const { limit = 50, offset = 0, org, query } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (org) {
    where.push("org = ?");
    params.push(org);
  }
  if (query) {
    where.push("(name LIKE ? OR description LIKE ? OR remote_url LIKE ?)");
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return (db
    .query(`SELECT * FROM repos ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as Repo[]).map(sanitizeRepoForOutput);
}

export function getRepo(idOrPath: string | number): Repo | null {
  const db = getDb();
  if (typeof idOrPath === "number") {
    const row = db.query("SELECT * FROM repos WHERE id = ?").get(idOrPath) as Repo | null;
    return row ? sanitizeRepoForOutput(row) : null;
  }
  const byPath = db.query("SELECT * FROM repos WHERE path = ?").get(idOrPath) as Repo | null;
  if (byPath) return sanitizeRepoForOutput(byPath);

  const byName = db
    .query("SELECT * FROM repos WHERE name = ? ORDER BY id LIMIT 2")
    .all(idOrPath) as Repo[];
  if (byName.length > 1) {
    throw new AmbiguousRepoNameError(idOrPath);
  }
  return byName[0] ? sanitizeRepoForOutput(byName[0]) : null;
}

export function upsertRepo(repo: Partial<Repo> & { path: string; name: string }): Repo {
  const db = getDb();
  const existing = db.query("SELECT id FROM repos WHERE path = ?").get(repo.path) as { id: number } | null;
  const hasRemote = Object.prototype.hasOwnProperty.call(repo, "remote_url");
  const safeRemote = hasRemote ? sanitizeRemoteIdentity(repo.remote_url) : null;

  if (existing) {
    db.query(`UPDATE repos SET
      name = coalesce(?, name),
      org = coalesce(?, org),
      remote_url = CASE WHEN ? THEN ? ELSE remote_url END,
      default_branch = coalesce(?, default_branch),
      description = coalesce(?, description),
      last_scanned = coalesce(?, last_scanned),
      commit_count = coalesce(?, commit_count),
      branch_count = coalesce(?, branch_count),
      tag_count = coalesce(?, tag_count),
      updated_at = datetime('now')
    WHERE path = ?`).run(
      repo.name, repo.org ?? null, hasRemote ? 1 : 0, safeRemote,
      repo.default_branch ?? null, repo.description ?? null,
      repo.last_scanned ?? null, repo.commit_count ?? null,
      repo.branch_count ?? null, repo.tag_count ?? null,
      repo.path
    );
    return sanitizeRepoForOutput(db.query("SELECT * FROM repos WHERE id = ?").get(existing.id) as Repo);
  }

  db.query(`INSERT INTO repos (path, name, org, remote_url, default_branch, description, last_scanned, commit_count, branch_count, tag_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    repo.path, repo.name, repo.org ?? null, safeRemote,
    repo.default_branch ?? "main", repo.description ?? null,
    repo.last_scanned ?? null, repo.commit_count ?? 0,
    repo.branch_count ?? 0, repo.tag_count ?? 0
  );
  return sanitizeRepoForOutput(db.query("SELECT * FROM repos WHERE path = ?").get(repo.path) as Repo);
}

export function deleteRepo(id: number): boolean {
  const db = getDb();
  const result = db.query("DELETE FROM repos WHERE id = ?").run(id);
  return result.changes > 0;
}

export function searchRepos(query: string, limit = 20): Repo[] {
  const db = getDb();
  const ids = db
    .query("SELECT rowid FROM fts_repos WHERE fts_repos MATCH ? LIMIT ?")
    .all(query, limit) as { rowid: number }[];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (db.query(`SELECT * FROM repos WHERE id IN (${placeholders})`).all(...ids.map((r) => r.rowid)) as Repo[])
    .map(sanitizeRepoForOutput);
}

// ── Commits ──

export function listCommits(
  opts: ListOptions & { repo_id?: number; author?: string; since?: string; until?: string } = {}
): Commit[] {
  const db = getDb();
  const { limit = 50, offset = 0, repo_id, author, since, until } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (repo_id) { where.push("repo_id = ?"); params.push(repo_id); }
  if (author) { where.push("(author_email LIKE ? OR author_name LIKE ?)"); params.push(`%${author}%`, `%${author}%`); }
  if (since) { where.push("date >= ?"); params.push(since); }
  if (until) { where.push("date <= ?"); params.push(until); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.query(`SELECT * FROM commits ${whereClause} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...params) as Commit[];
}

export function bulkInsertCommits(commits: Array<Omit<Commit, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR IGNORE INTO commits (repo_id, sha, author_name, author_email, date, message, files_changed, insertions, deletions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const c of commits) {
      const result = stmt.run(c.repo_id, c.sha, c.author_name, c.author_email, c.date, c.message, c.files_changed, c.insertions, c.deletions);
      if (result.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
}

export function searchCommits(query: string, limit = 20): Array<Commit & { repo_name: string; repo_path: string }> {
  const db = getDb();
  return db.query(`
    SELECT c.*, r.name as repo_name, r.path as repo_path
    FROM fts_commits fc
    JOIN commits c ON c.id = fc.rowid
    JOIN repos r ON r.id = c.repo_id
    WHERE fts_commits MATCH ?
    ORDER BY c.date DESC
    LIMIT ?
  `).all(query, limit) as Array<Commit & { repo_name: string; repo_path: string }>;
}

// ── Branches ──

export function listBranches(opts: ListOptions & { repo_id?: number; is_remote?: boolean } = {}): Branch[] {
  const db = getDb();
  const { limit = 100, offset = 0, repo_id, is_remote } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (repo_id) { where.push("repo_id = ?"); params.push(repo_id); }
  if (is_remote !== undefined) { where.push("is_remote = ?"); params.push(is_remote ? 1 : 0); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.query(`SELECT * FROM branches ${whereClause} ORDER BY last_commit_date DESC NULLS LAST LIMIT ? OFFSET ?`).all(...params) as Branch[];
}

export function bulkInsertBranches(branches: Array<Omit<Branch, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO branches (repo_id, name, is_remote, last_commit_sha, last_commit_date, ahead, behind)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const b of branches) {
      stmt.run(b.repo_id, b.name, b.is_remote ? 1 : 0, b.last_commit_sha, b.last_commit_date, b.ahead, b.behind);
      count++;
    }
  });
  tx();
  return count;
}

// ── Tags ──

export function listTags(opts: ListOptions & { repo_id?: number } = {}): Tag[] {
  const db = getDb();
  const { limit = 100, offset = 0, repo_id } = opts;
  if (repo_id) {
    return db.query("SELECT * FROM tags WHERE repo_id = ? ORDER BY date DESC NULLS LAST LIMIT ? OFFSET ?").all(repo_id, limit, offset) as Tag[];
  }
  return db.query("SELECT * FROM tags ORDER BY date DESC NULLS LAST LIMIT ? OFFSET ?").all(limit, offset) as Tag[];
}

export function bulkInsertTags(tags: Array<Omit<Tag, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO tags (repo_id, name, sha, date, message) VALUES (?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const t of tags) {
      stmt.run(t.repo_id, t.name, t.sha, t.date, t.message);
      count++;
    }
  });
  tx();
  return count;
}

// ── Remotes ──

export function listRemotes(repo_id: number): Remote[] {
  const db = getDb();
  return (db.query("SELECT * FROM remotes WHERE repo_id = ?").all(repo_id) as Remote[])
    .map(sanitizeRemoteForOutput)
    .filter((remote): remote is Remote => remote !== null);
}

export function bulkInsertRemotes(remotes: Array<Omit<Remote, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO remotes (repo_id, name, url, fetch_url) VALUES (?, ?, ?, ?)`);
  const remove = db.query("DELETE FROM remotes WHERE repo_id = ? AND name = ?");
  let count = 0;
  const tx = db.transaction(() => {
    for (const r of remotes) {
      const url = sanitizeRemoteIdentity(r.url);
      if (!url) {
        remove.run(r.repo_id, r.name);
        continue;
      }
      stmt.run(r.repo_id, r.name, url, sanitizeRemoteIdentity(r.fetch_url));
      count++;
    }
  });
  tx();
  return count;
}

// ── Pull Requests ──

export function listPullRequests(
  opts: ListOptions & { repo_id?: number; state?: string; author?: string } = {}
): PullRequest[] {
  const db = getDb();
  const { limit = 50, offset = 0, repo_id, state, author } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (repo_id) { where.push("repo_id = ?"); params.push(repo_id); }
  if (state) { where.push("state = ?"); params.push(state); }
  if (author) { where.push("author LIKE ?"); params.push(`%${author}%`); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.query(`SELECT * FROM pull_requests ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as PullRequest[];
}

export function bulkInsertPullRequests(prs: Array<Omit<PullRequest, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO pull_requests
    (repo_id, number, title, state, author, created_at, updated_at, merged_at, closed_at, url, base_branch, head_branch, additions, deletions, changed_files)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const pr of prs) {
      stmt.run(pr.repo_id, pr.number, pr.title, pr.state, pr.author, pr.created_at, pr.updated_at, pr.merged_at, pr.closed_at, pr.url, pr.base_branch, pr.head_branch, pr.additions, pr.deletions, pr.changed_files);
      count++;
    }
  });
  tx();
  return count;
}

export function searchPullRequests(query: string, limit = 20): Array<PullRequest & { repo_name: string }> {
  const db = getDb();
  return db.query(`
    SELECT pr.*, r.name as repo_name
    FROM fts_prs fp
    JOIN pull_requests pr ON pr.id = fp.rowid
    JOIN repos r ON r.id = pr.repo_id
    WHERE fts_prs MATCH ?
    ORDER BY pr.created_at DESC
    LIMIT ?
  `).all(query, limit) as Array<PullRequest & { repo_name: string }>;
}

// ── Unified Search ──

export function searchAll(query: string, limit = 20): SearchResult[] {
  const results: SearchResult[] = [];

  const repos = searchRepos(query, limit);
  for (const r of repos) {
    results.push({
      type: "repo",
      repo_name: r.name,
      repo_path: r.path,
      title: r.name,
      snippet: r.description || r.remote_url || r.path,
      date: r.updated_at,
      score: 1.0,
    });
  }

  const commits = searchCommits(query, limit);
  for (const c of commits) {
    results.push({
      type: "commit",
      repo_name: c.repo_name,
      repo_path: c.repo_path,
      title: c.sha.slice(0, 8),
      snippet: c.message.slice(0, 200),
      date: c.date,
      score: 0.9,
    });
  }

  const prs = searchPullRequests(query, limit);
  for (const pr of prs) {
    results.push({
      type: "pr",
      repo_name: pr.repo_name,
      repo_path: "",
      title: `#${pr.number}: ${pr.title}`,
      snippet: `${pr.state} by ${pr.author}`,
      date: pr.created_at,
      score: 0.85,
    });
  }

  results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return results.slice(0, limit);
}

// ── Stats ──

export function getRepoStats(repoId: number): {
  commit_count: number;
  branch_count: number;
  tag_count: number;
  pr_count: number;
  recent_commits: Commit[];
  top_authors: Array<{ author: string; count: number }>;
} {
  const db = getDb();
  const commit_count = (db.query("SELECT COUNT(*) as c FROM commits WHERE repo_id = ?").get(repoId) as any).c;
  const branch_count = (db.query("SELECT COUNT(*) as c FROM branches WHERE repo_id = ?").get(repoId) as any).c;
  const tag_count = (db.query("SELECT COUNT(*) as c FROM tags WHERE repo_id = ?").get(repoId) as any).c;
  const pr_count = (db.query("SELECT COUNT(*) as c FROM pull_requests WHERE repo_id = ?").get(repoId) as any).c;
  const recent_commits = db.query("SELECT * FROM commits WHERE repo_id = ? ORDER BY date DESC LIMIT 10").all(repoId) as Commit[];
  const top_authors = db.query(
    "SELECT author_name as author, COUNT(*) as count FROM commits WHERE repo_id = ? GROUP BY author_email ORDER BY count DESC LIMIT 10"
  ).all(repoId) as Array<{ author: string; count: number }>;

  return { commit_count, branch_count, tag_count, pr_count, recent_commits, top_authors };
}

export function getGlobalStats(): RepoStats {
  const db = getDb();
  const total_repos = (db.query("SELECT COUNT(*) as c FROM repos").get() as any).c;
  const total_commits = (db.query("SELECT COUNT(*) as c FROM commits").get() as any).c;
  const total_branches = (db.query("SELECT COUNT(*) as c FROM branches").get() as any).c;
  const total_tags = (db.query("SELECT COUNT(*) as c FROM tags").get() as any).c;
  const total_prs = (db.query("SELECT COUNT(*) as c FROM pull_requests").get() as any).c;

  const orgRows = db.query("SELECT org, COUNT(*) as c FROM repos WHERE org IS NOT NULL GROUP BY org ORDER BY c DESC").all() as Array<{ org: string; c: number }>;
  const repos_by_org: Record<string, number> = {};
  for (const r of orgRows) repos_by_org[r.org] = r.c;

  const most_active_repos = db.query(
    "SELECT r.name, COUNT(c.id) as commits FROM repos r LEFT JOIN commits c ON c.repo_id = r.id GROUP BY r.id ORDER BY commits DESC LIMIT 10"
  ).all() as Array<{ name: string; commits: number }>;

  const stale_repos = db.query(
    "SELECT r.name, MAX(c.date) as last_commit FROM repos r LEFT JOIN commits c ON c.repo_id = r.id GROUP BY r.id HAVING last_commit < datetime('now', '-30 days') OR last_commit IS NULL ORDER BY last_commit ASC LIMIT 20"
  ).all() as Array<{ name: string; last_commit: string }>;

  return { total_repos, total_commits, total_branches, total_tags, total_prs, repos_by_org, most_active_repos, stale_repos };
}
