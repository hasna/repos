export * from "./types/index.js";
export { getDb, getDbPath, migrateDb, closeDb, openNonMigratingDb } from "./db/database.js";
export type { DatabaseOpenOptions, NonMigratingDatabaseContext } from "./db/database.js";
export { applyPostgresMigrations } from "./db/pg-migrations.js";
export type { PostgresMigrationClient } from "./db/pg-migrations.js";
export { sanitizeRemoteIdentity, sanitizeRemoteOutput } from "./lib/remote-identity.js";
export {
  BranchAdjudicationError,
  adjudicateBranches,
} from "./db/branch-adjudication.js";
export type {
  BranchAdjudicationErrorCode,
  BranchAdjudicationPlannedRow,
  BranchAdjudicationReceipt,
  BranchAdjudicationRequest,
  BranchAdjudicationResult,
  BranchAdjudicationRowSpec,
} from "./db/branch-adjudication.js";
export {
  PrimaryRelocationError,
  relocatePrimaryRepo,
  sanitizeGitRemoteUrl,
} from "./db/primary-relocation.js";
export type {
  CollisionDecision,
  PrimaryRelocationErrorCode,
  PrimaryRelocationReceipt,
  PrimaryRelocationRequest,
  PrimaryRelocationResult,
  SafeErrorDetails,
  TableReconcileCounts,
} from "./db/primary-relocation.js";
export {
  cleanupRemoteIdentities,
  ensureWorkspaceBootstrap,
  startAutoIndexWorker,
  syncRepoCatalog,
} from "./lib/auto-index.js";
export type {
  RemoteIdentityCleanupCounts,
  RemoteIdentityCleanupOptions,
  RemoteIdentityCleanupSummary,
} from "./lib/auto-index.js";
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
  TASK_WORKTREE_CAPABILITY,
  TASK_WORKTREE_CAPABILITY_SCHEMA,
  TASK_WORKTREE_ERROR_SCHEMA,
  TASK_WORKTREE_RECEIPT_SCHEMA,
  TaskWorktreeError,
  TaskWorktreeService,
  createTaskWorktreeService,
  defaultTaskWorktreeGitAdapter,
  getTaskWorktreeCapabilities,
} from "./lib/task-worktrees.js";
export type {
  CleanupPolicy,
  CleanupTaskWorktreeOptions,
  CreateOrAdoptTaskWorktreeOptions,
  FencedTaskWorktreeOptions,
  RecoverTaskWorktreeOptions,
  TaskWorktreeCapabilities,
  TaskWorktreeErrorCode,
  TaskWorktreeErrorEnvelope,
  TaskWorktreeGate,
  TaskWorktreeGitAdapter,
  TaskWorktreeGitState,
  TaskWorktreeIdentity,
  TaskWorktreeOperation,
  TaskWorktreeOutcome,
  TaskWorktreePullRequestResult,
  TaskWorktreeReceipt,
  TaskWorktreeSelector,
  TaskWorktreeServiceOptions,
  TaskWorktreeStatus,
  TransferTaskWorktreeOptions,
} from "./lib/task-worktrees.js";
export {
  getDocsDrift,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  getReleasePipelineParity,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  triagePullRequests,
  withTodos,
} from "./lib/repo-ops.js";
export type { CommandResult, OpsCommandRunner, OpsIssue, OpsReport, TodosIntegrationOptions, TodosIntegrationResult } from "./lib/repo-ops.js";
export {
  listRepos,
  listAllRepos,
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
  AmbiguousRepoNameError,
} from "./db/repos.js";
export {
  buildDependencyRefresh,
  buildDocsRulesDrift,
  buildPrQueue,
  buildProtectedRelease,
  buildReleaseCandidates,
  buildReleasePipelineParity,
  buildTaskRouteHealth,
  buildWorkspaceWorktreeHygiene,
  inspectPackageHygiene,
  runGlobalCliSmoke,
} from "./lib/ops-producers.js";
export {
  upsertTaskSeeds,
  writeLoopReport,
} from "./lib/ops-loop-tasks.js";
export type {
  CliSmokeOptions,
  CliSmokeResult,
  DependencyRefreshOptions,
  DependencyRefreshResult,
  DocsRulesDriftOptions,
  DocsRulesDriftResult,
  PackageHygieneOptions,
  PackageHygieneResult,
  PrQueueOptions,
  ProtectedReleaseOptions,
  ProtectedReleaseResult,
  RepoPrQueueResult,
  ReleaseCandidateOptions,
  ReleaseCandidateResult,
  ReleasePipelineParityItem,
  ReleasePipelineParityQueueOptions,
  ReleasePipelineParityQueueResult,
  TaskRouteHealthOptions,
  TaskRouteHealthResult,
  TaskSeed,
  WorkspaceWorktreeHygieneOptions,
  WorkspaceWorktreeHygieneResult,
} from "./lib/ops-producers.js";
export type {
  TodosCommandResult,
  TodosRunner,
  UpsertTaskSeedsOptions,
  UpsertTaskSeedsResult,
} from "./lib/ops-loop-tasks.js";
