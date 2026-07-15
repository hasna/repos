# @hasna/repos

Local repo intelligence platform for AI agents. Track all repos on your machine, search commits, PRs, branches across every repository. CLI + MCP server + Web dashboard.

## Install

```bash
bun install -g @hasna/repos
```

## Quick Start

```bash
# Scan all repos under ~/Workspace
repos scan

# List all tracked repos
repos repos

# Search across everything
repos search "authentication"

# Show stats
repos stats

# Start the dashboard
repos-serve  # http://localhost:19450
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `repos scan` | Discover and index all git repos |
| `repos repos` | List repositories |
| `repos repo <name>` | Get repo details |
| `repos registry relocate-primary` | Losslessly absorb a registered canonical target into a preserved legacy repo ID |
| `repos commits` | List commits |
| `repos branches` | List branches |
| `repos tags` | List tags |
| `repos prs` | List pull requests |
| `repos search <query>` | Unified search across all entities |
| `repos stats` | Global statistics |
| `repos activity` | Recent commit activity |
| `repos contributors` | Top contributors |
| `repos stale` | Stale repos with no recent commits |
| `repos heatmap` | Commit activity heatmap |
| `repos sync-github` | Sync PRs from GitHub |
| `repos gh-info <name>` | Fetch GitHub metadata |
| `repos gh-catalog` | Enumerate/cache GitHub repository catalog JSON for OpenLoops |
| `repos package health [path]` | Check package scripts, bins, lockfiles, and release metadata |
| `repos package drift [path]` | Compare package.json against bun.lock |
| `repos package resolve-bin [name]` | Resolve package bins from package.json, node_modules, or PATH |
| `repos ports scan [path]` | Scan listening ports and match package script port hints |
| `repos triage branches [path]` | Summarize branch, dirty, stale, merged, ahead/behind state |
| `repos triage prs [path]` | Summarize GitHub PR state through `gh` |
| `repos docs drift [path]` | Check README coverage for package and agent ops commands |
| `repos release health [path]` | Combine package, drift, docs, branch, and release-pipeline checks |
| `repos release parity [path]` | Check the standard ci.yml + tag-publish publish.yml pair and npm-latest-without-git-tag drift |
| `repos no-cloud inventory [path]` | Scan repos for legacy cloud package references and route-safe remediation metadata |
| `repos ops pr-queue` | Emit PR merge task seeds, optional bounded GitHub sync, reports, and todos upserts |
| `repos ops global-cli-smoke` | Check global CLIs, emit task seeds for failures, reports, and todos upserts |
| `repos ops package-hygiene` | Check Bun/npm Hasna package hygiene |
| `repos ops release-candidates` | Detect releasable repo changes or release blockers and emit task seeds |
| `repos ops release-pipeline-parity` | Flag repos missing the standard CI + tag-publish workflow pair or with npm-latest-without-git-tag drift |
| `repos ops docs-rules-drift` | Detect code changes that need docs, changelog, prompt, skill, or agent-rule updates |
| `repos ops dependency-refresh` | Detect dependency refresh needs and emit lifecycle-routed task seeds |
| `repos ops workspace-worktree-hygiene` | Scan workspace repos for stale, dirty, detached, or missing loop worktrees |
| `repos ops task-route-health` | Check that task-created lifecycle router loops are active and recently succeeding |
| `repos ops protected-release` | Emit a protected release task only when release-candidate gates are green |

Legacy list/search/status commands support `--json` for machine-readable output.

### Primary registry relocation

`repos registry relocate-primary` repairs a stale primary route when the canonical
checkout is already registered as another row. The legacy ID survives and the
explicit target ID is absorbed only after its metadata is reconciled. The command
is a dry run unless `--apply` is given. Both modes require optimistic revisions
for both rows, a canonical target below the trusted user worktree root, a
credential-free `host/owner/name` remote, the target's exact HEAD, and a stable
idempotency key.

For the Infinity Machine cutover, the reviewed live registry map is exact:

| Repository | Preserved legacy ID | Absorbed canonical ID |
|------------|--------------------:|----------------------:|
| `hasna/codewith` | 661 | 1510 |
| `hasna/infinity` | 662 | 1511 |
| `hasna/sandboxes` | 663 | 1509 |
| `hasna/accounts` | 664 | 1508 |

Do not infer these IDs from alphabetical order or from an older snapshot. Each
apply still requires both live row revisions, the exact canonical path and HEAD,
and the reviewed dry-run plan hash.

```bash
# Validation only (default)
repos registry relocate-primary \
  --repo-id 663 \
  --expected-current-path /dev/shm/infinity-local-build-20260710/repos/sandboxes \
  --expected-source-revision '<legacy-updated-at>' \
  --target-repo-id 1509 \
  --target-path ~/.hasna/repos/worktrees/infinity-machine/sandboxes/aa2d66d2/primary-main-382840bccf52 \
  --expected-target-revision '<target-updated-at>' \
  --expected-remote github.com/hasna/sandboxes \
  --expected-head <exact-lowercase-sha> \
  --actor operator:<identity> \
  --idempotency-key sandboxes-primary-cutover-v1 \
  --json

# Apply only after reviewing the dry-run envelope
repos registry relocate-primary \
  --repo-id 663 \
  --expected-current-path /dev/shm/infinity-local-build-20260710/repos/sandboxes \
  --expected-source-revision '<legacy-updated-at>' \
  --target-repo-id 1509 \
  --target-path ~/.hasna/repos/worktrees/infinity-machine/sandboxes/aa2d66d2/primary-main-382840bccf52 \
  --expected-target-revision '<target-updated-at>' \
  --expected-remote github.com/hasna/sandboxes \
  --expected-head <exact-lowercase-sha> \
  --actor operator:<identity> \
  --idempotency-key sandboxes-primary-cutover-v1 \
  --expected-plan-hash <sha256-from-dry-run> \
  --apply \
  --json
```

The source checkout is never read: it may be missing, dirty, or divergent because
the operation changes registry authority, not source files. Its database ID,
path, revision, and sanitized remote remain mandatory guards. The registered
target must be canonical, clean, exact-HEAD, remote-matched, and free of path
aliases. Dry run emits a request hash, plan hash, per-table counts, and hashed
collision decisions. Exact duplicate children may be deduplicated; divergent
commit, branch, tag, remote, PR, edge, or unknown foreign-key state blocks apply
without choosing a winner. Apply revalidates the plan under one immediate SQLite
transaction, reparents supported children and catalog- or path-bound worktree
leases, converges graph edges by their final mapped identity, deletes only the
absorbed target row, absorbs the target's operational metadata while retaining
the legacy ID and earliest creation time, verifies foreign keys, and writes a
sanitized receipt. Any failure rolls back everything, and an exact idempotent
retry reads back the original receipt.

Agent-loop ops commands emit compact JSON by default and bound returned lists with
`--limit`. Each supports `--pretty` for readable JSON, `--todo <id>` for a dry-run
todos comment preview, and `--todo-apply` to write that compact result back to a
task. Mutating todos integration is opt-in.

Loop producer commands use a stricter contract for deterministic OpenLoops jobs:
they emit `task_suggestions`, can write a private JSON report with `--report-dir`,
and can upsert a bounded number of deduped todos tasks with `--upsert-tasks`.
This lets loops follow the pattern: check expectation, write compact evidence,
upsert one task per unmet expectation, then let task-created headless workflows
claim the task. They should not dispatch prompts into tmux panes.

Examples:

```bash
repos ops pr-queue \
  --sync-orgs hasna,hasnaxyz,hasnatools,hasnastudio,hasnaai,hasnaeducation,hasnafamily \
  --state open \
  --limit 100 \
  --report-dir ~/.hasna/loops/reports/repo-pr-sync-producer \
  --upsert-tasks \
  --todos-project ~/.hasna/loops \
  --task-list repo-pr-merge-queue \
  --max-task-actions 50 \
  --json

repos ops global-cli-smoke \
  --report-dir ~/.hasna/loops/evidence/global-cli-smoke-native \
  --upsert-tasks \
  --todos-project ~/.hasna/loops \
  --task-list global-cli-smoke \
  --max-task-actions 20 \
  --json

repos ops release-candidates \
  --repo ~/workspace/hasna/opensource/open-codewith \
  --github-repo hasna/codewith \
  --package @hasna/codewith \
  --branch main \
  --tag-prefix rust-v \
  --version-file codex-rs/Cargo.toml \
  --report-dir ~/.hasna/loops/reports/open-codewith-release-candidates \
  --upsert-tasks \
  --todos-project ~/.hasna/loops \
  --task-list repo-release-candidates \
  --max-task-actions 1 \
  --json

repos ops docs-rules-drift \
  --repo ~/workspace/hasna/opensource/open-codewith \
  --github-repo hasna/codewith \
  --report-dir ~/.hasna/loops/reports/open-codewith-docs-rules-drift \
  --upsert-tasks \
  --todos-project ~/workspace/hasna/opensource/open-codewith \
  --task-list codewith-product-backlog \
  --max-task-actions 1 \
  --json

repos ops workspace-worktree-hygiene \
  --root ~/workspace/hasna/opensource \
  --worktree-root ~/.hasna/loops/worktrees \
  --stale-days 7 \
  --report-dir ~/.hasna/loops/reports/opensource-worktree-hygiene \
  --upsert-tasks \
  --todos-project ~/.hasna/loops \
  --task-list workspace-worktree-hygiene \
  --max-task-actions 5 \
  --json
```

`--sync-max-repos` is optional with `--sync-orgs`: omit it to paginate every
repo across the orgs (the default for the merge-queue producer, so no repo is
starved by a cap); pass it only to deliberately bound a run. Renamed or deleted
remotes (GitHub 404s) are skipped-and-continued and reported under
`synced.skipped`, never as errors. Genuine GitHub sync errors make the command
exit non-zero by default so loop health cannot silently run on stale metadata.
Use `--allow-sync-errors` only for exploratory reads where stale cached PR data
is acceptable.

Release-candidate producers intentionally exit zero when they find release
blockers after writing the report/task. The loop's job is to turn releasability
state into deduped tasks; only report/task write failures should make the
producer loop fail. Auto-routed release tasks are prepare-only: workers may
update changelogs, release notes, PRs, and evidence, but must not create or push
release tags, run `npm publish`/`bun publish`, or dispatch release workflows.
Actual publishing belongs in a separate approved/protected release step.

## MCP Server

```bash
repos-mcp
```

34 tools available for AI agents:

- `list_repos`, `get_repo`, `search_repos`
- `list_commits`, `search_commits`
- `list_branches`, `list_tags`
- `list_prs`, `search_prs`
- `list_remotes`
- `search` (unified)
- `scan_repos`
- `get_stats`, `get_repo_stats`
- `sync_github_prs`, `sync_all_github_prs`, `fetch_repo_metadata`
- `graph_build`, `graph_query`, `graph_related`, `graph_path`, `graph_deps`, `graph_stats`
- `package_health`, `package_drift`, `package_resolve_bin`
- `ports_scan`, `triage_branches`, `triage_prs`
- `docs_drift`, `release_health`
- `register_agent`, `heartbeat`, `list_agents`

## REST API

```bash
repos-serve  # Default port: 19450
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/repos` | GET | List repos |
| `/api/repos/:id` | GET | Get repo + stats |
| `/api/search/repos` | GET | Search repos |
| `/api/commits` | GET | List commits |
| `/api/search/commits` | GET | Search commits |
| `/api/branches` | GET | List branches |
| `/api/tags` | GET | List tags |
| `/api/prs` | GET | List PRs |
| `/api/search` | GET | Unified search |
| `/api/stats` | GET | Global stats |
| `/api/scan` | POST | Trigger scan |

## SDK

```typescript
import { scanRepos, searchAll, listRepos, getGlobalStats } from "@hasna/repos";

const result = await scanRepos(["/home/user/code"]);
const repos = listRepos({ org: "myorg" });
const results = searchAll("authentication");
```

## OpenLoops GitHub Catalog

OpenLoops should use the GitHub catalog contract instead of scraping CLI text:

```bash
# Refresh at most one GitHub API page, then return the first 100 matching records.
repos gh-catalog --sync --max-pages 1 --json --limit 100

# Continue a partial sync later without loading all repos in one run.
repos gh-catalog --sync --resume --max-pages 1 --json

# Enumerate cached records only, filtered for sequential multi-repo loop setup.
repos gh-catalog --json --org hasna --language TypeScript --tags open-loops --limit 25 --offset 0
```

SDK entry points:

```typescript
import {
  enumerateGithubRepoCatalog,
  iterateGithubRepoCatalog,
  syncGithubRepoCatalog,
} from "@hasna/repos";

const cache = syncGithubRepoCatalog({ maxPages: 1, resume: true });
const page = enumerateGithubRepoCatalog({
  limit: 25,
  offset: 0,
  filter: { org: "hasna", packageScope: "@hasna", tags: ["open-loops"] },
});

for (const repo of iterateGithubRepoCatalog({ filter: { language: "TypeScript" } })) {
  // Run one repository loop at a time.
}
```

The JSON envelope uses schema `open-repos.github-catalog.v1` and includes `source.cacheSyncedAt`, `source.staleAt`, `source.completed`, `source.nextCursor`, `page.nextOffset`, GitHub rate-limit metadata, discovered accounts/orgs, and repository records. Each record includes owner/account, org, repo name/full name, default branch, visibility, archived/disabled/fork flags, topics, description, safe HTTPS/SSH clone URLs, pushed/updated timestamps, primary language, package hints, local path and branch/dirty/ahead/behind status when matched, and loop tags.

The catalog is cacheable and resumable. By default `repos gh-catalog` reads the cache and does not call GitHub; add `--sync` when OpenLoops intentionally wants to refresh data. The cache path defaults to `~/.hasna/repos/github-catalog.json` and can be overridden with `HASNA_REPOS_GITHUB_CACHE_PATH` or `--cache`.

## HTTP mode

Run a shared Streamable HTTP MCP server (stateless, `127.0.0.1` only):

```bash
repos-mcp --http              # default port 8830
MCP_HTTP=1 repos-mcp          # via env
repos-mcp --http --port 8830
```

- Health: `GET http://127.0.0.1:8830/health`
- MCP: `http://127.0.0.1:8830/mcp`
- Stdio remains the default when `--http` / `MCP_HTTP=1` are not set.
- `repos-serve` also mounts `/health` and `/mcp` on its HTTP port.

## Data Storage

SQLite database at `~/.hasna/repos/repos.db` with WAL mode and FTS5 full-text search.

## License

Apache-2.0
