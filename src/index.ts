export * from "./types/index.js";
export { getDb, closeDb } from "./db/database.js";
export { ensureWorkspaceBootstrap, startAutoIndexWorker, syncRepoCatalog } from "./lib/auto-index.js";
export { drainHookQueue, installPostCommitHook, installPostCommitHooks } from "./lib/repo-hooks.js";
export { discoverRepos, scanRepoPaths, scanRepos, watchRepos } from "./lib/scanner.js";
export { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "./lib/github.js";
export {
  applyGithubCatalogFilter,
  enumerateGithubRepoCatalog,
  extractGithubFullNameFromRemote,
  getDefaultGithubCatalogCachePath,
  iterateGithubRepoCatalog,
  loadGithubRepoCatalog,
  syncGithubRepoCatalog,
} from "./lib/github-catalog.js";
export type {
  EnumerateGithubRepoCatalogOptions,
  GithubCatalogAccount,
  GithubLocalStatus,
  GithubPackageHints,
  GithubRateLimitSnapshot,
  GithubRepoCatalogCache,
  GithubRepoCatalogEnvelope,
  GithubRepoCatalogFilter,
  GithubRepoCatalogRecord,
  SyncGithubRepoCatalogOptions,
} from "./lib/github-catalog.js";
export { getReposStatus } from "./lib/status.js";
export type { ReposStatusContract } from "./lib/status.js";
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
