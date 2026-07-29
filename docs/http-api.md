# HTTP API and dashboard

Start the combined server with:

```bash
repos-serve
REPOS_PORT=20000 repos-serve
```

The default port is `19450`. The executable has no `--port` flag; use
`REPOS_PORT`. It starts the auto-index worker, serves the built dashboard, and
mounts both REST and MCP routes.

## REST endpoints

All REST responses are JSON. Repository and remote fields pass through the
remote-output sanitizer before serialization.

| Method and path | Query/body | Result |
|---|---|---|
| `GET /api/repos` | `org`, `query`, `limit` (50), `offset` (0) | Repository list |
| `GET /api/repos/:id` | `:id` may be a numeric ID, exact path, or exact/unique name | Repo record merged with repo stats; 404 if absent |
| `GET /api/search/repos` | `query`, `limit` (20) | Repository full-text matches |
| `GET /api/commits` | `repo_id`, `author`, `since`, `until`, `limit` (50), `offset` (0) | Commit list |
| `GET /api/search/commits` | `query`, `limit` (20) | Commit full-text matches |
| `GET /api/branches` | `repo_id`, `limit` (100) | Branch list |
| `GET /api/tags` | `repo_id`, `limit` (100) | Tag list |
| `GET /api/prs` | `repo_id`, `state`, `author`, `limit` (50) | Pull request list |
| `GET /api/search` | `query`, `limit` (20) | Unified repo, commit, and PR matches |
| `GET /api/stats` | None | Global totals and summary arrays |
| `GET /api/health` | None | Dirty, unpushed, behind, and stale checkout report |
| `POST /api/scan` | Optional JSON `{ "roots": ["..."], "full": true }` | Forced bootstrap scan plus hook-install counts |

The API does not expose every CLI filter. In particular, REST PR listing does
not accept `org`, `repo_name`, `duplicates`, or pagination offsets; use the CLI,
SDK, or MCP tool when those controls are required.

`POST /api/scan` returns the scan/hook summary after the forced scan completes.

## MCP and service health

The combined server mounts the stateless Streamable HTTP MCP transport at
`/mcp`. `GET /health` is the MCP service liveness response:

```json
{ "status": "ok", "name": "repos" }
```

Workspace checkout health is the separate `GET /api/health` route.

## CORS and static dashboard

API JSON responses allow any origin and advertise `GET`, `POST`, and `OPTIONS`
with the `Content-Type` header. `OPTIONS` receives an empty preflight response.

When `dashboard/dist` is present, `/` and static asset paths serve the React
dashboard. Non-API paths fall back to its `index.html`. The dashboard provides
repo/org listing, repository detail, commit timeline, search, global stats,
checkout health, and a scan action. Because every unknown non-API path receives
the SPA fallback, a missing static asset also receives `index.html`. Unknown API
paths return a JSON 404.
