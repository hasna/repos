# MCP server

`repos-mcp` exposes 36 tools. The standalone process uses stateless Streamable
HTTP on `127.0.0.1:8874` by default:

```bash
repos-mcp
repos-mcp --http --port 9000
MCP_HTTP_PORT=9000 repos-mcp
```

Endpoints are `GET /health` and `/mcp`. Unknown routes return JSON 404s.

Use stdio explicitly for a client that owns the child process:

```bash
repos-mcp --stdio
MCP_STDIO=1 repos-mcp
```

`--stdio`/`MCP_STDIO=1` wins when present. `--http` and `MCP_HTTP=1` are
accepted explicit markers for the default mode. The standalone HTTP server is
bound to loopback; there is no CLI option to expose another hostname.

`repos-serve` also mounts `GET /health` and `/mcp` on its port (default 19450),
alongside the dashboard and REST API.

The server starts the workspace auto-index worker before accepting calls. Set
`REPOS_DISABLE_AUTO_INDEX=1` when the MCP process must not scan or install hook
blocks. Database and workspace selection follow
[Configuration and storage](configuration.md).

## Repository and search tools

| Tool | Main arguments | Result |
|---|---|---|
| `list_repos` | `limit`, `offset`, `org`, `query`, `verbose` | Tracked repositories |
| `get_repo` | `id` (numeric ID, path, or name), `verbose` | One repo plus counts/stats |
| `search_repos` | `query`, `limit`, `verbose` | Name, description, and remote matches |
| `list_commits` | `repo_id`, `author`, `since`, `until`, `limit`, `offset`, `verbose` | Commit records |
| `search_commits` | `query`, `limit`, `verbose` | Full-text commit matches |
| `list_branches` | `repo_id`, `is_remote`, `limit`, `offset`, `verbose` | Branch records |
| `list_tags` | `repo_id`, `limit`, `offset`, `verbose` | Tag records |
| `list_prs` | `repo_id`, `org`, `repo_name`, `state`, `author`, `duplicates`, `limit`, `offset`, `verbose` | PRs de-duplicated by identity unless requested otherwise |
| `search_prs` | `query`, `limit`, `verbose` | Full-text PR-title matches |
| `list_remotes` | `repo_id`, `verbose` | Sanitized remotes for one repo |
| `search` | `query`, `limit`, `verbose` | Unified repo, commit, and PR matches |
| `scan_repos` | `roots`, `full` | Forced bootstrap scan plus hook-install counts |
| `get_stats` | `verbose` | Global repository statistics |
| `get_repo_stats` | `repo_id`, `verbose` | Counts, authors, and recent commits for one repo |

## Package and operational tools

These tools return the same versioned operational reports as the corresponding
CLI commands. Most accept `cwd`, `limit`, and optional todos fields
`todo_task_id`, `todo_apply`, `todo_agent`, and `todo_project`. Todos writes are
dry runs unless `todo_apply` is true.

| Tool | Additional arguments |
|---|---|
| `package_health` | Package scripts, bins, and lockfile health |
| `package_drift` | `package.json`/`bun.lock` drift |
| `package_resolve_bin` | `name` |
| `ports_scan` | `port` |
| `triage_branches` | `stale_days` |
| `triage_prs` | `state`, `stale_days` |
| `docs_drift` | README/package/bin/standard-command mention drift |
| `release_health` | `include_git`, `include_registry`, `stale_days` |
| `release_pipeline_parity` | `include_registry` |
| `manifest_dependents` | Required `package_name` and `paths`; optional `max_depth` |

## GitHub tools

| Tool | Main arguments | Result |
|---|---|---|
| `sync_github_prs` | Required `repo`; optional `limit`, `state` | Sync one GitHub remote into all matching local checkouts |
| `sync_all_github_prs` | `org`, `limit` | Sync all indexed GitHub remotes, optionally by org |
| `fetch_repo_metadata` | Required `repo`; optional `verbose` | Description, language, stars, forks, topics |

## Knowledge graph tools

| Tool | Main arguments |
|---|---|
| `graph_build` | None |
| `graph_query` | Required `type` and `id`; optional `limit`, `verbose` |
| `graph_related` | Required `repo`; optional `limit`, `verbose` |
| `graph_path` | Required `from_type`, `from_id`, `to_type`, `to_id`; optional `verbose` |
| `graph_deps` | Required `repo`; optional `depth`, `limit`, `verbose` |
| `graph_stats` | `verbose` |

## Agent registry tools

| Tool | Main arguments |
|---|---|
| `register_agent` | Required `name`; optional `description`, `session_id`, `capabilities`, `working_dir` |
| `heartbeat` | Optional `name`, `status`; a named heartbeat updates `last_seen` |
| `list_agents` | `limit`, `verbose` |

## Compact results and limits

List, search, detail, stats, graph, metadata, and agent tools return compact
JSON summaries by default. Set `verbose: true` for full stored records. Where a
tool is pageable, pass `limit` and `offset`; compact envelopes return a
`next_cursor` hint. MCP list limits are capped at 200 and offsets at 100,000.

PR compact rows retain merge-gate fields (`head_sha`, `mergeable`,
`merge_state_status`, `ci_state`, `is_draft`, `review_decision`). All responses
pass through the remote-output sanitizer so credential-bearing transport URLs
are never returned as stored input.
