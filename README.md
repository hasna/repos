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
| `repos worktrees claim` | Claim and create a lease-backed task worktree |
| `repos worktrees inspect` | Inspect persisted lease and git state without implicit scans |
| `repos worktrees verify` | Refuse unsafe local state and require exact validated-origin branch SHA proof |
| `repos worktrees renew` | Heartbeat a lease with generation and fencing-token CAS |
| `repos worktrees release` | Release a safe lease; optional cleanup quarantines only |
| `repos worktrees inventory` | List persisted leases and discovered worktrees without mutation |
| `repos worktrees import` | Import an existing safe worktree into the lease store |

### Worktree control plane

`repos worktrees` is a JSON-first local control plane for agent-created git
worktrees. Claims are persisted in SQLite with the canonical repo, task, run,
machine, path, branch, generation, fencing token, heartbeat, and monotonic
expiry. Expired leases are not stolen automatically and paths are never deleted
by TTL. A different owner trying to reuse an active or expired lease gets an
owner/stale-owner refusal until the existing lease is explicitly verified and
released.

Claim paths are derived rather than caller-selected:
`~/.hasna/repos/worktrees/<machine-id>/<repo-slug>-<repo-hash>/<lease-id>/repo`.
The repo hash is stable for the canonical owner/name and lease IDs use the
`wt_<hex>` form consumed by the worktree guard. Set
`HASNA_REPOS_WORKTREES_ROOT` only when an isolated runtime needs a different
managed root.

```bash
repos worktrees claim \
  --repo hasna/repos \
  --task-id 1d6b96e2-6921-43d0-9684-52211e0034fc \
  --run-id 019f6596-bd43-75c3-90d8-0a77b231e2ba \
  --machine-id station01 \
  --owner pacuvius \
  --base main \
  --mode required \
  --json
```

When `--branch` is omitted, Repos derives a non-protected task branch from the
task and run IDs. An owner/name repo is resolved to its GitHub clone URL, so the
minimal command emitted by the worktree guard is directly executable.

Release and cleanup are fenced operations. `release` requires the current
generation and fencing token, refuses dirty/staged/untracked/detached,
non-origin-upstream, remote-probe, exact-SHA, unique-commit, and unknown-owner
failures, and only quarantines on an explicit `--cleanup quarantine` request.
Mutable local remote-tracking refs are diagnostic only; verify and release query
the validated origin and require its exact branch SHA to equal the worktree
HEAD. Network Git operations clear inherited `GIT_*` controls and global/system
configuration plus proxy and CA override variables; canonical SSH claims with inherited transport commands and
repositories with direct, included, or per-worktree custom transport programs
fail closed. Effective upstream configuration must resolve to the matching
`origin/<branch>` rather than only appearing correct in common config. Quarantine
first locks the lease with a compare-and-swap transition, derives a canonical
direct `refs/hasna/worktrees/...` backup ref, rejects symbolic or conflicting
refs, moves the Git worktree with Git-aware metadata handling, and then records
the final path. Recovery revalidates the actual source or quarantine path
against the same release-safety proof after the move and before completion,
requires the canonical machine/repository/lease path shape, and rolls back
post-move failures or leaves terminally inspectable failed leases. A competing
completion that wins the database transition is preserved rather than rolled
back only when it carries a valid finalized proof, and incomplete recovery
metadata is terminalized. Backup-ref creation and the completed lease row are
both bound to the exact post-move proved HEAD. A distinct
`quarantine_finalizing` state keeps the lease reserved while the combined
HEAD/ref proof is checked after the ownership CAS; only the subsequent terminal
CAS can mark the lease `quarantined`. Proof failures after that ownership claim
remain failed even when the filesystem move can be rolled back.
Plain release uses the same pattern through a reserved `releasing` state and a
reserved `release_committing` state, with complete local/origin proof after the
commit-state CAS and before the terminal `released` transition. Quarantine uses
the equivalent `quarantine_committing` proof phase. Both final proof/CAS
sections hold Git index and branch-ref mutation locks and verify again before
returning success. Provisional terminal rows remain ownership-reserving until
their post-CAS proof atomically marks the corresponding finalized metadata flag;
retries resume that locked proof after a crash. Control-plane lock files carry
owner PID metadata, so a later retry can remove only its own provably dead-owner
locks while leaving foreign Git locks untouched.
Rollback after a quarantine proof failure remains in
`quarantine_compensating`, preserving path and repo/branch uniqueness until the
filesystem and final lease state have both converged.
If recovery cannot resolve a retained artifact, `quarantine_failed` continues
to reserve path and repo/branch ownership for operator inspection.
Creation and import completion use an exclusive `creating` owner; concurrent
retries wait, failed owners return to recoverable `preparing`, and stale owners
can be resumed without letting a losing observer fail the shared lease.
Local sources are accepted only when both the local base and the exact
validated-origin branch resolve to the claimed HEAD.

Migration from the legacy lease schema preserves prior mode, cleanup, Git
common-dir, raw repository ID, original timestamp strings and exact millisecond
precision, verification, error, and owner metadata under a collision-free
`legacy_import` namespace.
Malformed legacy timestamps abort and roll back migration. Unvalidated legacy
nonterminal leases are imported as inspectable `failed` rows rather than
renewable active owners; they must be explicitly validated and imported before
reuse. Timestamp validation follows proleptic Gregorian leap-year rules.
Migration 5 creates the initial lease table. Migration 21 is the unified
successor for the worktree-control-plane lineage and the current registry
lineage; versions 9 through 20 are reserved because unpublished candidates used
those marker numbers for conflicting schemas. The unified migration reconciles
the complete lease state in one transaction, including the active uniqueness
boundary for `quarantine_finalizing`, `releasing`,
`quarantine_compensating`, `creating`, terminal commit proof states, unresolved
quarantine artifacts, and provisional terminal rows whose finalized proof flag
is not yet set. Unknown future nonterminal states remain ownership-reserving by
default. Legacy upgrades reject unknown columns before any rename or projection
so forward data cannot be silently discarded. Migration 21 also requires a
structurally complete proof payload before a terminal row leaves ownership
indexes, valid lowercase 40-hex SHAs, nonnegative proof timestamps, and
preserves one ownership-reserving legacy in-flight row when legacy claims
collide. Its post-marker verification compares exact snapshots of all affected
registry and lease rows, preventing a migration marker trigger from hiding a
write. Completion also requires the exact
`repo_catalog_id -> repos(id) ON DELETE SET NULL` foreign key and zero foreign-key
violations, plus the complete canonical column type and nullability contract.
Lease IDs are explicit non-null single-column `TEXT` primary keys, and
`repo_catalog_id` must remain nullable so `ON DELETE SET NULL` is valid.

Legacy list/search/status commands support `--json` for machine-readable output.

### Primary registry relocation

`repos registry relocate-primary` repairs a stale primary route when the canonical
checkout is already registered as another row. The legacy ID survives and the
explicit target ID is absorbed only after its metadata is reconciled. The command
is a dry run unless `--apply` is given. Both modes require optimistic revisions
for both rows, a canonical target below the trusted user worktree root, a
credential-free `host/owner/name` remote, the target's exact HEAD, and a stable
idempotency key.

Before an operational dry run, verify that the packaged build and the exact
executable selected for use came from the reviewed source commit. The verifier
checks the outer package digest first, then the embedded clean-source
provenance and packaged executable bytes. It does not open the registry.

```bash
repos-verify-release \
  --expected-commit <reviewed-commit> \
  --expected-tree <reviewed-tree> \
  --expected-package-sha256 <reviewed-package-sha256> \
  --expected-executable-sha256 <reviewed-executable-sha256> \
  --package <exact-package-tarball> \
  --executable <exact-repos-executable>
```

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
  --preserve-divergent-branches-under legacy-preserved \
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
  --preserve-divergent-branches-under legacy-preserved \
  --expected-plan-hash <sha256-from-dry-run> \
  --apply \
  --json
```

The source checkout is never read: it may be missing, dirty, or divergent because
the operation changes registry authority, not source files. Its database ID,
path, revision, and sanitized remote remain mandatory guards. The registered
target must be canonical, clean, exact-HEAD, remote-matched, and free of path
aliases. Its checkout, Git directory, common directory, and primary object
directory must all resolve inside the trusted worktree root. Nonempty object
alternates, HTTP alternates, partial-clone/promisor settings, and repository
config includes are rejected before refs or objects are read. This still allows
bundle-derived anchors and linked worktrees when their full Git authority stays
inside the trusted root. Cleanliness is verified without `git status`, worktree
diff, hooks,
fsmonitor, or repository-defined conversion callbacks: the command compares the
HEAD tree, stage-0 index, raw regular-file or symlink bytes, executable modes,
and non-ignored untracked inventory, and rejects conflicts or unsupported
entries. Dry run emits a request hash, plan hash, per-table counts, and hashed
collision decisions. Exact duplicate children may be deduplicated; divergent
commit, tag, remote, PR, edge, or unknown foreign-key state blocks apply without
choosing a winner. Divergent branch rows still block by default. With an explicit
`--preserve-divergent-branches-under <namespace>` review option, only divergent
legacy branch rows may be preserved as deterministic `<namespace>/<branch>` rows;
the target checkout must already contain exact
`refs/heads/<namespace>/<source-branch>` evidence at the reviewed SHA. Preserved
refs are always local heads, even when the namespace matches a configured remote
name. Local target branch rows always require exact `refs/heads/<branch>`
evidence, including local rows named `origin/...`. Remote-marked rows must begin
with a configured remote prefix such as `origin/` and require exact
`refs/remotes/<branch>` evidence; they never fall back to a local head. A
same-name local head may coexist only when it resolves to the same commit;
conflicting local and remote-tracking commits are ambiguous and block relocation.
A remote-marked row named exactly like a configured remote is stale or ambiguous
and also blocks relocation. Apply never creates Git refs. Apply
revalidates the plan under one immediate SQLite
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
