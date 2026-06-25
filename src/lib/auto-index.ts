import { existsSync, watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getDb, getDbPath } from "../db/database.js";
import { getStorageConfig } from "../db/storage-config.js";
import { pullStorageChanges, pushStorageChanges } from "../db/storage-sync.js";
import type { ScanResult } from "../types/index.js";
import { getConfig, getHookQueuePath, getWorkspaceRoots } from "./config.js";
import { drainHookQueue, installPostCommitHooks } from "./repo-hooks.js";
import { discoverRepos, scanRepoPaths } from "./scanner.js";

const WORKSPACE_BOOTSTRAP_STATE_KEY = "workspace_bootstrap";

export interface StorageSyncSummary {
  direction: "pull" | "push";
  enabled: boolean;
  rowsSynced: number;
  errors: string[];
  skippedReason?: string;
}

export interface WorkspaceBootstrapResult {
  bootstrapped: boolean;
  roots: string[];
  hooks: ReturnType<typeof installPostCommitHooks>;
  scan?: ScanResult;
  storagePull?: StorageSyncSummary;
  storagePush?: StorageSyncSummary;
}

export interface AutoIndexWorker {
  roots: string[];
  stop: () => void;
}

function emptyHookSummary(): ReturnType<typeof installPostCommitHooks> {
  return {
    installed: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    results: [],
  };
}

function getAutomationState<T>(key: string): { value: T; updatedAt: string } | null {
  const db = getDb();
  const row = db.query("SELECT value, updated_at FROM automation_state WHERE key = ?").get(key) as {
    value: string;
    updated_at: string;
  } | null;

  if (!row) return null;

  try {
    return {
      value: JSON.parse(row.value) as T,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function setAutomationState(key: string, value: unknown): void {
  const db = getDb();
  db.query(`
    INSERT INTO automation_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

function getRepoCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM repos").get() as { count: number };
  return row.count;
}

function getSyncTables(): string[] {
  return ["repos", "automation_state"];
}

function resolveRepoPathFromWatchEvent(root: string, filename: string): string | null {
  const normalized = filename.replace(/\\/g, "/");
  const gitMarkerIndex = normalized.indexOf("/.git");
  if (gitMarkerIndex === -1) return null;
  const repoRelativePath = normalized.slice(0, gitMarkerIndex);
  if (!repoRelativePath) return null;
  return resolve(root, repoRelativePath);
}

export async function syncRepoCatalog(
  direction: "pull" | "push",
  onProgress?: (msg: string) => void,
): Promise<StorageSyncSummary> {
  const storageConfig = getStorageConfig();
  if (storageConfig.mode === "local") {
    return {
      direction,
      enabled: false,
      rowsSynced: 0,
      errors: [],
      skippedReason: "local_mode",
    };
  }

  const sqlitePath = getDbPath();
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
    return {
      direction,
      enabled: false,
      rowsSynced: 0,
      errors: [],
      skippedReason: "memory_db",
    };
  }

  try {
    onProgress?.(`[storage] ${direction} repo catalog`);
    const results = direction === "push"
      ? await pushStorageChanges(getSyncTables())
      : await pullStorageChanges(getSyncTables());

    return {
      direction,
      enabled: true,
      rowsSynced: results.reduce((total, result) => total + result.rowsWritten, 0),
      errors: results.flatMap((result) => result.errors),
    };
  } catch (error) {
    return {
      direction,
      enabled: true,
      rowsSynced: 0,
      errors: [(error as Error).message],
    };
  }
}

export async function ensureWorkspaceBootstrap(
  rootDirs?: string[],
  opts: {
    force?: boolean;
    full?: boolean;
    onProgress?: (msg: string) => void;
    syncStorage?: boolean;
    workers?: number;
  } = {},
): Promise<WorkspaceBootstrapResult> {
  const roots = getWorkspaceRoots(rootDirs).map((root) => resolve(root));
  const shouldSyncStorage = opts.syncStorage ?? true;
  const state = getAutomationState<{ roots: string[] }>(WORKSPACE_BOOTSTRAP_STATE_KEY);
  const repoCount = getRepoCount();
  const expectedRoots = JSON.stringify(roots);
  const currentRoots = state ? JSON.stringify(state.value.roots) : null;

  const shouldBootstrap = opts.force || repoCount === 0 || currentRoots !== expectedRoots;
  if (!shouldBootstrap) {
    return {
      bootstrapped: false,
      roots,
      hooks: emptyHookSummary(),
    };
  }

  const storagePull = shouldSyncStorage ? await syncRepoCatalog("pull", opts.onProgress) : undefined;

  const repoPaths = discoverRepos(roots);
  const hooks = installPostCommitHooks(repoPaths, getHookQueuePath());
  opts.onProgress?.(`Bootstrapping repo index from ${roots.join(", ")}`);
  const scan = await scanRepoPaths(repoPaths, {
    full: opts.full,
    onProgress: opts.onProgress,
    workers: opts.workers,
  });

  setAutomationState(WORKSPACE_BOOTSTRAP_STATE_KEY, {
    roots,
    repoCount: scan.repos_found,
    queuePath: getHookQueuePath(),
    bootstrappedAt: new Date().toISOString(),
  });

  const storagePush = shouldSyncStorage ? await syncRepoCatalog("push", opts.onProgress) : undefined;

  return {
    bootstrapped: true,
    roots,
    hooks,
    scan,
    storagePull,
    storagePush,
  };
}

export async function startAutoIndexWorker(
  rootDirs?: string[],
  opts: {
    full?: boolean;
    onProgress?: (msg: string) => void;
    syncStorage?: boolean;
    workers?: number;
  } = {},
): Promise<AutoIndexWorker> {
  const roots = getWorkspaceRoots(rootDirs).map((root) => resolve(root));
  const cfg = getConfig();

  await ensureWorkspaceBootstrap(roots, {
    full: opts.full,
    onProgress: opts.onProgress,
    syncStorage: opts.syncStorage,
    workers: opts.workers,
  });

  const knownRepos = new Set(discoverRepos(roots));
  const pendingScans = new Map<string, ReturnType<typeof setTimeout>>();
  const rootWatchers: Array<ReturnType<typeof watch>> = [];

  const scheduleScan = (repoPath: string, source: string) => {
    const normalizedRepoPath = resolve(repoPath);
    if (pendingScans.has(normalizedRepoPath)) return;

    const timeout = setTimeout(() => {
      pendingScans.delete(normalizedRepoPath);
      void (async () => {
        if (!existsSync(join(normalizedRepoPath, ".git"))) return;
        opts.onProgress?.(`[${source}] indexing ${basename(normalizedRepoPath)}`);
        const result = await scanRepoPaths([normalizedRepoPath], {
          full: opts.full,
          workers: 1,
        });
        opts.onProgress?.(
          `[${source}] ${basename(normalizedRepoPath)} indexed (${result.commits_indexed} commits, ${result.branches_indexed} branches, ${result.tags_indexed} tags)`,
        );
        if (opts.syncStorage ?? true) {
          const syncResult = await syncRepoCatalog("push", opts.onProgress);
          if (syncResult.errors.length > 0) {
            opts.onProgress?.(`[storage] push failed: ${syncResult.errors.join("; ")}`);
          }
        }
      })().catch((error) => {
        opts.onProgress?.(`[error] failed to index ${normalizedRepoPath}: ${(error as Error).message}`);
      });
    }, cfg.watchDebounceMs ?? 1500);

    pendingScans.set(normalizedRepoPath, timeout);
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;

    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const repoPath = resolveRepoPathFromWatchEvent(root, filename.toString());
        if (!repoPath || knownRepos.has(repoPath) || !existsSync(join(repoPath, ".git"))) return;

        knownRepos.add(repoPath);
        const hooks = installPostCommitHooks([repoPath], getHookQueuePath());
        opts.onProgress?.(
          `[new] discovered ${basename(repoPath)} (${hooks.installed} hook installed, ${hooks.updated} updated)`,
        );
        scheduleScan(repoPath, "workspace-watch");
      });
      rootWatchers.push(watcher);
    } catch (error) {
      opts.onProgress?.(`[watch] unable to watch ${root}: ${(error as Error).message}`);
    }
  }

  const hookQueueTimer = setInterval(() => {
    const queuedRepos = drainHookQueue(getHookQueuePath());
    for (const repoPath of queuedRepos) {
      knownRepos.add(repoPath);
      scheduleScan(repoPath, "post-commit");
    }
  }, cfg.hookPollIntervalMs ?? 2000);

  const workspaceRescanTimer = setInterval(() => {
    for (const repoPath of discoverRepos(roots)) {
      if (knownRepos.has(repoPath)) continue;
      knownRepos.add(repoPath);
      const hooks = installPostCommitHooks([repoPath], getHookQueuePath());
      opts.onProgress?.(
        `[new] found ${basename(repoPath)} during rescan (${hooks.installed} hook installed, ${hooks.updated} updated)`,
      );
      scheduleScan(repoPath, "workspace-rescan");
    }
  }, cfg.workspaceRescanIntervalMs ?? 30000);

  opts.onProgress?.(`Auto-index worker watching ${roots.join(", ")}`);

  return {
    roots,
    stop: () => {
      clearInterval(hookQueueTimer);
      clearInterval(workspaceRescanTimer);
      for (const watcher of rootWatchers) {
        watcher.close();
      }
      for (const timeout of pendingScans.values()) {
        clearTimeout(timeout);
      }
      pendingScans.clear();
      opts.onProgress?.("Auto-index worker stopped");
    },
  };
}
