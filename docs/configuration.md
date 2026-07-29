# Configuration and storage

## Configuration file

The default configuration file is `~/.hasna/repos/config.json`. Override it
with `HASNA_REPOS_CONFIG_PATH`.

All keys are optional. The effective defaults are:

```json
{
  "commitLimit": 5000,
  "incrementalCommitLimit": 100,
  "scanDepth": 5,
  "excludedPaths": ["node_modules", "dist", "vendor", ".git"],
  "hookPollIntervalMs": 2000,
  "watchDebounceMs": 1500,
  "workspaceRescanIntervalMs": 30000
}
```

`workspaceRoots` defaults to existing `~/workspace` and `~/Workspace`
directories; if neither exists, it uses `~/workspace`. Paths supplied in the
file are resolved to absolute paths.

Aliases can provide an org, scan paths, a repo query, or a combination:

```json
{
  "workspaceRoots": ["/srv/workspace", "/home/me/code"],
  "aliases": {
    "work": {
      "paths": ["/srv/workspace"],
      "org": "example",
      "query": "service"
    }
  }
}
```

Use an alias with `repos scan --filter work` or `repos repos --filter work`.
Scan uses its `paths`; listing uses its `org` and `query`.

## Repository-plane credential

`repos create`, `repos clone`, and `repos archive` do not accept a credential
from the caller. With no configuration they use the station’s `gh` credential
store. A station operator can instead configure an argv that writes one token
to stdout:

```json
{
  "github": {
    "credentialCommand": ["secrets", "get", "github/operator-token"]
  }
}
```

This is an argv, not a shell command. A configured command that fails or emits
no token is a hard failure; the code does not fall back to the `gh` store.
Caller `GH_TOKEN`/`GITHUB_TOKEN` variables and caller-selected `gh` config
directories are removed from child processes. The resolved token is redacted
from command results and diagnostics.

## SQLite database selection

The local SQLite database uses WAL mode, normal synchronous mode, foreign keys,
and FTS5 indexes. Selection precedence is:

1. `HASNA_REPOS_DB_PATH`.
2. The compatibility alias `REPOS_DB_PATH`.
3. The nearest `.repos/repos.db` found while walking from the current directory
   toward the filesystem root.
4. `~/.hasna/repos/repos.db`.
5. Legacy `~/.git-local/repos.db`, but only when that file exists and the new
   home-level database does not.

Set `HASNA_REPOS_REQUIRE_EXPLICIT_DB_PATH=1` to refuse all discovered/default
paths. The exact value `:memory:` is supported for process-local operation;
SQLite `file::memory:` aliases are refused.

`repos backup` and `repos restore` operate on the database selected by these
same rules. Registry apply commands additionally bind the exact selected
database or row revisions as described in the [CLI reference](cli.md).

## Optional Postgres catalog mirror

SQLite remains the local query and indexing store. A remote or hybrid storage
mode can pull/push the repository catalog and automation state around bootstrap
scans using Postgres:

| Variable | Meaning |
|---|---|
| `HASNA_REPOS_STORAGE_MODE` | `local` (default), `remote`, or `hybrid` |
| `REPOS_STORAGE_MODE` | Compatibility alias |
| `HASNA_REPOS_DATABASE_URL` | Postgres connection string; setting it implies hybrid mode when no mode is set |
| `REPOS_DATABASE_URL` | Compatibility alias |
| `HASNA_REPOS_DATABASE_SCHEMA` | Optional simple Postgres schema name |
| `REPOS_DATABASE_SCHEMA` | Compatibility alias |
| `HASNA_REPOS_DATABASE_SSL` | SSL flag; defaults to enabled; `0`, `false`, `no`, or `off` disables it |
| `REPOS_DATABASE_SSL` | Compatibility alias |

Remote synchronization covers `repos` and `automation_state`; commits,
branches, tags, PRs, agents, graph edges, audits, and worktree leases remain in
the local SQLite registry. A synchronization failure is returned as closed,
redacted status rather than exposing connection details.

Machine attribution for catalog records and worktree leases uses the first set
value of `HASNA_MACHINE_ID`, `OPEN_MACHINES_ID`, `MACHINE_ID`, then the system
hostname.

## Indexing and hooks

Bootstrap discovers repositories under the configured roots, installs a marked
block in each usable checkout’s `post-commit` hook without replacing existing
hook content, and indexes repository metadata. The queue defaults to
`~/.hasna/repos/hook-events.tsv`; override it with
`HASNA_REPOS_HOOK_QUEUE_PATH`.

`repos watch`, `repos-mcp`, and `repos-serve` start the auto-index worker. It
polls the hook queue, watches for new checkouts, and periodically rescans roots.
The MCP worker can be disabled with `REPOS_DISABLE_AUTO_INDEX=1`. Implicit CLI
bootstrap can be disabled separately with `HASNA_REPOS_AUTO_BOOTSTRAP=0`.

## Other environment variables

| Variable | Used by |
|---|---|
| `HASNA_REPOS_GITHUB_CACHE_PATH` | Default path for the GitHub catalog cache |
| `LOOPS_TODOS_PROJECT` | Default todos project for loop-producer task upserts |
| `REPOS_PORT` | `repos-serve` port; default `19450` |
| `MCP_HTTP_PORT` | Standalone `repos-mcp` HTTP port; default `8874` |
| `MCP_STDIO=1` | Select stdio transport for `repos-mcp` |
| `MCP_HTTP=1` | Explicitly select the already-default HTTP mode |
| `HASNA_EVENTS_DIR` | Store for `repos events` and `repos webhooks` |
| `HASNA_EVENTS_HOME` | Compatibility fallback for the events store |

The default GitHub catalog cache is `~/.hasna/repos/github-catalog.json`. The
default events store is `~/.hasna/events`.
