import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import cliProgress from "cli-progress";
import { getDb } from "../db/database.js";
import { getConfig } from "./config.js";
import {
  upsertRepo,
  bulkInsertCommits,
  bulkInsertBranches,
  bulkInsertTags,
  bulkInsertRemotes,
} from "../db/repos.js";
import type { ScanResult } from "../types/index.js";

function git(repoPath: string, args: string): string {
  try {
    return execSync(`git -C "${repoPath}" ${args}`, {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function discoverRepos(rootDirs: string[], maxDepth?: number): string[] {
  const cfg = getConfig();
  const depth = maxDepth ?? cfg.scanDepth ?? 5;
  const excluded = new Set(cfg.excludedPaths ?? ["node_modules", "dist", "vendor", ".git"]);
  const repos: string[] = [];
  const visited = new Set<string>();

  function walk(dir: string, d: number) {
    if (d > depth) return;
    const realDir = resolve(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);

    if (isGitRepo(realDir)) {
      repos.push(realDir);
      return;
    }

    try {
      const entries = readdirSync(realDir);
      for (const entry of entries) {
        if (entry.startsWith(".") || excluded.has(entry)) continue;
        const full = join(realDir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full, d + 1);
        } catch { /* permission denied, broken symlink */ }
      }
    } catch { /* can't read directory */ }
  }

  for (const root of rootDirs) {
    walk(root, 0);
  }

  return repos;
}

function extractOrg(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  // https://github.com/org/repo.git or git@github.com:org/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1] || null;
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1] || null;
  return null;
}

function indexRepo(repoPath: string, full = false): {
  commits: number;
  branches: number;
  tags: number;
  isNew: boolean;
} {
  const db = getDb();
  const name = basename(repoPath);

  // Get remote URL and default branch
  const remoteUrl = git(repoPath, "remote get-url origin") || null;
  const defaultBranch = git(repoPath, "symbolic-ref --short HEAD") || "main";
  const org = extractOrg(remoteUrl);

  // Check if repo already exists
  const existing = db.query("SELECT id, last_scanned FROM repos WHERE path = ?").get(repoPath) as { id: number; last_scanned: string | null } | null;
  const isNew = !existing;

  // Get commit count limit — full scan gets all, incremental gets last 100
  const cfg = getConfig();
  const commitLimit = full || isNew ? (cfg.commitLimit ?? 5000) : (cfg.incrementalCommitLimit ?? 100);
  const sinceClause = !full && existing?.last_scanned
    ? `--since="${existing.last_scanned}"`
    : "";

  // Upsert repo
  const repo = upsertRepo({
    path: repoPath,
    name,
    org,
    remote_url: remoteUrl,
    default_branch: defaultBranch,
    last_scanned: new Date().toISOString(),
  });

  // Index commits
  const commitLog = git(repoPath, `log --format="%H|%an|%ae|%aI|%s" --shortstat ${sinceClause} -n ${commitLimit}`);
  const commitEntries: Array<{
    sha: string; author_name: string; author_email: string;
    date: string; message: string; files_changed: number;
    insertions: number; deletions: number;
  }> = [];

  if (commitLog) {
    const lines = commitLog.split("\n");
    let current: any = null;

    for (const line of lines) {
      if (line.includes("|") && !line.startsWith(" ")) {
        if (current) commitEntries.push(current);
        const parts = line.split("|");
        current = {
          sha: parts[0] || "",
          author_name: parts[1] || "",
          author_email: parts[2] || "",
          date: parts[3] || "",
          message: parts.slice(4).join("|"),
          files_changed: 0,
          insertions: 0,
          deletions: 0,
        };
      } else if (current && line.includes("file")) {
        const filesMatch = line.match(/(\d+) files? changed/);
        const insMatch = line.match(/(\d+) insertions?/);
        const delMatch = line.match(/(\d+) deletions?/);
        current.files_changed = filesMatch ? parseInt(filesMatch[1]!) : 0;
        current.insertions = insMatch ? parseInt(insMatch[1]!) : 0;
        current.deletions = delMatch ? parseInt(delMatch[1]!) : 0;
      }
    }
    if (current) commitEntries.push(current);
  }

  const commitsInserted = bulkInsertCommits(
    commitEntries.map((c) => ({ ...c, repo_id: repo.id }))
  );

  // Index branches
  const branchOutput = git(repoPath, "branch -a --format='%(refname:short)|%(objectname:short)|%(committerdate:iso8601)'");
  const branchEntries: Array<{
    name: string; is_remote: boolean; last_commit_sha: string | null;
    last_commit_date: string | null; ahead: number; behind: number;
  }> = [];

  if (branchOutput) {
    for (const line of branchOutput.split("\n")) {
      const parts = line.replace(/'/g, "").split("|");
      if (!parts[0]) continue;
      const branchName = parts[0];
      const isRemote = branchName.startsWith("origin/") || branchName.includes("/");
      let ahead = 0;
      let behind = 0;

      if (!isRemote && !branchName.startsWith("HEAD")) {
        const trackingBranch = branchName === defaultBranch
          ? `origin/${defaultBranch}`
          : null;
        if (trackingBranch) {
          const revlist = git(repoPath, `rev-list --left-right --count ${branchName}...${trackingBranch}`);
          if (revlist) {
            const counts = revlist.split("\t");
            ahead = parseInt(counts[0] ?? "0", 10) || 0;
            behind = parseInt(counts[1] ?? "0", 10) || 0;
          }
        }
      }

      branchEntries.push({
        name: branchName,
        is_remote: isRemote,
        last_commit_sha: parts[1] || null,
        last_commit_date: parts[2] || null,
        ahead,
        behind,
      });
    }
  }

  const branchesInserted = bulkInsertBranches(
    branchEntries.map((b) => ({ ...b, repo_id: repo.id }))
  );

  // Index tags
  const tagOutput = git(repoPath, "tag -l --format='%(refname:short)|%(objectname:short)|%(creatordate:iso8601)|%(subject)'");
  const tagEntries: Array<{ name: string; sha: string; date: string | null; message: string | null }> = [];

  if (tagOutput) {
    for (const line of tagOutput.split("\n")) {
      const parts = line.replace(/'/g, "").split("|");
      if (!parts[0]) continue;
      tagEntries.push({
        name: parts[0],
        sha: parts[1] || "",
        date: parts[2] || null,
        message: parts[3] || null,
      });
    }
  }

  const tagsInserted = bulkInsertTags(
    tagEntries.map((t) => ({ ...t, repo_id: repo.id }))
  );

  // Index remotes
  const remoteOutput = git(repoPath, "remote -v");
  const remoteMap = new Map<string, { name: string; url: string; fetch_url: string | null }>();

  if (remoteOutput) {
    for (const line of remoteOutput.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
      if (match) {
        const rName = match[1]!;
        const rUrl = match[2]!;
        const type = match[3];
        const existing = remoteMap.get(rName) || { name: rName, url: rUrl, fetch_url: null };
        if (type === "fetch") existing.fetch_url = rUrl;
        else existing.url = rUrl;
        remoteMap.set(rName, existing);
      }
    }
  }

  bulkInsertRemotes(
    Array.from(remoteMap.values()).map((r) => ({ ...r, repo_id: repo.id }))
  );

  // Update counts on repo
  const commitCount = (db.query("SELECT COUNT(*) as c FROM commits WHERE repo_id = ?").get(repo.id) as any).c;
  const branchCount = (db.query("SELECT COUNT(*) as c FROM branches WHERE repo_id = ?").get(repo.id) as any).c;
  const tagCount = (db.query("SELECT COUNT(*) as c FROM tags WHERE repo_id = ?").get(repo.id) as any).c;

  db.query("UPDATE repos SET commit_count = ?, branch_count = ?, tag_count = ?, updated_at = datetime('now') WHERE id = ?")
    .run(commitCount, branchCount, tagCount, repo.id);

  return { commits: commitsInserted, branches: branchesInserted, tags: tagsInserted, isNew };
}

export async function scanRepos(
  rootDirs?: string[],
  opts: { full?: boolean; onProgress?: (msg: string) => void; workers?: number } = {}
): Promise<ScanResult> {
  const start = Date.now();
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const roots = rootDirs || [join(home, "Workspace")];
  const { full = false, onProgress, workers: maxWorkers = 4 } = opts;

  onProgress?.(`Discovering repos in: ${roots.join(", ")}`);
  const repoPaths = discoverRepos(roots);
  onProgress?.(`Found ${repoPaths.length} repositories (using ${maxWorkers} workers)`);

  const progressBar = new cliProgress.SingleBar({
    format: "  indexing [{bar}] {percentage}% | {value}/{total} | {filename}",
    hideCursor: true,
    noTTYOutput: !!onProgress,
  });

  if (repoPaths.length > 0) {
    progressBar.start(repoPaths.length, 0, { filename: "" });
  }

  let repos_new = 0;
  let repos_updated = 0;
  let commits_indexed = 0;
  let branches_indexed = 0;
  let tags_indexed = 0;

  const chunks: string[][] = [];
  for (let i = 0; i < repoPaths.length; i += maxWorkers) {
    chunks.push(repoPaths.slice(i, i + maxWorkers));
  }

  let completed = 0;
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map((repoPath) => indexRepo(repoPath, full))
    );
    for (const result of results) {
      completed++;
      if (result.status === "fulfilled") {
        if (result.value.isNew) repos_new++;
        else repos_updated++;
        commits_indexed += result.value.commits;
        branches_indexed += result.value.branches;
        tags_indexed += result.value.tags;
      }
      progressBar.increment({ filename: basename(repoPaths[completed - 1]!) });
    }
  }

  progressBar.stop();

  return {
    repos_found: repoPaths.length,
    repos_new,
    repos_updated,
    commits_indexed,
    branches_indexed,
    tags_indexed,
    duration_ms: Date.now() - start,
  };
}

export function watchRepos(
  rootDirs?: string[],
  opts: {
    full?: boolean;
    onProgress?: (msg: string) => void;
    onRepoChanged?: (repoPath: string) => Promise<void> | void;
  } = {}
): { stop: () => void } {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const roots = rootDirs || [join(home, "Workspace")];

  const repoPaths = discoverRepos(roots);
  const watchedDirs = new Set<string>();

  for (const repoPath of repoPaths) {
    watchedDirs.add(repoPath);
    watch(repoPath, { recursive: true }, (_eventType, filename) => {
      if (filename && !filename.includes(".git/objects")) {
        opts.onProgress?.(`[change] ${filename} in ${basename(repoPath)}`);
        const cb = opts.onRepoChanged?.(repoPath);
        if (cb instanceof Promise) cb.catch(() => {});
      }
    });
  }

  for (const root of roots) {
    watch(root, { recursive: true }, (_eventType, filename) => {
      if (filename && filename.endsWith(".git") && !watchedDirs.has(resolve(root, filename))) {
        const newRepoPath = resolve(root, filename.replace("/.git", ""));
        if (existsSync(newRepoPath)) {
          opts.onProgress?.(`[new] Discovered new repo: ${basename(newRepoPath)}`);
          watchedDirs.add(newRepoPath);
          watch(newRepoPath, { recursive: true }, (et, fn) => {
            if (fn && !fn.includes(".git/objects")) {
              opts.onProgress?.(`[${et}] ${fn} in ${basename(newRepoPath)}`);
              const cb = opts.onRepoChanged?.(newRepoPath);
              if (cb instanceof Promise) cb.catch(() => {});
            }
          });
        }
      }
    });
  }

  opts.onProgress?.(`Watching ${repoPaths.length} repos for changes...`);

  return {
    stop: () => {
      opts.onProgress?.("Stopped watching repos");
    },
  };
}
