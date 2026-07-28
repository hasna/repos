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
| `repos repo <name>` / `repos show <name>` / `repos inspect <name>` | Get repo details |
| `repos registry prune` | Retire registry rows whose path no longer exists (dry run unless explicitly confirmed) |
| `repos registry health` | Report how many registry rows point at a usable git checkout |
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

CLI output is compact by default so it stays readable in agent terminals:

- List/search/status-style commands show essential fields, truncate long text, and cap human rows by default.
- Use `--verbose` for wider human rows and extra fields.
- Use `--limit` plus `--cursor` or `--offset` on paginated list commands for more rows.
- Use `repos show <name>` or `repos inspect <name>` for full repo detail.
- Use `--json` for machine-readable records. JSON output keeps full fields where possible.

### no-cloud registry inventory

`repos no-cloud inventory --include-npm` checks published `@hasna` packages for a
surviving dependency on the retired `@hasna/cloud`. The list of packages to check is the
**union of two sources**, because neither is authoritative alone:

- **local manifests** under the scan root — correct for what this machine has checked out,
  but blind to any package whose repo is not cloned here, and keyed on the manifest `name`,
  so a package published under a synthesised name (some are) is invisible to it;
- **the scope roster** (`npm access list packages @hasna`) — what the scope actually
  contains, *including deprecated packages*. Needs no credential: the E401 you get from
  that command is caused by offering a token that lacks org read, so it is retried with the
  user config suppressed, and `GET /-/org/<scope>/package` answers 200 unauthenticated;
- **`npm search @hasna`** — a search index, which is strictly less than an enumeration. It
  omits deprecated packages, and has been measured omitting live non-deprecated ones. Kept
  only as a second opinion in case the roster endpoint changes.

Coverage is the union of all three, so it shrinks only when a package leaves every source.
A single source failing **degrades with a warning** rather than failing the command —
`npm search` is flaky and turning that into a hard error would break a working path — but
if *every* registry source fails the command **exits non-zero** and says how narrow the
result is, rather than reporting a smaller inventory at exit code 0. Per-source outcomes are
in `summary.registry_enumeration_sources`.

The registry search API caps a result set at 250 no matter what `--searchlimit` says, so a
saturated search is reported as `truncated`, never as complete.

`@hasna/cloud` is also pinned in unconditionally and cannot be dropped by any source, since
its deprecation is the exact fact the report exists to surface.

A hardcoded list was tried first and went stale twice (`@hasna/swarm` unpublished while
still listed; `@hasna/deployment` a live 404), so there is no literal list to edit. Deriving
from local manifests alone was tried next and was worse: it silently dropped every package
without a local checkout, including `@hasna/wallets`, which declares the retired
`@hasna/cloud` today.
### Registry prune

`repos registry prune` retires rows whose stored path no longer exists. There was
previously no prune, forget, remove or delete verb at all, so stale rows had no supported
way to be removed — including rows whose obsolete remote still *works* via a GitHub
redirect, which makes any tool resolving them operate on a live repo believing it is the
old one.

**It refuses by default.** A prune verb on a registry is a deletion primitive, so `--apply`
alone is not enough:

```bash
repos registry prune                 # dry run: lists the rows, writes nothing
repos registry prune --apply \
  --expected-database  <the database you intend to prune> \
  --expected-plan-hash <hash from the dry run> \
  --actor <you> --idempotency-key <key>
```

`--expected-database` exists because the failure to design against is not "deleted the
wrong rows", it is **"deleted the right rows in the wrong database"** — a default that
resolves somewhere the operator did not intend now aborts. The dry run deliberately does
**not** pre-fill it: a path the tool supplied could only ever match itself, so it has to
come from your own belief about which registry you are pruning. `--expected-plan-hash`
*is* echoed by the dry run, because binding the exact row set is its whole job — anything
that changed since the dry run aborts. `--idempotency-key` makes a retry replay its receipt
rather than deleting a second, different set. Every applied prune writes a receipt to
`registry_prune_audit` holding the removed rows verbatim.

**Only missing paths, and only paths that are genuinely gone.** Rows for gutted-but-present
checkouts are deliberately left alone: some of those directories are the only surviving copy
of a deleted repository, and while removing a row does not delete files, it destroys the
record of *where that data is*. For the same reason a path that exists but cannot be read —
mode-000 parent, stale mount, IO error — is reported as **undetermined** and never pruned;
`existsSync` answers "gone" to all of those, so paths are classified by errno instead.
**This command never touches the filesystem** — it removes registry rows and nothing else.

The dry run also reports what would cascade away, which is usually the number that matters:

```
291 row(s) point at a path that no longer exists.
    cascades: 134404 commits row(s)
    cascades: 134010 branches row(s)
    cascades: 15760 pull_requests row(s)
```
### Checkout health

A registry row is only useful if its `path` is a checkout something can be done to.
`repos repo <name>` is the lookup automation is told to use for exact targeting, so it
**exits non-zero** when the row's path is not a usable git repository, and reports why:

```
$ repos repo repos --json ; echo "rc=$?"
{ ... "checkout_health": { "state": "missing-path", "usable": false, ... } }
rc=1

# on stderr:
Registry row 'repos' points at a path that is not a usable git checkout (missing-path).
  /home/.../opensourcedev/open-repos/repos does not exist
  The path is gone. Re-clone it with: git clone https://github.com/hasna/repos <path>
```

The record is still printed, because diagnosing the row needs the remote and the
verdict — only the exit status changes. Pass `--allow-unusable-checkout` when you want
the metadata and not the failure. `repos cd` / `repos open` refuse outright and print
nothing, because their output is substituted straight into another command.

`repos registry health` reports the whole picture, counting every row rather than a
page of them:

```
$ repos registry health
Registry checkout health — /home/you/.hasna/repos/repos.db
  1581 rows: 525 usable, 1056 unusable (66.8%)
    worktree-severed-common-dir      394
    worktree-dangling-gitdir         299
    missing-path                     291
    hollow-git-dir                    65
    no-git-dir                         7

$ repos registry health --unusable -n 20     # list the rows that do not resolve
$ repos registry health --state hollow-git-dir --json
```

`hollow-git-dir` means a `.git` directory stripped of `HEAD`, `objects` and `refs` —
`git worktree add` against it is impossible. `unreadable` is deliberately distinct from
all of these: a path that could not be inspected is not a path known to be broken, and
must not be re-cloned over. Getting that distinction right needs the errno, not a
boolean — only `ENOENT`/`ENOTDIR` count as absence, and a checkout you merely lack
permission to read reports `unreadable` rather than being declared gutted.

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

MCP list/search/detail tools return compact JSON summaries by default to avoid dumping large records into agent context. Pass `verbose: true` to a tool call when you need the full records, and use `limit`/`offset` where available to page through large result sets.

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
