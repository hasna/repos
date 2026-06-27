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
| `repos release health [path]` | Combine package, drift, docs, and branch release checks |
| `repos ops pr-queue` | Emit PR merge task seeds, optional bounded GitHub sync, reports, and todos upserts |
| `repos ops global-cli-smoke` | Check global CLIs, emit task seeds for failures, reports, and todos upserts |
| `repos ops package-hygiene` | Check Bun/npm Hasna package hygiene |

Legacy list/search/status commands support `--json` for machine-readable output.

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
  --sync-max-repos 80 \
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
```

`--sync-orgs` requires `--sync-max-repos`; GitHub sync errors make the command
exit non-zero by default so loop health cannot silently run on stale metadata.
Use `--allow-sync-errors` only for exploratory reads where stale cached PR data
is acceptable.

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
