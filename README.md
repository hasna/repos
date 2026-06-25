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
| `repos storage status` | Show local/remote sync status |
| `repos storage push` | Push local repo data to PostgreSQL |
| `repos storage pull` | Pull PostgreSQL repo data locally |
| `repos storage sync` | Push local changes, then pull remote changes |
| `repos storage migrate` | Apply PostgreSQL migrations |

All commands support `--json` for machine-readable output.

## MCP Server

```bash
repos-mcp
```

23 tools available for AI agents:

- `list_repos`, `get_repo`, `search_repos`
- `list_commits`, `search_commits`
- `list_branches`, `list_tags`
- `list_prs`, `search_prs`
- `list_remotes`
- `search` (unified)
- `scan_repos`
- `get_stats`, `get_repo_stats`
- `sync_github_prs`, `sync_all_github_prs`, `fetch_repo_metadata`
- `repos_storage_status`, `repos_storage_push`, `repos_storage_pull`, `repos_storage_sync`
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

const result = scanRepos(["/home/user/code"]);
const repos = listRepos({ org: "myorg" });
const results = searchAll("authentication");
```

## Data Storage

SQLite database at `~/.hasna/repos/repos.db` with WAL mode and FTS5 full-text search.

Storage sync is optional. By default the package stays local. Set `HASNA_REPOS_DATABASE_URL` or configure `~/.hasna/repos/storage/config.json` to run in hybrid/remote mode with PostgreSQL. `REPOS_DATABASE_URL` remains a shorthand fallback for local scripting.

## License

Apache-2.0
