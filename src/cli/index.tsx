#!/usr/bin/env bun
import { registerEventsCommands } from "@hasna/events/commander";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { program } from "commander";
import { getCliVersion } from "./version.js";
import { parseIntOption } from "./args.js";
import chalk from "chalk";
import {
  listRepos,
  getRepo,
  listCommits,
  listBranches,
  listTags,
  listPullRequests,
  countPullRequests,
  countRepos,
  getRepoByRemote,
  searchAll,
  getGlobalStats,
  getRepoStats,
  AmbiguousRepoNameError,
  AmbiguousRemoteError,
} from "../db/repos.js";
import {
  BranchAdjudicationError,
  adjudicateBranches,
  type BranchAdjudicationRequest,
  type BranchAdjudicationRowSpec,
} from "../db/branch-adjudication.js";
import {
  PrimaryRelocationError,
  relocatePrimaryRepo,
} from "../db/primary-relocation.js";
import {
  RegistryPruneError,
  pruneRegistryRows,
} from "../db/registry-prune.js";
import { getDbPath } from "../db/database.js";
import {
  ensureWorkspaceBootstrap,
  startAutoIndexWorker,
} from "../lib/auto-index.js";
import { getFilterAlias } from "../lib/config.js";
import { sanitizeRemoteIdentity } from "../lib/remote-identity.js";
import { getReposStatus } from "../lib/status.js";
import { formatRepoNotFoundMessage } from "./messages.js";
import { printJson, printJsonLine, printLine } from "./stdout.js";
import { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "../lib/github.js";
import { enumerateGithubRepoCatalog } from "../lib/github-catalog.js";
import { getActivityHeatmap, getContributorStats, getStaleRepos, getRecentActivity } from "../lib/analytics.js";
import { buildGraph, queryNode, queryRelated, findPath, getDeps, getCrossOrgAuthors, getGraphStats } from "../lib/graph.js";
import {
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
  type TaskSeed,
} from "../lib/ops-producers.js";
import { upsertTaskSeeds, writeLoopReport } from "../lib/ops-loop-tasks.js";
import { findFile, whoIs, diffStats, getDirtyRepos, getUnpushedRepos, getBehindRepos, getHealthReport, getRepoPath, getReport, getChurn, getLanguages, exportRepos, importFromOrg, fuzzyFindRepo } from "../lib/utils.js";
import {
  getDocsDrift,
  getManifestDependents,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  getReleasePipelineParity,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  triagePullRequests,
  withTodos,
} from "../lib/repo-ops.js";
import { getNoCloudInventory } from "../lib/no-cloud-inventory.js";
import {
  WORKTREE_ADOPT_SCHEMA,
  WORKTREE_LEASE_SCHEMA,
  WORKTREE_LIST_SCHEMA,
  WorktreeError,
  addWorktree,
  adoptWorktrees,
  listWorktrees,
  releaseWorktree,
  removeWorktree,
} from "../lib/worktrees.js";
import {
  REPO_ARCHIVE_SCHEMA,
  REPO_CLONE_SCHEMA,
  REPO_CREATE_SCHEMA,
  RepoLifecycleError,
  archiveRepository,
  cloneRepository,
  createRepository,
} from "../lib/repo-lifecycle.js";

const ORG_ALIASES: Record<string, string> = {
  oss: "hasna",
  xyz: "hasnaxyz",
  studio: "hasnastudio",
  tools: "hasnatools",
  ai: "hasnaai",
  education: "hasnaeducation",
  family: "hasnafamily",
};

const AUTO_BOOTSTRAP_SKIP_COMMANDS = new Set([
  "scan",
  "watch",
  "backup",
  "restore",
  "completions",
  "import",
  "ops",
  "package",
  "ports",
  "triage",
  "docs",
  "release",
  "no-cloud",
  "release-health",
  "registry",
  // Worktree verbs read and write the registry deliberately; triggering a
  // workspace scan first would make a `worktree add` mutate the index as a side
  // effect of creating a directory.
  "worktree",
  // Repository-plane verbs register their own clone; a workspace scan first
  // would be the same side-effect mutation, plus minutes of latency in front
  // of a network operation.
  "create",
  "clone",
]);

program
  .name("repos")
  .description("Local repo intelligence — track all repos, search commits, PRs, branches")
  .version(getCliVersion());

function requireRepo(repoInput: string) {
  let repo;
  try {
    repo = getRepo(repoInput);
  } catch (error) {
    if (error instanceof AmbiguousRepoNameError) {
      console.error(chalk.red(error.message));
      process.exit(1);
    }
    throw error;
  }
  if (repo) return repo;

  const suggestion = fuzzyFindRepo(repoInput);
  console.error(
    chalk.red(
      formatRepoNotFoundMessage(
        repoInput,
        suggestion ? { name: suggestion.name, path: suggestion.path } : undefined
      )
    )
  );
  process.exit(1);
}

function intFlag(value: string, flagName: string, min = 0) {
  try {
    return parseIntOption(value, flagName, min);
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

function optionalIntFlag(value: string | undefined, flagName: string, min = 0) {
  return value === undefined ? undefined : intFlag(value, flagName, min);
}

function csvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function printOpsJson(report: unknown, pretty?: boolean) {
  printLine(JSON.stringify(report, null, pretty ? 2 : 0));
}

function collectValues(value: string, previous: string[] = []) {
  previous.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
  return previous;
}

function addOpsOptions(command: any) {
  return command
    .option("-n, --limit <n>", "Max returned items", "20")
    .option("--pretty", "Pretty-print JSON")
    .option("--todo <id>", "Attach a compact comment preview for this todos task")
    .option("--todo-apply", "Actually write the todos comment; without this it is a dry run")
    .option("--todo-agent <name>", "todos agent name for --todo-apply")
    .option("--todo-project <path>", "todos project path for --todo-apply");
}

function addLoopProducerOptions(command: any, defaultMaxActions = 20) {
  return command
    .option("--report-dir <path>", "Write the full JSON envelope to this directory for loop evidence")
    .option("--upsert-tasks", "Create deduped todos tasks from emitted task suggestions")
    .option("--todos-project <path>", "todos project path for --upsert-tasks")
    .option("--task-list <slug>", "Task list slug for --upsert-tasks")
    .option("--max-task-actions <n>", "Maximum new todos tasks to create per run; existing-task checks continue for dedupe", String(defaultMaxActions));
}

interface LoopProducerOpts {
  reportDir?: string;
  upsertTasks?: boolean;
  todosProject?: string;
  taskList?: string;
  maxTaskActions: string;
}

type LoopTaskUpsert = ReturnType<typeof upsertTaskSeeds>;
interface LoopArtifacts {
  report_path?: string;
  task_upsert?: LoopTaskUpsert;
}

type LoopProducerEnvelope<T extends object> = T & {
  loop?: LoopArtifacts;
};

function applyLoopProducerArtifacts<T extends object>(
  report: T,
  seeds: TaskSeed[],
  opts: LoopProducerOpts,
  defaults: {
    reportPrefix: string;
    taskList: string;
    taskListName: string;
    taskListDescription: string;
  },
): LoopProducerEnvelope<T> {
  const loop: LoopArtifacts = {};
  if (opts.upsertTasks) {
    loop.task_upsert = upsertTaskSeeds(seeds, {
      project: opts.todosProject || defaultLoopsTodosProject(),
      taskList: opts.taskList || defaults.taskList,
      taskListName: defaults.taskListName,
      taskListDescription: defaults.taskListDescription,
      maxActions: intFlag(opts.maxTaskActions, "--max-task-actions", 1),
    });
  }
  const envelope = Object.keys(loop).length > 0 ? { ...report, loop } : report;
  if (opts.reportDir) {
    loop.report_path = writeLoopReport(envelope, { reportDir: opts.reportDir, prefix: defaults.reportPrefix, annotatePath: true });
  }
  return Object.keys(loop).length > 0 ? { ...report, loop } : report;
}

function defaultLoopsTodosProject(): string {
  return process.env["LOOPS_TODOS_PROJECT"] || `${process.env["HOME"] || "/home/hasna"}/.hasna/loops`;
}

function loopProducerHadErrors(report: { loop?: { task_upsert?: LoopTaskUpsert } }): boolean {
  return Boolean(report.loop?.task_upsert && report.loop.task_upsert.summary.errors > 0);
}

function syncFailed(synced: { errors: string[] } | undefined, allowSyncErrors: boolean | undefined): boolean {
  return !allowSyncErrors && Boolean(synced && synced.errors.length > 0);
}

function todosOpts(opts: any, cwd: string) {
  return {
    taskId: opts.todo,
    apply: Boolean(opts.todoApply),
    agent: opts.todoAgent,
    project: opts.todoProject,
    cwd,
  };
}

const COMPACT_LIMIT = 20;

function compactText(value: unknown, max = 96): string {
  const text = String(value ?? "")
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1***@")
    .replace(/\b(token|password|secret)=([^&\s]+)/gi, "$1=***")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function compactList(values: string[], maxItems = 3, maxChars = 72): string {
  const shown = values.slice(0, maxItems).join(", ");
  const suffix = values.length > maxItems ? ` +${values.length - maxItems} more` : "";
  return compactText(`${shown}${suffix}`, maxChars);
}

function day(value?: string | null): string {
  return value ? value.slice(0, 10) : "-";
}

function resolveLimit(opts: any, humanDefault = COMPACT_LIMIT, jsonDefault = humanDefault): number {
  return intFlag(String(opts.limit ?? (opts.json ? jsonDefault : humanDefault)), "--limit", 1);
}

function resolveOffset(opts: any): number {
  const flagName = opts.cursor !== undefined ? "--cursor" : "--offset";
  return intFlag(String(opts.cursor ?? opts.offset ?? "0"), flagName, 0);
}

/**
 * Announce, on stderr, that a JSON page did not contain every matching record.
 *
 * A default page size that silently drops rows is a correctness bug for
 * scripted callers: `repos repos --json` returning 50 of 1243 looks exactly
 * like a complete answer. stderr keeps the JSON on stdout machine-readable.
 */
function warnIfTruncated(opts: { shown: number; total: number; limit: number; offset: number; noun: string }): void {
  const seen = opts.offset + opts.shown;
  if (seen >= opts.total) return;
  console.error(chalk.yellow(
    `warning: showing ${opts.shown} of ${opts.total} ${opts.noun} (offset ${opts.offset}, limit ${opts.limit}). ` +
    `Pass -n ${opts.total} or page with --cursor ${seen} to see the rest.`
  ));
}

function printCompactHint(opts: {
  count: number;
  noun: string;
  limit?: number;
  offset?: number;
  pageable?: boolean;
  detail?: string;
  verbose?: boolean;
  json?: boolean;
}): void {
  const parts = [`Showing ${opts.count} ${opts.noun}`];
  if (opts.pageable && opts.limit && opts.count >= opts.limit) {
    parts.push(`next page: --cursor ${(opts.offset ?? 0) + opts.limit}`);
  }
  if (opts.detail) parts.push(opts.detail);
  if (!opts.verbose) parts.push("use --verbose for wider rows");
  if (!opts.json) parts.push("use --json for full records");
  console.log(chalk.dim(`\n${parts.join(". ")}.`));
}

async function bootstrapCliIfNeeded(argv: string[]) {
  if (process.env["HASNA_REPOS_AUTO_BOOTSTRAP"] === "0") {
    return;
  }

  if (argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-V")) {
    return;
  }

  const command = argv.find((arg) => !arg.startsWith("-"));
  if (!command || AUTO_BOOTSTRAP_SKIP_COMMANDS.has(command)) {
    return;
  }

  const quiet = argv.includes("--json");
  await ensureWorkspaceBootstrap(undefined, {
    syncRemote: false,
    onProgress: quiet ? undefined : (msg) => console.log(chalk.dim(`[auto-index] ${msg}`)),
  });
}

// ── Scan ──
program
  .command("scan")
  .description("Scan directories to discover and index git repos")
  .option("--root <paths...>", "Root directories to scan")
  .option("--filter <name>", "Use a saved filter alias to get root paths")
  .option("--full", "Full re-scan (not incremental)")
  .option("-w, --workers <n>", "Number of parallel workers", "4")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const roots = alias?.paths ?? opts.root;
    if (opts.filter && !roots?.length) {
      console.log(chalk.yellow(`Filter '${opts.filter}' has no paths defined`));
    }
    const result = await ensureWorkspaceBootstrap(roots, {
      force: true,
      full: opts.full,
      workers: intFlag(opts.workers, "--workers", 1),
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    const scan = result.scan ?? {
      repos_found: 0,
      repos_new: 0,
      repos_updated: 0,
      commits_indexed: 0,
      branches_indexed: 0,
      tags_indexed: 0,
      duration_ms: 0,
    };
    const hookSummary = {
      installed: result.hooks.installed,
      updated: result.hooks.updated,
      unchanged: result.hooks.unchanged,
      skipped: result.hooks.skipped,
    };
    if (opts.json) {
      printJson({ ...scan, hooks: hookSummary });
    } else {
      console.log(chalk.green(`\n✓ Scan complete in ${(scan.duration_ms / 1000).toFixed(1)}s`));
      console.log(`  Repos found: ${scan.repos_found} (${scan.repos_new} new, ${scan.repos_updated} updated)`);
      console.log(`  Commits indexed: ${scan.commits_indexed}`);
      console.log(`  Branches indexed: ${scan.branches_indexed}`);
      console.log(`  Tags indexed: ${scan.tags_indexed}`);
      console.log(`  Hooks: ${hookSummary.installed} installed, ${hookSummary.updated} updated, ${hookSummary.unchanged} unchanged`);
    }
  });

// ── Watch ──
program
  .command("watch")
  .description("Run the workspace auto-index worker (new repos + post-commit re-indexing)")
  .option("--root <paths...>", "Root directories to watch")
  .option("--filter <name>", "Use a saved filter alias to get root paths")
  .option("--full", "Full re-index on change (not incremental)")
  .option("-w, --workers <n>", "Number of parallel workers for bootstrap scans", "4")
  .action(async (opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config.`));
      process.exit(1);
    }
    const roots = alias?.paths ?? opts.root;
    console.log(chalk.blue("Starting auto-index worker..."));
    const worker = await startAutoIndexWorker(roots, {
      full: opts.full,
      workers: intFlag(opts.workers, "--workers", 1),
      onProgress: (msg) => console.log(chalk.dim(msg)),
    });

    process.on("SIGINT", () => {
      worker.stop();
      process.exit(0);
    });
  });

// ── Repos ──
program
  .command("repos")
  .description("List repositories")
  .option("--filter <name>", "Use a saved filter alias from config")
  .option("--org <org>", "Filter by org (also: --oss, --xyz, --studio, --tools, --ai, --education, --family)")
  .option("--oss", "Filter by hasna org (shorthand)")
  .option("--xyz", "Filter by hasnaxyz org (shorthand)")
  .option("--studio", "Filter by hasnastudio org (shorthand)")
  .option("--tools", "Filter by hasnatools org (shorthand)")
  .option("--ai", "Filter by hasnaai org (shorthand)")
  .option("--education", "Filter by hasnaeducation org (shorthand)")
  .option("--family", "Filter by hasnafamily org (shorthand)")
  .option("-q, --query <query>", "Filter by name")
  .option("-n, --limit <n>", "Max results (default: 20 human, 50 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show descriptions and full paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const alias = opts.filter ? getFilterAlias(opts.filter) : undefined;
    if (opts.filter && !alias) {
      console.log(chalk.red(`Filter '${opts.filter}' not found in config. Define aliases in ~/.hasna/repos/config.json`));
      process.exit(1);
    }
    const org = alias?.org ?? (opts.oss ? "hasna" : opts.xyz ? "hasnaxyz" : opts.studio ? "hasnastudio" : opts.tools ? "hasnatools" : opts.ai ? "hasnaai" : opts.education ? "hasnaeducation" : opts.family ? "hasnafamily" : (opts.org ? ORG_ALIASES[opts.org] ?? opts.org : undefined));
    const query = alias?.query ?? opts.query;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const offset = resolveOffset(opts);
    const repos = listRepos({ org, query, limit, offset });
    const total = countRepos({ org, query });
    if (opts.json) {
      printJson(repos);
      warnIfTruncated({ shown: repos.length, total, limit, offset, noun: "repo(s)" });
    } else {
      if (repos.length === 0) { console.log(chalk.dim("No repos found. Run: repos scan")); return; }
      for (const r of repos) {
        const org = r.org ? chalk.blue(`[${r.org}]`) : "";
        console.log(`${chalk.bold(r.name)} ${org} ${chalk.dim(`${r.commit_count} commits, ${r.branch_count} branches, ${r.tag_count} tags`)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`  ${compactText(r.path, 140)}`));
          if (r.description) console.log(chalk.dim(`  ${compactText(r.description, 140)}`));
        }
      }
      printCompactHint({
        count: repos.length,
        noun: "repo(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: `${total} match this filter. Use \`repos show <name>\` for repo details`,
      });
    }
  });

/**
 * Resolve the repo a command should act on.
 *
 * `--remote github.com/<org>/<name>` is the deterministic form: it matches the
 * GitHub identity exactly and fails loudly when a remote has several local
 * checkouts, instead of silently picking one. The positional name remains
 * available and unchanged for interactive use.
 */
function resolveTargetRepo(name: string | undefined, opts: any) {
  if (opts.remote) {
    if (name) {
      console.error(chalk.red("Error: pass either a repo name or --remote, not both"));
      process.exit(1);
    }
    let repo;
    try {
      repo = getRepoByRemote(opts.remote);
    } catch (error) {
      if (error instanceof AmbiguousRemoteError) {
        console.error(chalk.red(error.message));
        process.exit(1);
      }
      throw error;
    }
    if (!repo) {
      // Echo only the sanitized identity, never the caller's raw argument: a
      // rejected remote is exactly the case where the input may still carry
      // embedded credentials (https://user:token@host/org/repo).
      const safe = sanitizeRemoteIdentity(opts.remote)
        ?? sanitizeRemoteIdentity(`github.com/${String(opts.remote).replace(/^\/+/, "")}`);
      console.error(chalk.red(safe
        ? `No indexed repo has remote '${safe}'`
        : "No indexed repo matched --remote (value was not a usable host/org/name identity)"));
      process.exit(1);
    }
    return repo;
  }
  if (!name) {
    console.error(chalk.red("Error: provide a repo name or --remote <host/org/name>"));
    process.exit(1);
  }
  return requireRepo(name);
}

function printRepoDetails(name: string | undefined, opts: any) {
    const repo = resolveTargetRepo(name, opts);
    const stats = getRepoStats(repo.id);
    if (opts.json) {
      printJson({ ...repo, ...stats });
    } else {
      console.log(chalk.bold(repo.name));
      console.log(`  Path: ${repo.path}`);
      if (repo.org) console.log(`  Org: ${chalk.blue(repo.org)}`);
      if (repo.remote_url) console.log(`  Remote: ${repo.remote_url}`);
      console.log(`  Branch: ${repo.default_branch}`);
      console.log(`  Commits: ${stats.commit_count}, Branches: ${stats.branch_count}, Tags: ${stats.tag_count}, PRs: ${stats.pr_count}`);
      if (stats.top_authors.length > 0) {
        console.log(chalk.dim("\n  Top authors:"));
        for (const a of stats.top_authors.slice(0, opts.verbose ? 10 : 5)) {
          console.log(`    ${a.author} (${a.count} commits)`);
        }
      }
      if (stats.recent_commits.length > 0) {
        console.log(chalk.dim("\n  Recent commits:"));
        for (const c of stats.recent_commits.slice(0, opts.verbose ? 10 : 5)) {
          console.log(`    ${chalk.yellow(c.sha.slice(0, 8))} ${compactText(c.message, opts.verbose ? 160 : 80)} ${chalk.dim(day(c.date))}`);
        }
      }
      if (!opts.verbose) {
        console.log(chalk.dim("\nUse --verbose for more authors and commits, or --json for the full record."));
      }
    }
}

const REMOTE_OPTION = "--remote <host/org/name>";
const REMOTE_OPTION_HELP = "Resolve by exact GitHub remote, e.g. github.com/hasna/emails";

program
  .command("repo [name]")
  .description("Get repo details")
  .option(REMOTE_OPTION, REMOTE_OPTION_HELP)
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

program
  .command("show [name]")
  .description("Show repo details")
  .option(REMOTE_OPTION, REMOTE_OPTION_HELP)
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

program
  .command("inspect [name]")
  .description("Inspect repo details")
  .option(REMOTE_OPTION, REMOTE_OPTION_HELP)
  .option("--verbose", "Show larger detail sections")
  .option("--json", "Output as JSON")
  .action(printRepoDetails);

// ── Registry safety operations ──
const registry = program
  .command("registry")
  .description("Fail-closed local registry maintenance operations");

registry
  .command("relocate-primary")
  .description("Losslessly absorb a registered canonical target into a preserved legacy repo ID")
  .requiredOption("--repo-id <id>", "Legacy numeric repo row ID that must survive")
  .requiredOption("--expected-current-path <path>", "Expected path stored on the legacy row")
  .requiredOption("--expected-source-revision <revision>", "Exact legacy row updated_at revision")
  .requiredOption("--target-repo-id <id>", "Registered canonical target repo row ID to absorb")
  .requiredOption("--target-path <path>", "Expected canonical target Git checkout/worktree path")
  .requiredOption("--expected-target-revision <revision>", "Exact target row updated_at revision")
  .requiredOption("--expected-remote <host/owner/name>", "Credential-free expected remote identity")
  .requiredOption("--expected-head <sha>", "Exact lowercase target HEAD object ID")
  .requiredOption("--actor <actor>", "Auditable operator or workflow identity")
  .requiredOption("--idempotency-key <key>", "Stable unique key for this logical relocation")
  .option("--expected-plan-hash <sha256>", "Exact plan hash emitted by the dry run; required with --apply")
  .option("--preserve-divergent-branches-under <namespace>", "Preserve divergent legacy branches as <namespace>/<branch> when exact target refs already exist")
  .option("--dry-run", "Plan reconciliation without writing (default)")
  .option("--apply", "Atomically reconcile both rows using the supplied dry-run plan hash")
  .option("--json", "Output the versioned JSON result")
  .action((opts) => {
    const json = Boolean(opts.json);
    try {
      if (opts.apply && opts.dryRun) {
        throw new PrimaryRelocationError(
          "INVALID_REQUEST",
          "--apply and --dry-run are mutually exclusive",
        );
      }
      const result = relocatePrimaryRepo({
        repoId: parseIntOption(opts.repoId, "--repo-id", 1),
        expectedCurrentPath: opts.expectedCurrentPath,
        expectedSourceRevision: opts.expectedSourceRevision,
        targetRepoId: parseIntOption(opts.targetRepoId, "--target-repo-id", 1),
        targetPath: opts.targetPath,
        expectedTargetRevision: opts.expectedTargetRevision,
        expectedRemote: opts.expectedRemote,
        expectedHead: opts.expectedHead,
        actor: opts.actor,
        idempotencyKey: opts.idempotencyKey,
        expectedPlanHash: opts.expectedPlanHash,
        preserveDivergentBranchesUnder: opts.preserveDivergentBranchesUnder,
        apply: Boolean(opts.apply),
        databasePath: getDbPath(),
      });
      if (json) {
        printJson(result);
      } else if (result.applied) {
        console.log(chalk.green(`✓ Absorbed repo ${result.target_repo_id} into preserved repo ${result.repo_id}`));
        console.log(`  ${result.before.path} → ${result.after.path}`);
        console.log(chalk.dim(`  Receipt: ${result.receipt!.id}`));
      } else {
        const disposition = result.plan.can_apply ? "is safe to apply" : "has blocking collisions";
        console.log(chalk.yellow(`Dry run: repo ${result.repo_id} ${disposition}`));
        console.log(`  ${result.before.path} → ${result.after.path}`);
        console.log(chalk.dim(`  Plan: ${result.plan.plan_hash}`));
        console.log(chalk.dim("  Re-run with --apply --expected-plan-hash <plan> to reconcile atomically."));
      }
    } catch (error) {
      const code = error instanceof PrimaryRelocationError ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : "unknown relocation error";
      if (json) {
        const details = error instanceof PrimaryRelocationError ? error.details : undefined;
        printJson({ schema: "open-repos.primary-relocation.v2", ok: false, error: { code, message, details } });
      } else {
        console.error(chalk.red(`${code}: ${message}`));
      }
      process.exitCode = 1;
    }
  });

function branchAdjudicationSpecFromFile(path: string): Omit<BranchAdjudicationRequest, "actor" | "idempotencyKey" | "apply" | "expectedPlanHash" | "databasePath"> & {
  actor?: string;
  idempotency_key?: string;
  idempotencyKey?: string;
} {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BranchAdjudicationError("INVALID_REQUEST", "spec file must contain a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  if (!Array.isArray(object["rows"])) {
    throw new BranchAdjudicationError("INVALID_REQUEST", "spec file must contain rows[]");
  }
  const rows = object["rows"].map((value, index): BranchAdjudicationRowSpec => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BranchAdjudicationError("INVALID_REQUEST", `rows[${index}] must be an object`);
    }
    const row = value as Record<string, unknown>;
    const expectedIsRemote = row["expected_is_remote"] ?? row["expectedIsRemote"];
    return {
      id: Number(row["id"]),
      repoId: Number(row["repo_id"] ?? row["repoId"]),
      name: String(row["name"] ?? ""),
      action: "reclassify-local",
      expectedIsRemote: expectedIsRemote === undefined
        ? undefined
        : typeof expectedIsRemote === "boolean" || typeof expectedIsRemote === "number"
          ? expectedIsRemote
          : Number.NaN,
      expectedLastCommitSha: String(row["expected_last_commit_sha"] ?? row["expectedLastCommitSha"] ?? ""),
      expectedRepoRevision: typeof (row["expected_repo_revision"] ?? row["expectedRepoRevision"]) === "string"
        ? String(row["expected_repo_revision"] ?? row["expectedRepoRevision"])
        : undefined,
      evidenceRepoPath: String(row["evidence_repo_path"] ?? row["evidenceRepoPath"] ?? ""),
      evidenceRef: typeof (row["evidence_ref"] ?? row["evidenceRef"]) === "string"
        ? String(row["evidence_ref"] ?? row["evidenceRef"])
        : undefined,
    };
  });
  return {
    rows,
    actor: typeof object["actor"] === "string" ? object["actor"] : undefined,
    idempotency_key: typeof object["idempotency_key"] === "string" ? object["idempotency_key"] : undefined,
    idempotencyKey: typeof object["idempotencyKey"] === "string" ? object["idempotencyKey"] : undefined,
  };
}

registry
  .command("adjudicate-branches")
  .description("Dry-run or apply exact audited branch-row adjudications")
  .requiredOption("--spec <path>", "JSON spec containing exact guarded branch row adjudications")
  .option("--actor <actor>", "Auditable operator or workflow identity; overrides spec actor")
  .option("--idempotency-key <key>", "Stable unique key for this logical adjudication; overrides spec key")
  .option("--expected-plan-hash <sha256>", "Exact plan hash emitted by reviewed dry run; required with --apply")
  .option("--dry-run", "Plan exact row adjudication without writing (default)")
  .option("--apply", "Atomically apply exact row adjudication using the reviewed plan hash")
  .option("--json", "Output the versioned JSON result")
  .action((opts) => {
    const json = Boolean(opts.json);
    try {
      if (opts.apply && opts.dryRun) {
        throw new BranchAdjudicationError("INVALID_REQUEST", "--apply and --dry-run are mutually exclusive");
      }
      const spec = branchAdjudicationSpecFromFile(opts.spec);
      const actor = opts.actor ?? spec.actor;
      const idempotencyKey = opts.idempotencyKey ?? spec.idempotencyKey ?? spec.idempotency_key;
      const result = adjudicateBranches({
        rows: spec.rows,
        actor,
        idempotencyKey,
        apply: Boolean(opts.apply),
        expectedPlanHash: opts.expectedPlanHash,
        databasePath: getDbPath(),
      });
      if (json) {
        printJson(result);
      } else if (result.applied) {
        const replayed = result.replayed ? "replayed " : "";
        console.log(chalk.green(`✓ ${replayed}branch adjudication applied for ${result.plan.rows.length} row(s)`));
        console.log(chalk.dim(`  Receipt: ${result.receipt!.id}`));
      } else {
        console.log(chalk.yellow(`Dry run: ${result.plan.rows.length} branch row(s) can be adjudicated`));
        console.log(chalk.dim(`  Plan: ${result.plan.plan_hash}`));
        console.log(chalk.dim("  Re-run with --apply --expected-plan-hash <plan> after review."));
      }
    } catch (error) {
      const code = error instanceof BranchAdjudicationError ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : "unknown branch adjudication error";
      if (json) {
        const details = error instanceof BranchAdjudicationError ? error.details : undefined;
        printJson({ schema: "open-repos.branch-adjudication.v1", ok: false, error: { code, message, details } });
      } else {
        console.error(chalk.red(`${code}: ${message}`));
      }
      process.exitCode = 1;
    }
  });

/**
 * Retire registry rows whose path no longer exists.
 *
 * Refuses by default. A prune verb on a registry is a deletion primitive, and this
 * workspace has already lost 139 artifacts to a deletion path that resolved to a
 * production default while the operator believed it was pointed elsewhere. So
 * `--apply` alone is not enough: the caller must also name the database they think
 * they are pruning (`--expected-database`), quote back the plan hash from the dry
 * run, and identify themselves.
 *
 * Only missing paths. Rows for gutted-but-present checkouts are left alone —
 * some of those directories hold the only surviving copy of a deleted repository,
 * and removing the row destroys the record of where that data is.
 */
registry
  .command("prune")
  .description("Retire registry rows whose path no longer exists (dry run unless explicitly confirmed)")
  .option("--apply", "Delete the rows, with all confirmations supplied")
  .option("--expected-database <path>", "The registry database this prune was reviewed against; must match the resolved path")
  .option("--expected-plan-hash <sha256>", "Exact plan hash emitted by the dry run")
  .option("--actor <actor>", "Auditable operator or workflow identity")
  .option("--idempotency-key <key>", "Stable unique key for this logical prune")
  .option("-n, --limit <n>", "Prune at most N rows")
  .option("--json", "Output the versioned JSON result")
  .action((opts) => {
    const json = Boolean(opts.json);
    try {
      const result = pruneRegistryRows({
        apply: Boolean(opts.apply),
        expectedDatabasePath: opts.expectedDatabase,
        expectedPlanHash: opts.expectedPlanHash,
        actor: opts.actor,
        idempotencyKey: opts.idempotencyKey,
        limit: opts.limit === undefined ? undefined : intFlag(String(opts.limit), "--limit", 1),
      });
      if (json) {
        printJson(result);
        return;
      }
      const { plan } = result;
      if (result.applied) {
        // On a replay the current plan is empty because the rows are already gone;
        // reporting its count printed "pruned 0" next to a receipt saying 2.
        const count = result.replayed && result.receipt ? result.receipt.row_count : plan.row_count;
        const replayed = result.replayed ? "replayed " : "";
        console.log(chalk.green(`✓ ${replayed}pruned ${count} registry row(s)`));
        if (result.receipt) console.log(chalk.dim(`  Receipt: ${result.receipt.id}`));
        return;
      }
      console.log(chalk.bold(`Registry prune dry run — ${plan.database}`));
      console.log(`  ${plan.row_count} row(s) point at a path that no longer exists.`);
      for (const [table, count] of Object.entries(plan.cascade_totals).sort()) {
        console.log(chalk.dim(`    cascades: ${count} ${table} row(s)`));
      }
      for (const row of plan.rows.slice(0, 20)) {
        console.log(`    ${chalk.dim(`#${row.id}`)} ${row.name} ${chalk.dim(compactText(row.path, 100))}`);
        if (row.remote_url) console.log(chalk.dim(`        remote: ${row.remote_url}`));
      }
      if (plan.rows.length > 20) console.log(chalk.dim(`    ... ${plan.rows.length - 20} more; use --json for the full plan.`));
      if (plan.undetermined_count > 0) {
        console.log(chalk.yellow(`\n  ${plan.undetermined_count} row(s) could not be classified and will NOT be pruned:`));
        for (const row of plan.undetermined.slice(0, 10)) {
          console.log(chalk.dim(`    #${row.id} ${row.name} ${compactText(row.path, 80)} (${row.reason})`));
        }
        console.log(chalk.dim("    A path that cannot be read is not a path that is gone."));
      }
      console.log(chalk.dim("\n  This wrote nothing. Nothing on disk is touched by this command, ever — only registry rows."));
      console.log(chalk.dim("  To apply, supply every confirmation:"));
      console.log(chalk.dim(`    repos registry prune --apply \\\n      --expected-database <the database you intend to prune> \\\n      --expected-plan-hash ${plan.plan_hash} \\\n      --actor <you> --idempotency-key <key>`));
      // --expected-database is deliberately NOT pre-filled. The incident this guard
      // exists for was "the right rows in the wrong database": the operator believed
      // they were redirected and were not. Printing the resolved path inside a
      // paste-ready command makes the guard compare that path against itself and
      // pass for anyone following these instructions, which confirms nothing. The
      // plan hash must be echoed — binding the exact row set is its job — but the
      // database has to come from the operator's own belief to be a check at all.
      console.log(chalk.dim("  Type the database path yourself; this command will not fill it in for you,"));
      console.log(chalk.dim("  because a path it supplied could only ever match itself."));
    } catch (error) {
      const code = error instanceof RegistryPruneError ? error.code : "UNEXPECTED_ERROR";
      const message = error instanceof Error ? error.message : "unknown registry prune error";
      if (json) {
        const details = error instanceof RegistryPruneError ? error.details : undefined;
        printJson({ schema: "open-repos.registry-prune.v1", ok: false, error: { code, message, details } });
      } else {
        console.error(chalk.red(`${code}: ${message}`));
      }
      process.exitCode = 1;
    }
  });

// ── Worktrees ──
/**
 * The worktree lifecycle as CLI verbs.
 *
 * Two properties are load-bearing and are asserted in `worktree-cli.test.ts`
 * rather than left to review:
 *
 *   - **`add` has no path option.** The destination is computed from the repo
 *     name and the worktree name. A caller cannot express a different location,
 *     which is what finally holds the layout that prose has failed to hold —
 *     444 entries at the root on this station on 2026-07-28, mixing flat,
 *     machine-segmented and UUID-named directories.
 *   - **`remove` and `release` have no path argument.** They take a lease id or
 *     `<repo>/<worktree>`. `iapp-factory`'s worktree helper force-removed
 *     whatever path it was handed; here there is no argument in which a victim
 *     path can be passed.
 *
 * None of these verbs read a credential of their own — no `gh`, no token
 * environment variable, no vault. They are not credential-free end to end,
 * though, and the first version of this comment claimed they were: `add`
 * fetches the base ref through the parent checkout's own remote, so a private
 * https remote or a keyless ssh remote still needs whatever ambient git
 * credential that remote demands, and without one `add` fails closed with
 * BASE_REF_UNRESOLVABLE. Closing that gap is the credential broker's job.
 */
const worktree = program
  .command("worktree")
  .description("Worktree lifecycle: canonical placement, leases, reconciliation");

function printWorktreeError(error: unknown, json: boolean, schema: string): void {
  const code = error instanceof WorktreeError ? error.code : "UNEXPECTED_ERROR";
  const message = error instanceof Error ? error.message : "unknown worktree error";
  if (json) {
    const details = error instanceof WorktreeError ? error.details : undefined;
    printJson({ schema, ok: false, error: { code, message, details } });
  } else {
    console.error(chalk.red(`${code}: ${message}`));
    const hint = error instanceof WorktreeError ? error.details.hint : undefined;
    if (hint) console.error(chalk.dim(`  ${hint}`));
  }
  process.exitCode = 1;
}

worktree
  .command("add <repo>")
  .description("Create a worktree at the computed canonical path and claim a lease")
  .option("--task <id>", "Todos task id; the ratified worktree name when a task exists")
  .option("--name <name>", "Worktree name when no task exists (single path segment)")
  .option("--base <ref>", "Base ref, pinned from origin (default: the repo's default branch)")
  .option("--branch <branch>", "Branch to create (default: the worktree name)")
  .option("--run-id <id>", "Run identifier, part of the lease's uniqueness key")
  .option("--cleanup-policy <policy>", "delete-if-clean | keep", "delete-if-clean")
  .option("--json", "Output the versioned JSON result")
  .action((repo, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = addWorktree({
        repo,
        task: opts.task,
        name: opts.name,
        base: opts.base,
        branch: opts.branch,
        runId: opts.runId,
        cleanupPolicy: opts.cleanupPolicy,
      });
      if (json) {
        printJson(result);
        return;
      }
      const verb = result.created ? (result.reused ? "recreated" : "created") : "reused";
      console.log(chalk.green(`✓ ${verb} ${result.path}`));
      console.log(chalk.dim(`  lease ${result.lease.lease_id}  branch ${result.lease.branch}`));
      console.log(chalk.dim(`  base ${result.base.ref} @ ${result.base.sha.slice(0, 12)} (${result.base.source})`));
    } catch (error) {
      printWorktreeError(error, json, WORKTREE_LEASE_SCHEMA);
    }
  });

worktree
  .command("list [repo]")
  .description("Reconcile leases against disk and git, and name the layout violations")
  .option("--stale", "Only leases past the staleness horizon")
  .option("--stale-days <n>", "Staleness horizon in days", "7")
  .option("--json", "Output the versioned JSON result")
  .action((repo, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = listWorktrees({
        onlyStale: Boolean(opts.stale),
        staleDays: intFlag(String(opts.staleDays), "--stale-days", 0),
      });
      const entries = repo ? result.entries.filter((entry) => entry.repo_name === repo) : result.entries;
      // A repo filter cannot express a violation that belongs to no repo — a
      // checkout sitting flat at the root has no repo segment by definition.
      // Say how many were set aside rather than let the filter read as "clean".
      const hiddenViolations = repo
        ? result.entries.filter((entry) => entry.repo_name !== repo && entry.issues.length > 0).length
        : 0;
      // Recomputed, not carried over: a summary describing the whole root next
      // to a filtered listing reads as "this repo has 1468 problems".
      const summary = {
        ...result.summary,
        entries: entries.length,
        issue_count: entries.filter((entry) => entry.issues.length > 0).length,
        on_disk: entries.filter((entry) => entry.on_disk).length,
      };
      if (json) {
        printJson({ ...result, entries, summary: { ...summary, hidden_issue_entries: hiddenViolations } });
        return;
      }
      console.log(chalk.bold(`Worktrees under ${result.root}`));
      for (const entry of entries.slice(0, resolveLimit(opts, 40))) {
        const flags = entry.issues.length === 0 ? chalk.green("ok") : chalk.yellow(entry.issues.join(","));
        console.log(`  ${flags} ${compactText(entry.path, 110)}`);
      }
      console.log(chalk.dim(`  ${entries.length} entr(ies), ${summary.issue_count} with issues.`));
      if (hiddenViolations > 0) {
        console.log(chalk.dim(
          `  ${hiddenViolations} entr(ies) with issues are outside this repo's segment; run without a repo to see them.`,
        ));
      }
    } catch (error) {
      printWorktreeError(error, json, WORKTREE_LIST_SCHEMA);
    }
  });

worktree
  .command("remove <ref>")
  .description("Remove a worktree by lease id or <repo>/<worktree> — never by path")
  .option("--discard-changes", "Archive the dirty state and branch, then force the teardown")
  .option("--json", "Output the versioned JSON result")
  .action((ref, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = removeWorktree({ ref, discardChanges: Boolean(opts.discardChanges) });
      if (json) {
        printJson(result);
        return;
      }
      console.log(chalk.green(`✓ removed ${result.path}`));
      if (result.evidence_path) console.log(chalk.dim(`  archived to ${result.evidence_path}`));
    } catch (error) {
      printWorktreeError(error, json, WORKTREE_LEASE_SCHEMA);
    }
  });

worktree
  .command("adopt [path]")
  .description("Backfill leases for worktrees that exist without one (dry run by default)")
  .option("--all", "Every stray worktree under the canonical root")
  .option("--apply", "Write the leases (default: report only)")
  .option("--json", "Output the versioned JSON result")
  .action((path, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = adoptWorktrees({ path, all: Boolean(opts.all), apply: Boolean(opts.apply) });
      if (json) {
        printJson(result);
        return;
      }
      const verb = result.applied ? "adopted" : "would adopt";
      console.log(chalk.bold(`${verb} ${result.adopted.filter((row) => !row.already_leased).length} worktree(s)`));
      for (const row of result.adopted.slice(0, 40)) {
        const state = row.already_leased ? chalk.dim("leased") : chalk.yellow("stray");
        console.log(`  ${state} ${compactText(row.path, 110)} ${chalk.dim(row.branch ?? "")}`);
      }
      if (!result.applied) console.log(chalk.dim("  Nothing was written. Re-run with --apply."));
    } catch (error) {
      printWorktreeError(error, json, WORKTREE_ADOPT_SCHEMA);
    }
  });

worktree
  .command("release <lease-id>")
  .description("Mark a lease done and apply its cleanup policy")
  .option("--keep", "Release the lease and leave the directory in place")
  .option("--json", "Output the versioned JSON result")
  .action((leaseId, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = releaseWorktree({ leaseId, keep: Boolean(opts.keep) });
      if (json) {
        printJson(result);
        return;
      }
      if (result.removed) {
        console.log(chalk.green(`✓ released and removed ${result.lease.worktree_path}`));
      } else if (result.refusal) {
        console.log(chalk.yellow(`lease kept: ${result.refusal}`));
        process.exitCode = 1;
      } else {
        console.log(chalk.green(`✓ released ${result.lease.lease_id} (directory kept)`));
      }
    } catch (error) {
      printWorktreeError(error, json, WORKTREE_LEASE_SCHEMA);
    }
  });

// ── Commits ──
program
  .command("commits")
  .description("List commits")
  .option("--repo <name>", "Filter by repo name")
  .option("--author <author>", "Filter by author")
  .option("--since <date>", "After date")
  .option("--until <date>", "Before date")
  .option("-n, --limit <n>", "Max results", "20")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show author email and diff stats on separate lines")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const offset = resolveOffset(opts);
    const commits = listCommits({ repo_id, author: opts.author, since: opts.since, until: opts.until, limit, offset });
    if (opts.json) {
      printJson(commits);
    } else {
      for (const c of commits) {
        console.log(`${chalk.yellow(c.sha.slice(0, 8))} ${compactText(c.message, opts.verbose ? 180 : 100)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`  ${c.author_name} <${c.author_email}> ${c.date.slice(0, 19)} (+${c.insertions}/-${c.deletions})`));
        } else {
          console.log(chalk.dim(`  ${c.author_name} ${day(c.date)}`));
        }
      }
      printCompactHint({
        count: commits.length,
        noun: "commit(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use `repos show <repo>` for repo context" : "filter with --repo, --author, --since, or --until",
      });
    }
  });

// ── Branches ──
program
  .command("branches")
  .description("List branches")
  .option("--repo <name>", "Filter by repo")
  .option("--remote", "Only remote branches")
  .option("--local", "Only local branches")
  .option("-n, --limit <n>", "Max results (default: 20 human, 100 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show dates and ahead/behind counts")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const is_remote = opts.remote ? true : opts.local ? false : undefined;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 100);
    const offset = resolveOffset(opts);
    const branches = listBranches({ repo_id, is_remote, limit, offset });
    if (opts.json) {
      printJson(branches);
    } else {
      for (const b of branches) {
        const remote = b.is_remote ? chalk.dim(" (remote)") : "";
        console.log(`  ${chalk.green(compactText(b.name, opts.verbose ? 120 : 72))}${remote} ${chalk.dim(b.last_commit_sha?.slice(0, 8) || "")}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    ${day(b.last_commit_date)} ahead ${b.ahead}, behind ${b.behind}`));
        }
      }
      printCompactHint({
        count: branches.length,
        noun: "branch(es)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use --json for full branch records" : "filter with --repo, --remote, or --local",
      });
    }
  });

// ── Tags ──
program
  .command("tags")
  .description("List tags")
  .option("--repo <name>", "Filter by repo")
  .option("-n, --limit <n>", "Max results (default: 20 human, 100 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show tag messages")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 100);
    const offset = resolveOffset(opts);
    const tags = listTags({ repo_id, limit, offset });
    if (opts.json) {
      printJson(tags);
    } else {
      for (const t of tags) {
        console.log(`  ${chalk.cyan(compactText(t.name, 72))} ${chalk.yellow(t.sha.slice(0, 8))} ${chalk.dim(day(t.date))}`);
        if (opts.verbose && t.message) console.log(chalk.dim(`    ${compactText(t.message, 140)}`));
      }
      printCompactHint({
        count: tags.length,
        noun: "tag(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: opts.repo ? "use --json for full tag records" : "filter with --repo",
      });
    }
  });

// ── PRs ──
program
  .command("prs")
  .description("List pull requests")
  .option("--repo <name>", "Filter by local repo record")
  .option("--org <org>", "Filter by GitHub owner, resolved from each PR's URL")
  .option("--repo-name <name>", "Filter by GitHub repository name, resolved from each PR's URL")
  .option("--state <state>", "Filter: open, closed, merged")
  .option("--duplicates", "Emit one row per local checkout instead of one row per PR")
  .option("--author <author>", "Filter by author")
  .option("--mine", "Show only your PRs (via gh)")
  .option("--review", "Show PRs awaiting your review (via gh)")
  .option("-n, --limit <n>", "Max results (default: 20 human, 50 JSON)")
  .option("-o, --offset <n>", "Skip first N results", "0")
  .option("--cursor <n>", "Pagination cursor from a previous page")
  .option("--verbose", "Show author, date, diff stats, and URL")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    // Handle --mine and --review flags
    let author = opts.author;
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const offset = resolveOffset(opts);
    if (opts.mine || opts.review) {
      try {
        const ghUser = execSync("gh api user -q .login", { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        if (opts.mine) author = ghUser;
        if (opts.review) {
          // For --review, get PRs where user is requested reviewer
          const reviewJson = execSync(`gh search prs --review-requested=${ghUser} --state=open --limit=${limit} --json repository,number,title,author,createdAt,url`, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
          const reviews = JSON.parse(reviewJson || "[]");
          if (opts.json) { printJson(reviews); return; }
          if (reviews.length === 0) { console.log(chalk.dim("No PRs awaiting your review")); return; }
          console.log(chalk.bold(`${reviews.length} PR(s) awaiting review:`));
          for (const pr of reviews) {
            console.log(`  ${chalk.green("[open]")} ${pr.repository.nameWithOwner}#${pr.number} ${compactText(pr.title, 100)}`);
            if (opts.verbose) console.log(chalk.dim(`    by ${pr.author?.login || "?"} ${day(pr.createdAt)} ${pr.url || ""}`));
          }
          printCompactHint({ count: reviews.length, noun: "PR(s)", limit, verbose: opts.verbose, detail: "use --json for full GitHub records" });
          return;
        }
      } catch { /* gh not available */ }
    }
    const filter = {
      repo_id,
      state: opts.state,
      author,
      org: opts.org,
      repo_name: opts.repoName,
      duplicates: Boolean(opts.duplicates),
    };
    const prs = listPullRequests({ ...filter, limit, offset });
    const total = countPullRequests(filter);
    if (opts.json) {
      printJson(prs);
      warnIfTruncated({ shown: prs.length, total, limit, offset, noun: "pull request(s)" });
    } else {
      for (const pr of prs) {
        const stateColor = pr.state === "open" ? chalk.green : pr.state === "merged" ? chalk.magenta : chalk.red;
        const slug = pr.org && pr.repo ? `${pr.org}/${pr.repo}` : "";
        const draft = pr.is_draft ? chalk.dim(" (draft)") : "";
        console.log(`  ${stateColor(`[${pr.state}]`)} ${slug}#${pr.number}${draft} ${compactText(pr.title, opts.verbose ? 160 : 100)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    by ${pr.author} ${day(pr.created_at)} +${pr.additions}/-${pr.deletions} files ${pr.changed_files}${pr.url ? ` ${pr.url}` : ""}`));
          console.log(chalk.dim(`    head ${pr.head_sha?.slice(0, 12) ?? "-"} mergeable ${pr.mergeable ?? "-"} merge-state ${pr.merge_state_status ?? "-"} ci ${pr.ci_state ?? "-"} review ${pr.review_decision ?? "-"}`));
        }
      }
      printCompactHint({
        count: prs.length,
        noun: "PR(s)",
        limit,
        offset,
        pageable: true,
        verbose: opts.verbose,
        detail: `${total} match this filter. Filter with --org, --repo, --repo-name, --state, --author, --mine, or --review`,
      });
    }
  });

// ── Search ──
program
  .command("search <query>")
  .description("Search across all repos, commits, and PRs")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show wider snippets")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const results = searchAll(query, limit);
    if (opts.json) {
      printJson(results);
    } else {
      if (results.length === 0) { console.log(chalk.dim("No results")); return; }
      for (const r of results) {
        const typeColor = r.type === "repo" ? chalk.blue : r.type === "commit" ? chalk.yellow : chalk.magenta;
        console.log(`${typeColor(`[${r.type}]`)} ${chalk.bold(compactText(r.title, opts.verbose ? 140 : 90))} ${chalk.dim(`(${r.repo_name})`)}`);
        console.log(chalk.dim(`  ${compactText(r.snippet, opts.verbose ? 180 : 100)}`));
      }
      printCompactHint({
        count: results.length,
        noun: "result(s)",
        limit,
        verbose: opts.verbose,
        detail: "use `repos show <repo>` for repo details",
      });
    }
  });

// ── Stats ──
program
  .command("stats")
  .description("Show global stats")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stats = getGlobalStats();
    if (opts.json) {
      printJson(stats);
    } else {
      console.log(chalk.bold("Global Stats"));
      console.log(`  Repos: ${stats.total_repos}`);
      console.log(`  Commits: ${stats.total_commits}`);
      console.log(`  Branches: ${stats.total_branches}`);
      console.log(`  Tags: ${stats.total_tags}`);
      console.log(`  PRs: ${stats.total_prs}`);
      if (Object.keys(stats.repos_by_org).length > 0) {
        console.log(chalk.dim("\nBy org:"));
        for (const [org, count] of Object.entries(stats.repos_by_org)) {
          console.log(`  ${chalk.blue(org)}: ${count} repos`);
        }
      }
      if (stats.most_active_repos.length > 0) {
        console.log(chalk.dim("\nMost active:"));
        for (const r of stats.most_active_repos.slice(0, 5)) {
          console.log(`  ${r.name}: ${r.commits} commits`);
        }
      }
    }
  });

// ── Status ──
program
  .command("status")
  .description("Show metadata-only workspace inventory status")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const status = getReposStatus();
    if (opts.json) {
      printJson(status);
      return;
    }

    console.log(chalk.bold("Workspace Inventory Status"));
    console.log(`  Package:  ${status.package.version}`);
    console.log(`  Repos:    ${status.counts.repos.total} (${status.counts.repos.scanned} scanned, ${status.counts.repos.unscanned} unscanned)`);
    console.log(`  Remotes:  ${status.counts.repos.withRemote} configured, ${status.counts.repos.withCredentialLikeRemote} credential-like`);
    console.log(`  Commits:  ${status.counts.commits}`);
    console.log(`  Branches: ${status.counts.branches.total}`);
    console.log(chalk.dim("\nMetadata only. Use --json for the stable status contract or list commands for names/details."));
  });

// ── Analytics ──
program
  .command("activity")
  .description("Show recent activity across repos")
  .option("--days <n>", "Look back N days", "7")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show more authors per row")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const activity = getRecentActivity(intFlag(opts.days, "--days", 1), limit);
    if (opts.json) {
      printJson(activity);
    } else {
      console.log(chalk.bold(`Activity in last ${opts.days} days:`));
      for (const r of activity) {
        console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits`);
        console.log(chalk.dim(`    Authors: ${compactList(r.authors, opts.verbose ? 10 : 3, opts.verbose ? 140 : 72)}`));
      }
      printCompactHint({ count: activity.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use `repos commits --repo <name>` for commit details" });
    }
  });

program
  .command("contributors")
  .description("Show top contributors")
  .option("--repo <name>", "Filter by repo")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show repo lists for contributors")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const contributors = getContributorStats({ repo_id, limit });
    if (opts.json) {
      printJson(contributors);
    } else {
      console.log(chalk.bold("Top Contributors:"));
      for (const c of contributors) {
        console.log(`  ${chalk.bold(compactText(c.author_name, 64))} ${chalk.dim(`${c.commit_count} commits, +${c.insertions}/-${c.deletions}, ${c.repos.length} repos`)}`);
        if (opts.verbose) {
          console.log(chalk.dim(`    ${c.author_email} ${compactList(c.repos, 10, 140)}`));
        }
      }
      printCompactHint({ count: contributors.length, noun: "contributor(s)", limit, verbose: opts.verbose, detail: opts.repo ? "use `repos commits --repo <name> --author <author>` for commits" : "filter with --repo" });
    }
  });

program
  .command("stale")
  .description("Show stale repos (no recent commits)")
  .option("--days <n>", "Stale threshold in days", "30")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show paths and orgs")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stale = getStaleRepos(intFlag(opts.days, "--days", 1));
    if (opts.json) {
      printJson(stale);
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, stale.length || COMPACT_LIMIT);
      const shown = stale.slice(0, limit);
      console.log(chalk.bold(`Repos with no commits in ${opts.days}+ days:`));
      for (const r of shown) {
        const lastDate = r.last_commit_date ? r.last_commit_date.slice(0, 10) : "never";
        console.log(`  ${chalk.yellow(r.name)} — last commit: ${lastDate} (${r.days_stale || "∞"} days ago)`);
        if (opts.verbose) console.log(chalk.dim(`    ${r.org ? `[${r.org}] ` : ""}${compactText(r.path, 140)}`));
      }
      printCompactHint({ count: shown.length, noun: `of ${stale.length} stale repo(s)`, limit, verbose: opts.verbose, detail: "use `repos show <name>` for repo details" });
    }
  });

program
  .command("heatmap")
  .description("Show commit activity heatmap")
  .option("--repo <name>", "Filter by repo")
  .option("--json", "Output as JSON")
  .action((opts) => {
    let repo_id: number | undefined;
    if (opts.repo) {
      const repo = requireRepo(opts.repo);
      repo_id = repo.id;
    }
    const heatmap = getActivityHeatmap(repo_id);
    if (opts.json) {
      printJson(heatmap);
    } else {
      console.log(chalk.bold("Commit Activity Heatmap"));
      console.log(`Total: ${heatmap.total} commits`);
      console.log(`Most active day: ${heatmap.most_active_day}`);
      console.log(`Most active hour: ${heatmap.most_active_hour}:00`);
    }
  });

// ── GitHub Sync ──
program
  .command("sync-github")
  .description("Sync PRs and metadata from GitHub")
  .option("--repo <name>", "Sync specific repo")
  .option("--org <org>", "Sync repos for a specific org")
  .option("-n, --limit <n>", "Max closed/merged PRs to refresh per repo", "100")
  .option("--no-reconcile", "Skip driving vanished open PRs to their terminal state")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const reconcile = opts.reconcile !== false;
    if (opts.repo) {
      try {
        const result = syncGithubPRs(opts.repo, { limit: intFlag(opts.limit, "--limit", 1), reconcile });
        if (opts.json) {
          printJsonLine(result);
        } else {
          console.log(chalk.green(`✓ Synced ${result.synced} PRs for ${result.repo_name} (${result.rows_written} rows across ${result.checkouts} checkout(s)), reconciled ${result.reconciled}`));
          if (!result.merge_state_available) {
            console.log(chalk.yellow("  merge_state_status unavailable (preview header refused); other gate fields indexed"));
          }
        }
      } catch (err: any) {
        console.log(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    } else {
      const result = syncAllGithubPRs({
        org: opts.org,
        limit: intFlag(opts.limit, "--limit", 1),
        reconcile,
        onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
      });
      if (opts.json) {
        printJsonLine(result);
      } else {
        console.log(chalk.green(`\n✓ Synced ${result.total_synced} PRs across ${result.repos_synced} remotes (${result.total_rows_written} rows over ${result.repos_seen} local checkouts), reconciled ${result.total_reconciled} to a terminal state`));
        if (result.errors.length > 0) {
          console.log(chalk.yellow(`  ${result.errors.length} errors (repos without GitHub remote)`));
        }
      }
    }
  });

program
  .command("gh-catalog")
  .description("Enumerate the GitHub repository catalog for OpenLoops")
  .option("--sync", "Fetch GitHub repositories before listing")
  .option("--cache-only", "Read cache only; fail if combined with --sync")
  .option("--resume", "Resume from cached nextCursor when syncing")
  .option("--cursor <page>", "GitHub API page cursor to start from")
  .option("--max-pages <n>", "Maximum GitHub pages to sync this run")
  .option("--page-size <n>", "GitHub page size, max 100", "100")
  .option("--cache <path>", "Catalog cache path")
  .option("--stale-minutes <n>", "Minutes until synced cache is stale", "60")
  .option("--min-remaining <n>", "Minimum GitHub core rate-limit calls to preserve", "1")
  .option("--org <org>", "Filter by GitHub org/account")
  .option("--repo <repo>", "Filter by repo name or owner/name")
  .option("--language <language>", "Filter by primary language")
  .option("--package-scope <scope>", "Filter by package scope, for example @hasna")
  .option("--local-path <path>", "Filter by matched local workspace path prefix")
  .option("--tags <tags>", "Comma-separated topic or loop tag filters")
  .option("--include-archived", "Include archived repositories")
  .option("--include-disabled", "Include disabled repositories")
  .option("-n, --limit <n>", "Max records to return", "100")
  .option("-o, --offset <n>", "Skip first N matched records", "0")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (opts.sync && opts.cacheOnly) {
      console.error(chalk.red("Error: --sync and --cache-only cannot be combined"));
      process.exit(1);
    }

    try {
      const envelope = enumerateGithubRepoCatalog({
        cachePath: opts.cache,
        sync: Boolean(opts.sync),
        resume: Boolean(opts.resume),
        cursor: opts.cursor,
        maxPages: optionalIntFlag(opts.maxPages, "--max-pages", 1),
        pageSize: optionalIntFlag(opts.pageSize, "--page-size", 1),
        staleMs: intFlag(opts.staleMinutes, "--stale-minutes", 1) * 60_000,
        minRemaining: optionalIntFlag(opts.minRemaining, "--min-remaining", 0),
        limit: intFlag(opts.limit, "--limit", 1),
        offset: intFlag(opts.offset, "--offset", 0),
        filter: {
          org: opts.org,
          repo: opts.repo,
          language: opts.language,
          packageScope: opts.packageScope,
          localPath: opts.localPath,
          tags: csvFlag(opts.tags),
          includeArchived: Boolean(opts.includeArchived),
          includeDisabled: Boolean(opts.includeDisabled),
        },
      });

      if (opts.json) {
        printJson(envelope);
        return;
      }

      console.log(chalk.bold("GitHub Repository Catalog"));
      console.log(`  Records: ${envelope.page.count}/${envelope.page.total}`);
      console.log(`  Cache:   ${envelope.source.cachePath}`);
      console.log(`  Synced:  ${envelope.source.cacheSyncedAt ?? "never"}`);
      console.log(`  Stale:   ${envelope.source.stale ? "yes" : "no"} (${envelope.source.staleAt ?? "unknown"})`);
      if (!envelope.source.completed && envelope.source.nextCursor) {
        console.log(`  Cursor:  ${envelope.source.nextCursor}`);
      }
      for (const warning of envelope.warnings) console.log(chalk.yellow(`  Warning: ${warning}`));
      for (const repo of envelope.repositories) {
        const local = repo.local ? chalk.dim(` ${repo.local.path}`) : "";
        console.log(`${chalk.bold(repo.full_name)} ${chalk.dim(`[${repo.visibility}]`)}${local}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

const ops = program.command("ops").description("Loop-safe operational producers");

addLoopProducerOptions(
  ops
    .command("pr-queue")
    .description("Emit normalized open PR queue items and task seeds")
    .option("--sync", "Sync GitHub PR metadata before reading the local queue")
    .option("--sync-orgs <orgs>", "Bounded comma-separated orgs to sync before reading the queue")
    .option("--sync-max-repos <n>", "Optional cap on GitHub repositories to sync when using --sync-orgs; omit to paginate ALL repos")
    .option("--allow-sync-errors", "Keep exit code zero even if GitHub sync reports errors")
    .option("--org <org>", "Filter by GitHub org")
    .option("--repo <repo>", "Filter by repo name or local path")
    .option("--state <state>", "Filter PR state", "open")
    .option("-n, --limit <n>", "Maximum PRs to emit", "100")
    .option("--json", "Output JSON")
    .addHelpText("after", "\nLoop use: add --sync-orgs hasna,hasnaxyz --report-dir <dir> --upsert-tasks --todos-project <path> --task-list repo-pr-merge-queue. Omit --sync-max-repos to sync every repo across the orgs; pass it only to bound a run."),
  50,
)
  .action((opts: LoopProducerOpts & {
    sync?: boolean;
    syncOrgs?: string;
    syncMaxRepos?: string;
    allowSyncErrors?: boolean;
    org?: string;
    repo?: string;
    state?: string;
    limit: string;
    json?: boolean;
  }) => {
    const syncOrgs = csvFlag(opts.syncOrgs);
    // --sync-max-repos is now OPTIONAL: when omitted, every repo across the orgs is
    // paginated. A bounded value is still honored for deliberately capped runs.
    const syncMaxRepos = optionalIntFlag(opts.syncMaxRepos, "--sync-max-repos", 1);
    const result = buildPrQueue({
      sync: Boolean(opts.sync || syncOrgs),
      syncOrgs,
      syncMaxRepos,
      org: opts.org,
      repo: opts.repo,
      state: opts.state,
      limit: intFlag(opts.limit, "--limit", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "repo-pr-queue",
      taskList: "repo-pr-merge-queue",
      taskListName: "Repo PR Merge Queue",
      taskListDescription: "Open PR tasks created by deterministic OpenRepos producers and consumed by headless worker/verifier workflows.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope) || syncFailed(result.synced, opts.allowSyncErrors)) process.exitCode = 1;
      return;
    }
    console.log(chalk.bold(`PR queue: ${result.summary.items} item(s), ${result.summary.task_seeds} task seed(s)`));
    if (result.synced) {
      console.log(chalk.dim(`synced repos=${result.synced.repos_synced}/${result.synced.repos_checked} prs=${result.synced.total_synced} truncated=${result.synced.truncated ? "yes" : "no"} skipped=${result.synced.skipped.length} errors=${result.synced.errors.length}`));
    }
    for (const item of result.items.slice(0, 50)) {
      console.log(`${chalk.green(item.repo.full_name)}#${item.pr.number} ${item.pr.title}`);
      console.log(chalk.dim(`  ${item.repo.path}`));
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope) || syncFailed(result.synced, opts.allowSyncErrors)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("global-cli-smoke")
    .description("Smoke-check globally installed CLIs used by agents")
    .option("--commands <names>", "Comma-separated command names to check")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--json", "Output JSON"),
  20,
)
  .action((opts: LoopProducerOpts & { commands?: string; timeoutMs: string; json?: boolean }) => {
    const result = runGlobalCliSmoke({
      commands: csvFlag(opts.commands),
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "global-cli-smoke",
      taskList: "global-cli-smoke",
      taskListName: "Global CLI Smoke",
      taskListDescription: "CLI availability failures created by deterministic OpenRepos smoke checks.",
    });
    if (opts.json) {
      printJson(envelope);
      if (result.summary.failed > 0 || result.summary.missing > 0 || loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.failed === 0 && result.summary.missing === 0 ? chalk.green("ok") : chalk.red("issues");
    console.log(`${status} checked=${result.summary.checked} ok=${result.summary.ok} failed=${result.summary.failed} missing=${result.summary.missing}`);
    for (const row of result.commands.filter((command) => command.status !== "ok").slice(0, 30)) {
      console.log(`${row.status === "missing" ? chalk.yellow("missing") : chalk.red("failed")} ${row.command} ${chalk.dim(row.stderr_preview)}`);
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (result.summary.failed > 0 || result.summary.missing > 0 || loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

ops
  .command("package-hygiene")
  .description("Inspect Hasna global package manager hygiene")
  .option("--scope <scopes>", "Comma-separated package scopes", "@hasna,@hasnaxyz")
  .option("--no-npm-global", "Skip npm global duplicate inspection")
  .option("--timeout-ms <n>", "Per-command timeout", "20000")
  .option("--json", "Output JSON")
  .action((opts: { scope: string; npmGlobal?: boolean; timeoutMs: string; json?: boolean }) => {
    const result = inspectPackageHygiene({
      scopes: csvFlag(opts.scope),
      includeNpmGlobal: opts.npmGlobal !== false,
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    if (opts.json) {
      printJson(result);
      return;
    }
    const status = result.summary.scoped_npm_duplicates === 0 ? chalk.green("ok") : chalk.yellow("review");
    console.log(`${status} bun=${result.summary.bun_packages_seen} npm=${result.summary.npm_packages_seen} duplicates=${result.summary.scoped_npm_duplicates} task_seeds=${result.summary.task_seeds}`);
    for (const row of result.npm_global_duplicates.slice(0, 30)) {
      console.log(`${chalk.yellow(row.name)}${row.version ? chalk.dim(`@${row.version}`) : ""}`);
    }
  });

addLoopProducerOptions(
  ops
    .command("release-pipeline-parity")
    .description("Flag repos missing the standard CI + tag-publish workflow pair or with npm-latest-without-git-tag drift")
    .requiredOption("--paths <paths>", "Comma-separated local repo paths to check")
    .option("--no-registry", "Skip npm registry drift checks")
    .option("--json", "Output JSON")
    .addHelpText("after", "\nLoop use: add --report-dir <dir> --upsert-tasks --todos-project <path> --task-list release-pipeline-parity."),
  20,
)
  .action((opts: LoopProducerOpts & { paths: string; registry?: boolean; json?: boolean }) => {
    const result = buildReleasePipelineParity({
      paths: csvFlag(opts.paths) ?? [],
      includeRegistry: opts.registry !== false,
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "release-pipeline-parity",
      taskList: "release-pipeline-parity",
      taskListName: "Release Pipeline Parity",
      taskListDescription: "Release pipeline parity gaps (missing CI/tag-publish workflows, npm-latest-without-git-tag drift) created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.flagged === 0 ? chalk.green("ok") : chalk.yellow("gaps");
    console.log(`${status} repos=${result.summary.repos} flagged=${result.summary.flagged} task_seeds=${result.summary.task_seeds}`);
    for (const item of result.items.filter((entry) => entry.issue_codes.length > 0).slice(0, 30)) {
      console.log(`${chalk.yellow(item.root)} ${chalk.dim(item.issue_codes.join(", "))}`);
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("release-candidates")
    .description("Detect releasable repo changes or release blockers and emit task seeds")
    .requiredOption("--repo <path-or-name>", "Local repo path or repos registry name")
    .option("--github-repo <owner/name>", "GitHub owner/name; inferred from origin remote by default")
    .option("--package <name>", "Published package name; inferred from package.json by default")
    .option("--branch <branch>", "Release branch", "main")
    .option("--tag-prefix <prefix>", "Release tag prefix", "v")
    .option("--version-file <path>", "Version file inside the repo; inferred from package.json/Cargo.toml by default")
    .option("--quiet-minutes <n>", "Block release if branch changed more recently than this", "60")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--no-fetch", "Skip git fetch before inspection")
    .option("--no-require-green-ci", "Do not require GitHub Actions to be green")
    .option("--no-open-pr-blocker", "Do not block on open PRs")
    .option("--json", "Output JSON")
    .addHelpText("after", "\nLoop use: add --report-dir <dir> --upsert-tasks --todos-project <path> --task-list repo-release-candidates. Blocked release state still exits 0 after report/task creation."),
  5,
)
  .action((opts: LoopProducerOpts & {
    repo: string;
    githubRepo?: string;
    package?: string;
    branch: string;
    tagPrefix: string;
    versionFile?: string;
    quietMinutes: string;
    timeoutMs: string;
    fetch?: boolean;
    requireGreenCi?: boolean;
    openPrBlocker?: boolean;
    json?: boolean;
  }) => {
    const result = buildReleaseCandidates({
      repo: opts.repo,
      githubRepo: opts.githubRepo,
      packageName: opts.package,
      branch: opts.branch,
      tagPrefix: opts.tagPrefix,
      versionFile: opts.versionFile,
      quietMinutes: intFlag(opts.quietMinutes, "--quiet-minutes", 0),
      requireGreenCi: opts.requireGreenCi !== false,
      includeOpenPrBlocker: opts.openPrBlocker !== false,
      fetch: opts.fetch !== false,
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "repo-release-candidates",
      taskList: "repo-release-candidates",
      taskListName: "Repo Release Candidates",
      taskListDescription: "Release candidate and release-blocker tasks created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.status === "candidate"
      ? chalk.green("candidate")
      : result.summary.status === "blocked"
        ? chalk.yellow("blocked")
        : chalk.dim("noop");
    console.log(`${status} ${result.repo.github_repo} ${result.state.intended_tag ?? "unknown-tag"} seeds=${result.summary.task_seeds}`);
    for (const gate of result.gates) {
      const label = gate.status === "block" ? chalk.yellow("block") : gate.status === "warn" ? chalk.magenta("warn") : chalk.green("pass");
      console.log(`${label} ${gate.id}: ${gate.message}`);
    }
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("docs-rules-drift")
    .description("Detect source changes that need docs, changelog, prompt, skill, or agent-rule updates")
    .requiredOption("--repo <path-or-name>", "Local repo path or repos registry name")
    .option("--github-repo <owner/name>", "GitHub owner/name; inferred from origin remote by default")
    .option("--branch <branch>", "Release branch", "main")
    .option("--docs-paths <paths>", "Comma-separated docs/rules paths to watch")
    .option("--source-paths <paths>", "Comma-separated source paths to compare")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--no-fetch", "Skip git fetch before inspection")
    .option("--json", "Output JSON")
    .addHelpText("after", "\nLoop use: add --repo <repo> --report-dir <dir> --upsert-tasks --todos-project <repo-project> --task-list codewith-product-backlog."),
  1,
)
  .action((opts: LoopProducerOpts & {
    repo: string;
    githubRepo?: string;
    branch: string;
    docsPaths?: string;
    sourcePaths?: string;
    timeoutMs: string;
    fetch?: boolean;
    json?: boolean;
  }) => {
    const result = buildDocsRulesDrift({
      repo: opts.repo,
      githubRepo: opts.githubRepo,
      branch: opts.branch,
      docsPaths: csvFlag(opts.docsPaths),
      sourcePaths: csvFlag(opts.sourcePaths),
      fetch: opts.fetch !== false,
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "repo-docs-rules-drift",
      taskList: "repo-docs-rules-drift",
      taskListName: "Repo Docs and Rules Drift",
      taskListDescription: "Docs, changelog, skills, and agent rule drift tasks created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.status === "ok" ? chalk.green("ok") : result.summary.status === "blocked" ? chalk.red("blocked") : chalk.yellow("drift");
    console.log(`${status} ${result.repo.github_repo} seeds=${result.summary.task_seeds}`);
    for (const issue of result.issues) console.log(`${issue.severity === "high" ? chalk.red("high") : chalk.yellow("medium")} ${issue.id}: ${issue.message}`);
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("dependency-refresh")
    .description("Detect repo dependency refresh needs and emit lifecycle-routed task seeds")
    .requiredOption("--repo <path-or-name>", "Local repo path or repos registry name")
    .option("--github-repo <owner/name>", "GitHub owner/name; inferred from origin remote by default")
    .option("--max-lock-age-days <n>", "Create a refresh task when lockfiles are older than this", "7")
    .option("--timeout-ms <n>", "Per-command timeout", "30000")
    .option("--json", "Output JSON"),
  1,
)
  .action((opts: LoopProducerOpts & {
    repo: string;
    githubRepo?: string;
    maxLockAgeDays: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const result = buildDependencyRefresh({
      repo: opts.repo,
      githubRepo: opts.githubRepo,
      maxLockAgeDays: intFlag(opts.maxLockAgeDays, "--max-lock-age-days", 1),
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "repo-dependency-refresh",
      taskList: "repo-dependency-refresh",
      taskListName: "Repo Dependency Refresh",
      taskListDescription: "Dependency refresh tasks created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.status === "ok" ? chalk.green("ok") : chalk.yellow("needs-refresh");
    console.log(`${status} ${result.repo.github_repo} seeds=${result.summary.task_seeds}`);
    for (const check of result.checks.filter((check) => check.status !== "ok")) console.log(`${check.status} ${check.id}: ${check.message}`);
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("workspace-worktree-hygiene")
    .description("Inspect workspace repos for stale, dirty, detached, or missing OpenLoops worktrees")
    .option("--root <path>", "Workspace root to scan; repeatable or comma-separated", collectValues, [])
    .option("--worktree-root <path>", "Only report worktrees under this root")
    .option("--stale-days <n>", "Age threshold for stale worktrees", "7")
    .option("-n, --limit <n>", "Maximum repos to inspect", "200")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--json", "Output JSON"),
  5,
)
  .action((opts: LoopProducerOpts & {
    root: string[];
    worktreeRoot?: string;
    staleDays: string;
    limit: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const result = buildWorkspaceWorktreeHygiene({
      roots: opts.root.length ? opts.root : undefined,
      worktreeRoot: opts.worktreeRoot,
      staleDays: intFlag(opts.staleDays, "--stale-days", 1),
      limit: intFlag(opts.limit, "--limit", 1),
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "workspace-worktree-hygiene",
      taskList: "workspace-worktree-hygiene",
      taskListName: "Workspace Worktree Hygiene",
      taskListDescription: "Stale, dirty, detached, and missing worktree tasks created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.issue_worktrees === 0 ? chalk.green("ok") : chalk.yellow("issues");
    console.log(`${status} repos=${result.summary.repos_checked} issue_worktrees=${result.summary.issue_worktrees} seeds=${result.summary.task_seeds}`);
    for (const row of result.worktrees.slice(0, 30)) console.log(`${chalk.yellow(row.path)} ${chalk.dim(row.issues.join(","))}`);
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("task-route-health")
    .description("Check that a task-created lifecycle router loop is active and recently succeeding")
    .requiredOption("--router-loop <id-or-name>", "OpenLoops router loop id or name")
    .option("--project <path>", "Project path the router serves")
    .option("--max-age-minutes <n>", "Maximum latest-run age", "15")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--json", "Output JSON"),
  1,
)
  .action((opts: LoopProducerOpts & {
    routerLoop: string;
    project?: string;
    maxAgeMinutes: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const result = buildTaskRouteHealth({
      routerLoop: opts.routerLoop,
      project: opts.project,
      maxAgeMinutes: intFlag(opts.maxAgeMinutes, "--max-age-minutes", 1),
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "task-route-health",
      taskList: "task-route-health",
      taskListName: "Task Route Health",
      taskListDescription: "Task lifecycle route health tasks created by deterministic OpenRepos producers.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.status === "ok" ? chalk.green("ok") : chalk.yellow("issue");
    console.log(`${status} ${result.router_loop} latest=${result.state.latest_run_status ?? "unknown"} age=${result.state.latest_run_age_minutes ?? "unknown"} seeds=${result.summary.task_seeds}`);
    for (const issue of result.issues) console.log(`${issue.severity === "high" ? chalk.red("high") : chalk.yellow("medium")} ${issue.id}: ${issue.message}`);
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

addLoopProducerOptions(
  ops
    .command("protected-release")
    .description("Emit a protected release task only when release-candidate gates are green")
    .requiredOption("--repo <path-or-name>", "Local repo path or repos registry name")
    .option("--github-repo <owner/name>", "GitHub owner/name; inferred from origin remote by default")
    .option("--package <name>", "Published package name; inferred from package.json by default")
    .option("--branch <branch>", "Release branch", "main")
    .option("--tag-prefix <prefix>", "Release tag prefix", "v")
    .option("--version-file <path>", "Version file inside the repo; inferred from package.json/Cargo.toml by default")
    .option("--quiet-minutes <n>", "Block release if branch changed more recently than this", "60")
    .option("--approval-label <text>", "Protected release approval/check name")
    .option("--timeout-ms <n>", "Per-command timeout", "20000")
    .option("--no-fetch", "Skip git fetch before inspection")
    .option("--no-require-green-ci", "Do not require GitHub Actions to be green")
    .option("--no-open-pr-blocker", "Do not block on open PRs")
    .option("--json", "Output JSON"),
  1,
)
  .action((opts: LoopProducerOpts & {
    repo: string;
    githubRepo?: string;
    package?: string;
    branch: string;
    tagPrefix: string;
    versionFile?: string;
    quietMinutes: string;
    approvalLabel?: string;
    timeoutMs: string;
    fetch?: boolean;
    requireGreenCi?: boolean;
    openPrBlocker?: boolean;
    json?: boolean;
  }) => {
    const result = buildProtectedRelease({
      repo: opts.repo,
      githubRepo: opts.githubRepo,
      packageName: opts.package,
      branch: opts.branch,
      tagPrefix: opts.tagPrefix,
      versionFile: opts.versionFile,
      quietMinutes: intFlag(opts.quietMinutes, "--quiet-minutes", 0),
      approvalLabel: opts.approvalLabel,
      requireGreenCi: opts.requireGreenCi !== false,
      includeOpenPrBlocker: opts.openPrBlocker !== false,
      fetch: opts.fetch !== false,
      timeoutMs: intFlag(opts.timeoutMs, "--timeout-ms", 1),
    });
    const envelope = applyLoopProducerArtifacts(result, result.task_suggestions, opts, {
      reportPrefix: "protected-release",
      taskList: "protected-release",
      taskListName: "Protected Release",
      taskListDescription: "Protected release tasks created only after deterministic release gates are green.",
    });
    if (opts.json) {
      printJson(envelope);
      if (loopProducerHadErrors(envelope)) process.exitCode = 1;
      return;
    }
    const status = result.summary.status === "ready" ? chalk.green("ready") : result.summary.status === "blocked" ? chalk.yellow("blocked") : chalk.dim("noop");
    console.log(`${status} ${result.release.repo.github_repo} ${result.release.state.intended_tag ?? "unknown-tag"} seeds=${result.summary.task_seeds}`);
    if (envelope.loop?.task_upsert) {
      const upsert = envelope.loop.task_upsert.summary;
      console.log(chalk.dim(`tasks created=${upsert.created} existing=${upsert.existing} skipped=${upsert.skipped} errors=${upsert.errors}`));
    }
    if (envelope.loop?.report_path) console.log(chalk.dim(`report=${envelope.loop.report_path}`));
    if (loopProducerHadErrors(envelope)) process.exitCode = 1;
  });

// ── GitHub Metadata ──
program
  .command("gh-info <name>")
  .description("Fetch GitHub metadata for a repo")
  .option("--json", "Output as JSON")
  .action((name, opts) => {
    const meta = fetchRepoMetadata(name);
    if (!meta) { console.log(chalk.red("Cannot fetch metadata (no GitHub remote?)")); process.exit(1); }
    if (opts.json) {
      printJson(meta);
    } else {
      if (meta.description) console.log(`Description: ${meta.description}`);
      if (meta.language) console.log(`Language: ${meta.language}`);
      console.log(`Stars: ${meta.stars}, Forks: ${meta.forks}`);
      if (meta.topics.length > 0) console.log(`Topics: ${meta.topics.join(", ")}`);
    }
  });

// ── Find ──
program
  .command("find <file>")
  .description("Find a file across all repos")
  .option("-n, --limit <n>", "Max repos", "50")
  .option("--verbose", "Show up to 20 matches per repo")
  .option("--json", "Output as JSON")
  .action((file, opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 50);
    const results = findFile(file, limit);
    if (opts.json) { printJson(results); return; }
    if (results.length === 0) { console.log(chalk.dim("Not found in any repo")); return; }
    for (const r of results) {
      console.log(chalk.bold(r.repo_name));
      const matchLimit = opts.verbose ? 20 : 3;
      for (const m of r.matches.slice(0, matchLimit)) console.log(chalk.dim(`  ${compactText(m, opts.verbose ? 160 : 100)}`));
      if (r.matches.length > matchLimit) console.log(chalk.dim(`  ... and ${r.matches.length - matchLimit} more`));
    }
    printCompactHint({ count: results.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use --json for every match path" });
  });

// ── Who ──
program
  .command("who <query>")
  .description("Find author activity across all repos")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show full date range rows")
  .option("--json", "Output as JSON")
  .action((query, opts) => {
    const results = whoIs(query);
    if (opts.json) { printJson(results); return; }
    if (results.length === 0) { console.log(chalk.dim("No commits found for that author")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, results.length || COMPACT_LIMIT);
    const shown = results.slice(0, limit);
    console.log(chalk.bold(`Author: ${query}`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      if (opts.verbose) console.log(chalk.dim(`    ${day(r.first_commit)} → ${day(r.last_commit)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${results.length} repo(s)`, limit, verbose: opts.verbose, detail: "use `repos commits --author <query>` for commit rows" });
  });

// ── Diff Stats ──
program
  .command("diff-stats")
  .description("What changed recently across repos")
  .option("--today", "Today only")
  .option("--week", "Last 7 days")
  .option("--days <n>", "Custom days", "1")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show more authors per repo")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const days = opts.week ? 7 : opts.today ? 1 : intFlag(opts.days, "--days", 1);
    const results = diffStats(days);
    if (opts.json) { printJson(results); return; }
    if (results.length === 0) { console.log(chalk.dim(`No activity in last ${days} day(s)`)); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, results.length || COMPACT_LIMIT);
    const shown = results.slice(0, limit);
    console.log(chalk.bold(`Activity in last ${days} day(s):`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${r.commit_count} commits (+${r.insertions}/-${r.deletions})`);
      if (opts.verbose) console.log(chalk.dim(`    Authors: ${compactList(r.authors, 10, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${results.length} repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full aggregate rows" });
  });

// ── Dirty ──
program
  .command("dirty")
  .description("List repos with uncommitted changes")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const dirty = getDirtyRepos();
    if (opts.json) { printJson(dirty); return; }
    if (dirty.length === 0) { console.log(chalk.green("✓ All repos clean")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, dirty.length || COMPACT_LIMIT);
    const shown = dirty.slice(0, limit);
    console.log(chalk.bold(`${dirty.length} dirty repo(s):`));
    for (const r of shown) {
      const parts = [];
      if (r.modified) parts.push(chalk.yellow(`${r.modified} modified`));
      if (r.untracked) parts.push(chalk.red(`${r.untracked} untracked`));
      if (r.staged) parts.push(chalk.green(`${r.staged} staged`));
      console.log(`  ${chalk.bold(r.repo_name)}: ${parts.join(", ")}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${dirty.length} dirty repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full paths" });
  });

// ── Unpushed ──
program
  .command("unpushed")
  .description("List repos with unpushed commits")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const unpushed = getUnpushedRepos();
    if (opts.json) { printJson(unpushed); return; }
    if (unpushed.length === 0) { console.log(chalk.green("✓ All repos pushed")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, unpushed.length || COMPACT_LIMIT);
    const shown = unpushed.slice(0, limit);
    console.log(chalk.bold(`${unpushed.length} repo(s) with unpushed commits:`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.yellow(`${r.ahead} ahead`)} on ${r.branch}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${unpushed.length} repo(s)`, limit, verbose: opts.verbose, detail: "use --json for full paths" });
  });

// ── Behind ──
program
  .command("behind")
  .description("List repos behind remote")
  .option("--fetch", "Fetch from remote first")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show repo paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const behind = getBehindRepos(opts.fetch);
    if (opts.json) { printJson(behind); return; }
    if (behind.length === 0) { console.log(chalk.green("✓ All repos up to date")); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, behind.length || COMPACT_LIMIT);
    const shown = behind.slice(0, limit);
    console.log(chalk.bold(`${behind.length} repo(s) behind remote:`));
    for (const r of shown) {
      console.log(`  ${chalk.bold(r.repo_name)}: ${chalk.red(`${r.behind} behind`)} on ${r.branch}`);
      if (opts.verbose) console.log(chalk.dim(`    ${compactText(r.repo_path, 140)}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${behind.length} repo(s)`, limit, verbose: opts.verbose, detail: opts.fetch ? "fetch already ran" : "pass --fetch to refresh remotes first" });
  });

// ── Health ──
program
  .command("health")
  .description("Combined health check: dirty + unpushed + behind + stale")
  .option("-n, --limit <n>", "Max rows per section", "10")
  .option("--verbose", "Show larger sections")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const report = getHealthReport();
    if (opts.json) { printJson(report); return; }

    const issues = report.dirty.length + report.unpushed.length + report.behind.length + report.stale.length;
    if (issues === 0) { console.log(chalk.green("✓ All repos healthy")); return; }
    const sectionLimit = opts.verbose ? resolveLimit(opts, 25, 25) : resolveLimit(opts, 10, 10);

    if (report.dirty.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.dirty.length} dirty repo(s):`));
      for (const r of report.dirty.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.modified}M ${r.untracked}U ${r.staged}S)`);
    }
    if (report.unpushed.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${report.unpushed.length} repo(s) with unpushed commits:`));
      for (const r of report.unpushed.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.ahead} ahead on ${r.branch})`);
    }
    if (report.behind.length > 0) {
      console.log(chalk.red(`\n✗ ${report.behind.length} repo(s) behind remote:`));
      for (const r of report.behind.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.behind} behind on ${r.branch})`);
    }
    if (report.stale.length > 0) {
      console.log(chalk.dim(`\n○ ${report.stale.length} stale repo(s) (30+ days):`));
      for (const r of report.stale.slice(0, sectionLimit)) console.log(`    ${r.repo_name} (${r.days_stale} days)`);
    }
    console.log(chalk.dim("\nUse --verbose or --limit to widen sections, and --json for the full health report."));
  });

// ── CD / Open ──
/**
 * `cd`/`open` resolve fuzzily by default, which is convenient interactively and
 * unsafe for automation — `repos cd todos` will happily return `open-todos`
 * while `platform-todos` also exists. `--exact` and `--remote` opt into a
 * deterministic lookup that fails rather than guessing.
 */
function resolveRepoPath(name: string | undefined, opts: any): string {
  if (opts.remote || opts.exact) {
    // `name` is passed through even alongside --remote so that supplying both
    // is rejected here exactly as it is for `repo`/`show`/`inspect`, rather
    // than the positional being silently ignored.
    return resolveTargetRepo(name, opts).path;
  }
  if (!name) {
    console.error("Repo not found");
    process.exit(1);
  }
  const path = getRepoPath(name);
  if (!path) { console.error("Repo not found"); process.exit(1); }
  return path;
}

program
  .command("cd [name]")
  .description("Print repo path (use: cd $(repos cd open-todos))")
  .option(REMOTE_OPTION, REMOTE_OPTION_HELP)
  .option("--exact", "Match the local name or path exactly; never fuzzy-match")
  .action((name, opts) => {
    console.log(resolveRepoPath(name, opts));
  });

program
  .command("open [name]")
  .description("Open repo in VS Code")
  .option(REMOTE_OPTION, REMOTE_OPTION_HELP)
  .option("--exact", "Match the local name or path exactly; never fuzzy-match")
  .action((name, opts) => {
    execSync(`code "${resolveRepoPath(name, opts)}"`);
  });

// ── Report ──
program
  .command("report")
  .description("Weekly summary report")
  .option("--days <n>", "Look back N days", "7")
  .option("--verbose", "Show larger top lists")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const report = getReport(intFlag(opts.days, "--days", 1));
    if (opts.json) { printJson(report); return; }
    console.log(chalk.bold(`Report: ${report.period}`));
    console.log(`  Repos touched: ${report.repos_touched}`);
    console.log(`  Commits: ${report.total_commits}`);
    console.log(`  LOC: +${report.total_insertions} / -${report.total_deletions}`);
    if (report.top_repos.length > 0) {
      console.log(chalk.dim("\n  Top repos:"));
      for (const r of report.top_repos.slice(0, opts.verbose ? 10 : 5)) console.log(`    ${r.name}: ${r.commits} commits`);
    }
    if (report.top_authors.length > 0) {
      console.log(chalk.dim("\n  Top authors:"));
      for (const a of report.top_authors.slice(0, opts.verbose ? 10 : 5)) console.log(`    ${a.author}: ${a.commits} commits`);
    }
    if (!opts.verbose) console.log(chalk.dim("\nUse --verbose for larger top lists, or --json for the full report."));
  });

// ── Churn ──
program
  .command("churn")
  .description("Most frequently changed files across repos")
  .option("--days <n>", "Look back N days", "30")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--verbose", "Show wider file paths")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const limit = resolveLimit(opts, COMPACT_LIMIT, 20);
    const results = getChurn(intFlag(opts.days, "--days", 1), limit);
    if (opts.json) { printJson(results); return; }
    if (results.length === 0) { console.log(chalk.dim("No file changes found")); return; }
    console.log(chalk.bold("Most changed files:"));
    for (const r of results) {
      console.log(`  ${chalk.yellow(`${r.change_count}x`)} ${compactText(r.file, opts.verbose ? 160 : 96)} ${chalk.dim(`(${r.repo_name})`)}`);
    }
    printCompactHint({ count: results.length, noun: "file(s)", limit, verbose: opts.verbose, detail: "use --days to change the window" });
  });

// ── Languages ──
program
  .command("languages")
  .description("Language breakdown per org")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show more org counts")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const languages = getLanguages();
    if (opts.json) { printJson(languages); return; }
    const limit = resolveLimit(opts, COMPACT_LIMIT, languages.length || COMPACT_LIMIT);
    const shown = languages.slice(0, limit);
    console.log(chalk.bold("Languages:"));
    for (const l of shown) {
      const entries = Object.entries(l.orgs);
      const orgEntries = opts.verbose ? entries : entries.slice(0, 4);
      const orgStr = orgEntries.map(([o, c]) => `${o}:${c}`).join(", ");
      const suffix = !opts.verbose && entries.length > orgEntries.length ? ` +${entries.length - orgEntries.length} more` : "";
      console.log(`  ${chalk.cyan(l.language)}: ${l.repo_count} repos ${chalk.dim(`(${orgStr})`)}`);
      if (suffix) console.log(chalk.dim(`    ${suffix}`));
    }
    printCompactHint({ count: shown.length, noun: `of ${languages.length} language(s)`, limit, verbose: opts.verbose, detail: "use --json for full org breakdowns" });
  });

// ── Import / Export ──
program
  .command("export")
  .description("Export repo list as JSON or CSV")
  .option("--csv", "Export as CSV")
  .option("--json", "Export as JSON (default)")
  .action((opts) => {
    console.log(exportRepos(opts.csv ? "csv" : "json"));
  });

program
  .command("import <org>")
  .description("Clone all repos from a GitHub org")
  .option("--dir <path>", "Target directory", ".")
  .option("--json", "Output as JSON")
  .action((org, opts) => {
    const result = importFromOrg(org, opts.dir, {
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    if (opts.json) { printJsonLine(result); return; }
    console.log(chalk.green(`\n✓ Cloned ${result.cloned}, skipped ${result.skipped}`));
    if (result.errors.length > 0) console.log(chalk.yellow(`  ${result.errors.length} errors`));
  });

// ── Repository lifecycle ──
/**
 * The repository plane as top-level verbs: `create`, `clone`, `archive`.
 *
 * The design names these `repos repo create` etc., but `repo [name]` is an
 * existing lookup command whose positional would swallow the subcommand — a
 * repo literally named "create" is expressible today — so the verbs sit at the
 * top level next to `import`, which set the precedent for acquisition verbs.
 *
 * The property that matters is inherited from `src/lib/repo-lifecycle.ts` and
 * asserted in `repo-lifecycle-cli.test.ts`: the caller's token environment is
 * never the operation's authority, and a missing station credential is a
 * typed, fail-closed refusal. There is deliberately no `delete` verb.
 */
function printRepoLifecycleError(error: unknown, json: boolean, schema: string): void {
  const code = error instanceof RepoLifecycleError ? error.code : "UNEXPECTED_ERROR";
  const message = error instanceof Error ? error.message : "unknown repository lifecycle error";
  if (json) {
    const details = error instanceof RepoLifecycleError ? error.details : undefined;
    printJson({ schema, ok: false, error: { code, message, details } });
  } else {
    console.error(chalk.red(`${code}: ${message}`));
    const hint = error instanceof RepoLifecycleError ? error.details.hint : undefined;
    if (hint) console.error(chalk.dim(`  ${hint}`));
  }
  process.exitCode = 1;
}

program
  .command("create <org/name>")
  .description("Create a GitHub repository through the CLI's own credential — the caller holds no token")
  .option("--public", "Create public (default: private)")
  .option("--description <text>", "Repository description")
  .option("--dir <parent>", "Also clone into <parent>/<name> and register the checkout")
  .option("--json", "Output the versioned JSON result")
  .action(async (spec, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = await createRepository({
        spec,
        visibility: opts.public ? "public" : "private",
        description: opts.description,
        cloneParentDir: opts.dir,
      });
      if (json) {
        printJson(result);
        return;
      }
      console.log(chalk.green(`✓ created ${result.repo.url} (${result.repo.visibility})`));
      if (result.clone) console.log(chalk.dim(`  cloned and registered ${result.clone.path}`));
      else console.log(chalk.dim("  no local clone (pass --dir <parent> to clone and register)"));
    } catch (error) {
      printRepoLifecycleError(error, json, REPO_CREATE_SCHEMA);
    }
  });

program
  .command("clone <org/name>")
  .description("Clone one repository to <dir>/<name> and register it — credential stays behind the CLI")
  .option("--dir <parent>", "Parent directory for the clone (default: current directory)")
  .option("--json", "Output the versioned JSON result")
  .action(async (spec, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = await cloneRepository({ spec, parentDir: opts.dir });
      if (json) {
        printJson(result);
        return;
      }
      console.log(chalk.green(`✓ cloned and registered ${result.clone.path}`));
    } catch (error) {
      printRepoLifecycleError(error, json, REPO_CLONE_SCHEMA);
    }
  });

program
  .command("archive <repo>")
  .description("Archive a repository on GitHub (reversible with --restore); there is no delete verb")
  .option("--restore", "Unarchive instead")
  .option("--json", "Output the versioned JSON result")
  .action((target, opts) => {
    const json = Boolean(opts.json);
    try {
      const result = archiveRepository({ target, restore: Boolean(opts.restore) });
      if (json) {
        printJson(result);
        return;
      }
      const verb = result.archived ? "archived" : "unarchived";
      console.log(chalk.green(`✓ ${verb} ${result.repo.org}/${result.repo.name}`));
    } catch (error) {
      printRepoLifecycleError(error, json, REPO_ARCHIVE_SCHEMA);
    }
  });

// ── Agent Ops ──
const packageOps = program.command("package").description("Package health, drift, and bin resolution primitives");

addOpsOptions(packageOps
  .command("health [path]")
  .description("Check package.json, scripts, bins, and lockfiles (compact JSON default)"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getPackageHealth({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(packageOps
  .command("drift [path]")
  .description("Check package.json versus bun.lock drift (compact JSON default)"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getPackageDrift({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(packageOps
  .command("dependents")
  .description("Confirm which repos declare an exact dependency on a package (not a substring match)")
  .requiredOption("--name <package>", "Package name to confirm dependents for")
  .requiredOption("--paths <paths>", "Comma-separated candidate repo paths")
  .option("--max-depth <n>", "How deep to look for workspace manifests", "4"))
  .action((opts: any) => {
    const roots = String(opts.paths).split(",").map((entry: string) => entry.trim()).filter(Boolean);
    const report = withTodos(
      getManifestDependents({
        packageName: String(opts.name),
        roots,
        limit: intFlag(opts.limit, "--limit", 1),
        maxDepth: intFlag(opts.maxDepth, "--max-depth", 0),
      }),
      todosOpts(opts, process.cwd())
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(packageOps
  .command("resolve-bin [name]")
  .description("Resolve a package bin from package.json, node_modules/.bin, or PATH")
  .option("--path <path>", "Package root", "."))
  .action((name: string | undefined, opts: any) => {
    const cwd = opts.path ?? process.cwd();
    const report = withTodos(
      resolvePackageBin({ cwd, name, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const portsOps = program.command("ports").description("Local port inspection primitives");

addOpsOptions(portsOps
  .command("scan [path]")
  .description("Scan listening TCP ports and annotate ports referenced by package scripts")
  .option("--port <n>", "Only return one port"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const port = opts.port === undefined ? undefined : intFlag(opts.port, "--port", 1);
    const report = withTodos(
      scanPorts({ cwd, port, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const triageOps = program.command("triage").description("Branch and pull request triage primitives");

addOpsOptions(triageOps
  .command("branches [path]")
  .description("Triage current git branch, dirty state, stale branches, and merged branches")
  .option("--stale-days <n>", "Stale local branch threshold", "30"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      triageBranches({
        cwd,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(triageOps
  .command("prs [path]")
  .description("Triage GitHub pull requests via gh")
  .option("--state <state>", "PR state passed to gh", "open")
  .option("--stale-days <n>", "Stale PR threshold", "14"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      triagePullRequests({
        cwd,
        state: opts.state,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const docsOps = program.command("docs").description("Documentation drift primitives");

addOpsOptions(docsOps
  .command("drift [path]")
  .description("Check README coverage for package name, bins, and agent ops commands"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getDocsDrift({ cwd, limit: intFlag(opts.limit, "--limit", 1) }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const releaseOps = program.command("release").description("Release readiness primitives");

addOpsOptions(releaseOps
  .command("health [path]")
  .description("Combine package, drift, docs, branch, and release-pipeline checks for release readiness")
  .option("--no-git", "Skip git branch checks")
  .option("--registry", "Also check npm registry latest vs local git tags")
  .option("--stale-days <n>", "Stale local branch threshold", "30"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getReleaseHealth({
        cwd,
        includeGit: opts.git,
        includeRegistry: Boolean(opts.registry),
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(releaseOps
  .command("parity [path]")
  .description("Check the standard ci.yml + tag-publish publish.yml pair and npm-latest-without-git-tag drift")
  .option("--no-registry", "Skip the npm registry drift check"))
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getReleasePipelineParity({
        cwd,
        includeRegistry: opts.registry !== false,
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

addOpsOptions(program
  .command("release-health [path]")
  .description("Alias for release health"))
  .option("--no-git", "Skip git branch checks")
  .option("--stale-days <n>", "Stale local branch threshold", "30")
  .action((path: string | undefined, opts: any) => {
    const cwd = path ?? process.cwd();
    const report = withTodos(
      getReleaseHealth({
        cwd,
        includeGit: opts.git,
        staleDays: intFlag(opts.staleDays, "--stale-days", 1),
        limit: intFlag(opts.limit, "--limit", 1),
      }),
      todosOpts(opts, cwd)
    );
    printOpsJson(report, opts.pretty);
  });

const noCloudOps = program.command("no-cloud").description("No-cloud migration inventory primitives");

noCloudOps
  .command("inventory [path]")
  .description("Scan git repos for legacy Hasna cloud references and optional npm latest metadata")
  .option("-n, --limit <n>", "Max returned repos/npm packages", "200")
  .option("--max-depth <n>", "Max directory depth when discovering git roots", "8")
  .option("--include-npm", "Also query npm metadata for @hasna packages: local manifests unioned with the published scope")
  .option("--npm-package <name>", "Check exactly these packages instead of the derived union; repeat or comma-separate", collectValues, [])
  .option("--pretty", "Pretty-print JSON")
  .action((path: string | undefined, opts: any) => {
    const root = path ?? process.cwd();
    const report = getNoCloudInventory({
      root,
      limit: intFlag(opts.limit, "--limit", 1),
      maxDepth: intFlag(opts.maxDepth, "--max-depth", 1),
      includeNpm: Boolean(opts.includeNpm) || Boolean(opts.npmPackage?.length),
      npmPackages: opts.npmPackage,
    });
    printOpsJson(report, opts.pretty);
    // A source that failed or hit the registry's result ceiling still contributed,
    // so this warns rather than failing — but it must not be silent, because an
    // inventory that looks complete and is not is the whole defect.
    const degraded = (report.summary.registry_enumeration_sources ?? [])
      .filter((source) => source.status !== "ok");
    if (report.summary.registry_enumeration === "ok" && degraded.length > 0) {
      console.error(chalk.yellow(
        `registry enumeration degraded: ${degraded.map((s) => `${s.source}=${s.status}`).join(", ")}; coverage may be narrower than the scope.`,
      ));
      if (report.summary.registry_enumeration_detail) {
        console.error(chalk.dim(`  ${report.summary.registry_enumeration_detail}`));
      }
    }
    if (report.summary.registry_enumeration === "failed") {
      // The caller asked for registry coverage and did not get it. Reporting a
      // narrower inventory at exit code 0 is the failure mode this whole change
      // exists to remove, so it fails and says by how much.
      console.error(chalk.red(
        `registry enumeration failed, so this inventory covers only ${report.summary.registry_from_local_manifests} locally-declared package(s) plus @hasna/cloud.`,
      ));
      if (report.summary.registry_enumeration_detail) {
        console.error(chalk.dim(`  ${report.summary.registry_enumeration_detail}`));
      }
      process.exitCode = 1;
    }
  });

// ── Knowledge Graph ──
const graph = program.command("graph").description("Knowledge graph commands");

graph
  .command("build")
  .description("Build knowledge graph from repo data")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const result = buildGraph({
      onProgress: opts.json ? undefined : (msg: string) => console.log(chalk.dim(msg)),
    });
    if (opts.json) {
      printJsonLine(result);
    } else {
      console.log(chalk.green(`\n✓ Graph built in ${(result.duration_ms / 1000).toFixed(1)}s — ${result.edges_created} edges`));
    }
  });

graph
  .command("query <type> <id>")
  .description("Query a node (type: repo, author, org, language)")
  .option("-n, --limit <n>", "Max connection rows", "20")
  .option("--verbose", "Show wider connection IDs")
  .option("--json", "Output as JSON")
  .action((type, id, opts) => {
    const node = queryNode(type, id);
    if (!node) { console.log(chalk.red("Node not found")); process.exit(1); }
    if (opts.json) {
      printJson(node);
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, node.edges.length || COMPACT_LIMIT);
      console.log(chalk.bold(`${node.type}: ${node.label}`));
      console.log(chalk.dim(`  ${node.edges.length} connections:`));
      for (const e of node.edges.slice(0, limit)) {
        console.log(`    ${e.relation} → ${e.target_type}:${compactText(e.target_id, opts.verbose ? 120 : 72)} (weight: ${e.weight})`);
      }
      printCompactHint({ count: Math.min(node.edges.length, limit), noun: `of ${node.edges.length} connection(s)`, limit, verbose: opts.verbose, detail: "use --json for full node data" });
    }
  });

graph
  .command("related <repo>")
  .description("Find related repos")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--verbose", "Show wider rows")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const limit = resolveLimit(opts, 10, 10);
    const results = queryRelated(repo, limit);
    if (opts.json) {
      printJson(results);
    } else {
      if (results.length === 0) { console.log(chalk.dim("No related repos found. Run: repos graph build")); return; }
      console.log(chalk.bold(`Repos related to ${repo}:`));
      for (const r of results) {
        console.log(`  ${chalk.bold(compactText(r.repo_name, opts.verbose ? 120 : 72))} — ${r.relation} (weight: ${r.weight})`);
      }
      printCompactHint({ count: results.length, noun: "repo(s)", limit, verbose: opts.verbose, detail: "use --json for full related records" });
    }
  });

graph
  .command("path <from-type> <from-id> <to-type> <to-id>")
  .description("Find shortest path between two nodes")
  .option("--verbose", "Show wider node IDs")
  .option("--json", "Output as JSON")
  .action((fromType, fromId, toType, toId, opts) => {
    const path = findPath(fromType, fromId, toType, toId);
    if (!path) { console.log(chalk.red("No path found")); process.exit(1); }
    if (opts.json) {
      printJson(path);
    } else {
      console.log(chalk.bold(`Path (${path.length} hops):`));
      for (let i = 0; i < path.nodes.length; i++) {
        const n = path.nodes[i]!;
        console.log(`  ${chalk.cyan(n.type)}:${compactText(n.id, opts.verbose ? 120 : 72)}`);
        if (i < path.edges.length) console.log(`    ↓ ${path.edges[i]!.relation}`);
      }
      if (!opts.verbose) console.log(chalk.dim("\nUse --verbose for wider node IDs, or --json for full path data."));
    }
  });

graph
  .command("deps <repo>")
  .description("Show dependency tree for a repo")
  .option("--depth <n>", "Max depth", "3")
  .option("-n, --limit <n>", "Max dependency rows (human output only)", "50")
  .option("--verbose", "Show wider dependency names")
  .option("--json", "Output as JSON")
  .action((repo, opts) => {
    const deps = getDeps(repo, intFlag(opts.depth, "--depth", 1));
    if (opts.json) {
      printJson(deps);
    } else {
      if (deps.length === 0) { console.log(chalk.dim("No dependencies found")); return; }
      const limit = resolveLimit(opts, 50, deps.length || 50);
      const shown = deps.slice(0, limit);
      console.log(chalk.bold(`Dependencies of ${repo}:`));
      for (const d of shown) {
        const indent = "  ".repeat(d.depth);
        console.log(`${indent}└── ${compactText(d.repo_name, opts.verbose ? 120 : 72)}`);
      }
      printCompactHint({ count: shown.length, noun: `of ${deps.length} dependency row(s)`, limit, verbose: opts.verbose, detail: "use --json for full dependency data" });
    }
  });

graph
  .command("authors")
  .description("Show authors who work across multiple orgs")
  .option("-n, --limit <n>", "Max results (human output only)", "20")
  .option("--verbose", "Show wider org lists")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const authors = getCrossOrgAuthors();
    if (opts.json) {
      printJson(authors);
    } else {
      const limit = resolveLimit(opts, COMPACT_LIMIT, authors.length || COMPACT_LIMIT);
      const shown = authors.slice(0, limit);
      console.log(chalk.bold("Cross-org authors:"));
      for (const a of shown) {
        console.log(`  ${chalk.bold(compactText(a.author_email, 72))} — ${compactList(a.orgs, opts.verbose ? 10 : 4, opts.verbose ? 140 : 80)} (${a.total_commits} commits)`);
      }
      printCompactHint({ count: shown.length, noun: `of ${authors.length} author(s)`, limit, verbose: opts.verbose, detail: "use --json for full author records" });
    }
  });

graph
  .command("stats")
  .description("Show graph statistics")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const stats = getGraphStats();
    if (opts.json) {
      printJson(stats);
    } else {
      console.log(chalk.bold(`Graph: ${stats.total_edges} edges`));
      console.log(chalk.dim("\nBy relation:"));
      for (const [rel, count] of Object.entries(stats.by_relation)) {
        console.log(`  ${rel}: ${count}`);
      }
      console.log(chalk.dim("\nBy source type:"));
      for (const [type, count] of Object.entries(stats.by_source_type)) {
        console.log(`  ${type}: ${count}`);
      }
    }
  });

// ── Shell Completions ──
const completions = program.command("completions").description("Output shell completion script");

completions
  .command("bash", { isDefault: true })
  .description("Generate bash completion script")
  .action(() => {
    const cmds = collectCommands(program);
    const subs = cmds.filter((c) => !c.startsWith("graph ")).map((c) => `"${c}"`).join(" ");
    console.log(`#!/usr/bin/env bash
_repos()
{
  local cur="\${3}"
  local cmds="${subs}"
  COMPREPLY=(\$(compgen -W "\${cmds}" -- "\${cur}"))
}
complete -F _repos repos`);
  });

completions
  .command("zsh")
  .description("Generate zsh completion script")
  .action(() => {
    const cmds = collectCommands(program).map((c) => `"${c}"`).join("\n");
    console.log(`#compdef repos
local -a cmds=(
${cmds}
)
_describe 'command' cmds`);
  });

completions
  .command("fish")
  .description("Generate fish completion script")
  .action(() => {
    const cmds = collectCommands(program).map((c) => `    ${c}`).join("\n");
    console.log(`# fish completion for repos
complete -c repos -f -a '
${cmds}
'`);
  });

// ── Backup ──
program
  .command("backup [path]")
  .description("Backup the repos database to a file (default: repos-backup-{date}.db)")
  .option("--json", "Output as JSON")
  .action(async (path, opts) => {
    const { getDbPath } = await import("../db/database.js");
    const { dirname, join } = await import("node:path");
    const { existsSync, copyFileSync, mkdirSync } = await import("node:fs");
    const src = getDbPath();
    const dest = path || join(
      dirname(src),
      `repos-backup-${new Date().toISOString().slice(0, 10)}.db`
    );
    const destDir = dirname(dest);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
    if (opts.json) {
      printJsonLine({ ok: true, source: src, backup: dest });
    } else {
      console.log(chalk.green(`✓ Backed up ${src} → ${dest}`));
    }
  });

// ── Restore ──
program
  .command("restore <path>")
  .description("Restore the repos database from a backup file")
  .option("--force", "Overwrite existing database without prompting")
  .option("--json", "Output as JSON")
  .action(async (src, opts) => {
    const { getDbPath } = await import("../db/database.js");
    const { existsSync, copyFileSync } = await import("node:fs");
    if (!existsSync(src)) {
      const msg = `Backup file not found: ${src}`;
      if (opts.json) printJsonLine({ ok: false, error: msg });
      else console.error(chalk.red(msg));
      process.exit(1);
    }
    const dest = getDbPath();
    if (existsSync(dest) && !opts.force) {
      process.stdout.write(chalk.yellow(`This will overwrite ${dest}. Continue? [y/N] `));
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });
      if (answer.toLowerCase() !== "y") {
        if (opts.json) printJsonLine({ ok: false, cancelled: true });
        else console.log(chalk.yellow("Restore cancelled."));
        process.exit(0);
      }
    }
    copyFileSync(src, dest);
    if (opts.json) {
      printJsonLine({ ok: true, restored: dest, from: src });
    } else {
      console.log(chalk.green(`✓ Restored ${dest} from ${src}`));
    }
  });

function collectCommands(cmd: any, prefix = ""): string[] {
  const results: string[] = [];
  if (cmd.commands) {
    for (const sub of cmd.commands) {
      const name = prefix + sub.name();
      results.push(name);
      results.push(...collectCommands(sub, name + " "));
    }
  }
  return results;
}

await bootstrapCliIfNeeded(process.argv.slice(2));
registerEventsCommands(program, { source: "repos" });
await program.parseAsync(process.argv);
