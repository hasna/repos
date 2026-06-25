export * from "./types/index.js";
export { getDb, closeDb } from "./db/database.js";
export {
  getStorageConfig,
  getStorageConnectionString,
  type StorageConfig,
  type StorageMode,
} from "./db/storage-config.js";
export { PgAdapterAsync } from "./db/remote-storage.js";
export { applyPgMigrations } from "./db/pg-migrate.js";
export {
  STORAGE_TABLES,
  getStoragePg,
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  runStorageMigrations,
  syncStorageChanges,
} from "./db/storage-sync.js";
export type { StorageStatus, SyncResult } from "./db/storage-sync.js";
export { ensureWorkspaceBootstrap, startAutoIndexWorker, syncRepoCatalog } from "./lib/auto-index.js";
export { drainHookQueue, installPostCommitHook, installPostCommitHooks } from "./lib/repo-hooks.js";
export { discoverRepos, scanRepoPaths, scanRepos, watchRepos } from "./lib/scanner.js";
export { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "./lib/github.js";
export {
  listRepos,
  getRepo,
  searchRepos,
  listCommits,
  searchCommits,
  listBranches,
  listTags,
  listPullRequests,
  searchAll,
  getRepoStats,
  getGlobalStats,
} from "./db/repos.js";
