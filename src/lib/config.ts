import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface FilterAlias {
  org?: string;
  paths?: string[];
  query?: string;
}

export interface ReposConfig {
  commitLimit?: number;
  incrementalCommitLimit?: number;
  scanDepth?: number;
  excludedPaths?: string[];
  aliases?: Record<string, FilterAlias>;
  workspaceRoots?: string[];
  /**
   * Whether a scan with no explicit `--root` also covers the worktrees root
   * this tool itself owns. Defaults to true; set false only to opt a machine
   * out deliberately.
   */
  includeWorktreesRoot?: boolean;
  hookPollIntervalMs?: number;
  watchDebounceMs?: number;
  workspaceRescanIntervalMs?: number;
}

const DEFAULT_CONFIG: ReposConfig = {
  commitLimit: 5000,
  incrementalCommitLimit: 100,
  scanDepth: 5,
  excludedPaths: ["node_modules", "dist", "vendor", ".git"],
  hookPollIntervalMs: 2000,
  watchDebounceMs: 1500,
  workspaceRescanIntervalMs: 30000,
};

let cachedConfig: ReposConfig | null = null;

export function getReposHomeDir(homeDir = homedir()): string {
  return resolve(homeDir, ".hasna", "repos");
}

export function getConfigPath(homeDir = homedir()): string {
  return process.env["HASNA_REPOS_CONFIG_PATH"] || resolve(getReposHomeDir(homeDir), "config.json");
}

export function getHookQueuePath(homeDir = homedir()): string {
  return process.env["HASNA_REPOS_HOOK_QUEUE_PATH"] || resolve(getReposHomeDir(homeDir), "hook-events.tsv");
}

export function getDefaultWorkspaceRoots(
  homeDir = homedir(),
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  const candidates = [resolve(homeDir, "workspace"), resolve(homeDir, "Workspace")];
  const existing = candidates.filter((path, index) => candidates.indexOf(path) === index && pathExists(path));
  return existing.length > 0 ? existing : [candidates[0]!];
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function getFilterAlias(name: string): FilterAlias | undefined {
  const cfg = getConfig();
  return cfg.aliases?.[name];
}

/**
 * The worktrees root this tool owns and instructs callers to work in.
 *
 * Derived from `getReposHomeDir` rather than written out again, so it cannot
 * drift from the directory the rest of the package already reads and writes.
 */
export function getWorktreesRoot(homeDir = homedir()): string {
  return resolve(getReposHomeDir(homeDir), "worktrees");
}

/**
 * Roots a scan covers when the caller named none.
 *
 * `$HOME/.hasna/repos/worktrees` has to be in this set. Every worktree created
 * under the workspace convention lives there, the path is dot-prefixed so a walk
 * from `$HOME` can never reach it, and it sits outside `$HOME/workspace`
 * entirely — so a bare `repos scan` covered none of it. Measured before this
 * change: `repos scan` reported "Repos found: 6" while
 * `repos scan --root $HOME/.hasna/repos/worktrees/repos` reported 7 new. An
 * agent that creates a worktree, runs `repos scan`, and sees exit code 0 was
 * being told its worktree is indexed when nothing had looked at it.
 *
 * It is unioned in rather than folded into `workspaceRoots` defaults on purpose:
 * a machine with an explicit `workspaceRoots` list would otherwise keep losing
 * it, which is the same silent under-indexing with a config file in front of it.
 * An explicit `--root` still means exactly those roots and nothing more, because
 * a caller naming roots is making a narrower request, not a broader one.
 */
export function getWorkspaceRoots(
  rootDirs?: string[],
  opts: { pathExists?: (path: string) => boolean; homeDir?: string } = {},
): string[] {
  if (rootDirs?.length) return rootDirs.map((root) => resolve(root));
  const pathExists = opts.pathExists ?? existsSync;
  const cfg = getConfig();
  // `getConfig` always resolves `workspaceRoots` — to the file's list when it
  // declares one, otherwise to `getDefaultWorkspaceRoots()` — so there is no
  // "unset" case to fall back for here.
  const roots = (cfg.workspaceRoots ?? []).map((root) => resolve(root));
  if (cfg.includeWorktreesRoot !== false) {
    const worktreesRoot = getWorktreesRoot(opts.homeDir ?? homedir());
    // Only when it exists: a machine that has never created a worktree should
    // not get a scan root that resolves to nothing.
    if (pathExists(worktreesRoot)) roots.push(worktreesRoot);
  }
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

export function getConfig(): ReposConfig {
  if (cachedConfig !== null) return cachedConfig;
  const configPath = getConfigPath();
  const defaults: ReposConfig = {
    ...DEFAULT_CONFIG,
    workspaceRoots: getDefaultWorkspaceRoots(),
  };
  let loaded: ReposConfig = { ...defaults };
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as ReposConfig;
      loaded = {
        ...defaults,
        ...parsed,
        workspaceRoots: parsed.workspaceRoots?.length
          ? parsed.workspaceRoots.map((root) => resolve(root))
          : defaults.workspaceRoots,
      };
    } catch { /* use defaults */ }
  }
  cachedConfig = loaded;
  return loaded;
}
