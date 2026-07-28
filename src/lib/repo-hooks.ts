import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getHookQueuePath } from "./config.js";

export const HOOK_MARKER_START = "# >>> hasna repos auto-index >>>";
export const HOOK_MARKER_END = "# <<< hasna repos auto-index <<<";

export interface HookInstallResult {
  repoPath: string;
  hookPath: string | null;
  status: "installed" | "updated" | "unchanged" | "skipped";
  reason?: string;
  error?: string;
}

export interface HookInstallSummary {
  installed: number;
  updated: number;
  unchanged: number;
  skipped: number;
  results: HookInstallResult[];
}

export type GitDirResolution =
  | { status: "ok"; gitDir: string }
  | { status: "missing_repo_root" }
  | { status: "missing_git_dir" }
  | { status: "dangling_git_dir"; target: string }
  | { status: "not_a_git_dir"; target: string }
  | { status: "unreadable_git_dir" };

/**
 * A git directory always holds `HEAD`; a linked worktree's also holds `commondir`. Existence is
 * not gitness — `gitdir: ../innocent` resolves to a perfectly real directory that is not a
 * repository, and a husk left by this bug is a `.git` containing only `hooks/` and `worktrees/`.
 * Writing into either is the same mistake as writing into one that is missing.
 */
function looksLikeGitDir(candidate: string): boolean {
  return existsSync(join(candidate, "HEAD")) || existsSync(join(candidate, "commondir"));
}

/**
 * Resolve a checkout's real git directory.
 *
 * A `.git` FILE holds a `gitdir:` pointer (linked worktrees, submodules). That pointer is a
 * claim, not a fact: when the repository it names has been removed the target no longer exists.
 * Such a pointer must resolve to `dangling_git_dir`, never to a path — callers create
 * directories under whatever this returns, and handing back a path into a missing repository is
 * how empty directories get dressed up as broken repositories.
 */
export function resolveGitDirDetailed(repoPath: string): GitDirResolution {
  const dotGitPath = join(repoPath, ".git");
  if (!existsSync(dotGitPath)) {
    return existsSync(repoPath) ? { status: "missing_git_dir" } : { status: "missing_repo_root" };
  }

  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) {
      return looksLikeGitDir(dotGitPath)
        ? { status: "ok", gitDir: dotGitPath }
        : { status: "not_a_git_dir", target: dotGitPath };
    }

    const raw = readFileSync(dotGitPath, "utf-8");
    const match = raw.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return { status: "unreadable_git_dir" };

    const target = resolve(repoPath, match[1].trim());
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return { status: "dangling_git_dir", target };
    }
    if (!looksLikeGitDir(target)) return { status: "not_a_git_dir", target };
    return { status: "ok", gitDir: target };
  } catch {
    return { status: "unreadable_git_dir" };
  }
}

export function resolveGitDir(repoPath: string): string | null {
  const resolution = resolveGitDirDetailed(repoPath);
  return resolution.status === "ok" ? resolution.gitDir : null;
}

function buildHookSnippet(queuePath: string): string {
  return `${HOOK_MARKER_START}
HASNA_REPOS_HOOK_QUEUE="${queuePath}"
REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
mkdir -p "$(dirname "$HASNA_REPOS_HOOK_QUEUE")"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_DIR" >> "$HASNA_REPOS_HOOK_QUEUE"
${HOOK_MARKER_END}`;
}

export function installPostCommitHook(repoPath: string, queuePath = getHookQueuePath()): HookInstallResult {
  const resolution = resolveGitDirDetailed(repoPath);
  if (resolution.status !== "ok") {
    // A repository that is not there is an error to report, not a tree to invent.
    return {
      repoPath,
      hookPath: null,
      status: "skipped",
      reason: resolution.status,
    };
  }

  const gitDir = resolution.gitDir;
  const hooksDir = join(gitDir, "hooks");
  // Deliberately NOT recursive: gitDir is verified to exist, so `hooks` is the only level that
  // may be missing. `recursive: true` is the flag that turns "write into a directory that is
  // gone" into "fabricate every ancestor on the way there", and that is the whole bug.
  try {
    mkdirSync(hooksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const hookPath = join(hooksDir, "post-commit");
  const existed = existsSync(hookPath);
  const existing = existed ? readFileSync(hookPath, "utf-8") : "";

  if (existing.includes(HOOK_MARKER_START)) {
    return { repoPath, hookPath, status: "unchanged" };
  }

  let content = existing.trimEnd();
  if (!content.startsWith("#!")) {
    content = "#!/bin/sh\nset -e\n" + (content ? `\n${content}` : "");
  }
  if (content && !content.endsWith("\n")) content += "\n";
  if (content.trim().length > 0 && !content.endsWith("\n\n")) content += "\n";
  content += `${buildHookSnippet(queuePath)}\n`;

  writeFileSync(hookPath, content);
  chmodSync(hookPath, 0o755);

  return {
    repoPath,
    hookPath,
    status: existed ? "updated" : "installed",
  };
}

export function installPostCommitHooks(repoPaths: string[], queuePath = getHookQueuePath()): HookInstallSummary {
  const results = repoPaths.map((repoPath) => {
    // One unwritable or vanishing repository must not abort the batch. The non-recursive mkdir
    // turns a gitdir that disappears mid-run into a throw, and in the auto-index watcher that
    // throw would escape the fs.watch callback and take the daemon down.
    try {
      return installPostCommitHook(repoPath, queuePath);
    } catch (error) {
      return {
        repoPath,
        hookPath: null,
        status: "skipped" as const,
        reason: "install_failed",
        error: (error as Error).message,
      };
    }
  });
  return {
    installed: results.filter((result) => result.status === "installed").length,
    updated: results.filter((result) => result.status === "updated").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  };
}

/**
 * Describe checkouts whose `.git` points at a git directory that is gone. These used to be
 * fabricated into existence silently; they are worth surfacing because an orphan worktree may
 * still hold the only copy of unpushed work.
 */
export function describeDanglingCheckouts(summary: HookInstallSummary, limit = 5): string | null {
  const dangling = summary.results.filter((result) => result.reason === "dangling_git_dir");
  if (dangling.length === 0) return null;

  const names = dangling.slice(0, limit).map((result) => basename(result.repoPath));
  const suffix = dangling.length > limit ? `, +${dangling.length - limit} more` : "";
  return `${dangling.length} checkout(s) point at a git directory that no longer exists (orphan worktrees; hooks not installed): ${names.join(", ")}${suffix}`;
}

export function drainHookQueue(queuePath = getHookQueuePath()): string[] {
  if (!existsSync(queuePath)) return [];

  const raw = readFileSync(queuePath, "utf-8");
  writeFileSync(queuePath, "");

  const queue = raw.trim();
  if (!queue) return [];

  const repos = new Set<string>();
  for (const line of queue.split("\n")) {
    const parts = line.split("\t");
    const repoPath = parts[parts.length - 1]?.trim();
    if (!repoPath) continue;
    repos.add(resolve(repoPath));
  }

  return Array.from(repos);
}
