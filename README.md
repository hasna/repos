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

CLI output is compact by default so it stays readable in agent terminals:

- List/search/status-style commands show essential fields, truncate long text, and cap human rows by default.
- Use `--verbose` for wider human rows and extra fields.
- Use `--limit` plus `--cursor` or `--offset` on paginated list commands for more rows.
- Use `repos show <name>` or `repos inspect <name>` for full repo detail.
- Use `--json` for machine-readable records. JSON output keeps full fields where possible.

## MCP Server

```bash
repos-mcp
```

19 tools available for AI agents:

- `list_repos`, `get_repo`, `search_repos`
- `list_commits`, `search_commits`
- `list_branches`, `list_tags`
- `list_prs`, `search_prs`
- `list_remotes`
- `search` (unified)
- `scan_repos`
- `get_stats`, `get_repo_stats`
- `sync_github_prs`, `sync_all_github_prs`, `fetch_repo_metadata`
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

const result = scanRepos(["/home/user/code"]);
const repos = listRepos({ org: "myorg" });
const results = searchAll("authentication");
```

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
