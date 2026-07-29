# CLI reference

The package installs four executables:

| Executable | Purpose |
|---|---|
| `repos` | Repository index, search, lifecycle, health, and operational commands |
| `repos-mcp` | MCP server; Streamable HTTP by default, stdio on request |
| `repos-serve` | Dashboard, REST API, and embedded MCP server |
| `repos-verify-release` | Verify a package and executable against reviewed provenance |

Use `-h` or `--help` on an executable, command group, or command for the live
Commander help. `repos --version` and all standalone executables support
`-V`/`--version`.

## Output and startup behavior

Human list output is compact and usually capped. `--verbose` widens commands
that offer it, while `--json` returns full machine-readable records. Paginated
list commands accept `--limit` and `--offset` or `--cursor`; `repos repos` and
`repos prs` warn on stderr when a JSON page is not the complete result.

Before most read commands, the CLI bootstraps an empty or differently configured
index, installs its marked `post-commit` hook block, and scans configured
workspace roots. Set `HASNA_REPOS_AUTO_BOOTSTRAP=0` to disable this. Explicit
scan/watch, mutation, maintenance, and operational command groups do not trigger
that implicit scan. See [Configuration and storage](configuration.md).

Repository names are convenient but can be ambiguous. `repos repo`, `repos
show`, and `repos inspect` accept `--remote <host/org/name>` for an exact remote
identity. `repos cd` and `repos open` also accept `--exact`. Detail commands
print unusable registry rows but exit non-zero unless
`--allow-unusable-checkout` is set; `cd` and `open` never emit an unusable path.

## Index and query commands

| Command | Options and behavior |
|---|---|
| `repos scan` | `--root <paths...>`, `--filter <name>`, `--full`, `-w/--workers <n>`, `--json` |
| `repos watch` | Continuous new-repo and post-commit indexing; `--root <paths...>`, `--filter <name>`, `--full`, `-w/--workers <n>` |
| `repos repos` | `--filter`, `--org`, `--oss`, `--xyz`, `--studio`, `--tools`, `--ai`, `--education`, `--family`, `-q/--query`, pagination, `--verbose`, `--json` |
| `repos repo [name]` | Repo detail; `--remote`, `--allow-unusable-checkout`, `--verbose`, `--json` |
| `repos show [name]` | Alias-shaped repo detail surface with the same options as `repo` |
| `repos inspect [name]` | Alias-shaped repo detail surface with the same options as `repo` |
| `repos commits` | Filter with `--repo`, `--author`, `--since`, `--until`; pagination, `--verbose`, `--json` |
| `repos branches` | Filter with `--repo`, `--remote`, or `--local`; pagination, `--verbose`, `--json` |
| `repos tags` | `--repo`, pagination, `--verbose`, `--json` |
| `repos prs` | `--repo`, `--org`, `--repo-name`, `--state`, `--author`, `--mine`, `--review`, `--duplicates`, pagination, `--verbose`, `--json` |
| `repos search <query>` | Unified repo/commit/PR search; `-n/--limit`, `--verbose`, `--json` |
| `repos stats` | Global totals and activity summaries; `--json` |
| `repos status` | Stable metadata-only inventory contract with no names, paths, branches, messages, or remote URLs; `--json` |
| `repos activity` | `--days`, `-n/--limit`, `--verbose`, `--json` |
| `repos contributors` | `--repo`, `-n/--limit`, `--verbose`, `--json` |
| `repos stale` | `--days`, `-n/--limit` for human output, `--verbose`, `--json` |
| `repos heatmap` | `--repo`, `--json` |
| `repos gh-info <name>` | Fetch description, language, stars, forks, and topics through `gh`; `--json` |
| `repos find <file>` | Find a path fragment across indexed repos; `-n/--limit`, `--verbose`, `--json` |
| `repos who <query>` | Author aggregates; `-n/--limit` for human output, `--verbose`, `--json` |
| `repos diff-stats` | `--today`, `--week`, or `--days`; `-n/--limit` for human output, `--verbose`, `--json` |
| `repos report` | Period summary; `--days`, `--verbose`, `--json` |
| `repos churn` | Changed-file frequency; `--days`, `-n/--limit`, `--verbose`, `--json` |
| `repos languages` | Language/org summary; `-n/--limit` for human output, `--verbose`, `--json` |

The `--mine` and `--review` PR filters call `gh`. Stored PR listings are
de-duplicated by PR identity by default; `--duplicates` restores one row per
local checkout.

## Checkout and repository health

| Command | Options and behavior |
|---|---|
| `repos dirty` | Repos with modified, untracked, or staged files; `-n/--limit`, `--verbose`, `--json` |
| `repos unpushed` | Repos ahead of their tracking branch; `-n/--limit`, `--verbose`, `--json` |
| `repos behind` | Repos behind their tracking branch; `--fetch`, `-n/--limit`, `--verbose`, `--json` |
| `repos health` | Combined dirty, unpushed, behind, and 30-day stale report; `-n/--limit`, `--verbose`, `--json` |
| `repos cd [name]` | Print one usable path; `--remote`, `--exact` |
| `repos open [name]` | Open one usable path in VS Code; `--remote`, `--exact` |

## GitHub sync and catalog

| Command | Options and behavior |
|---|---|
| `repos sync-github` | Sync one `--repo` or all indexed repos, optionally by `--org`; `-n/--limit`, `--no-reconcile`, `--json` |
| `repos gh-catalog` | Cache/list GitHub repos; `--sync`, `--cache-only`, `--resume`, `--cursor`, `--max-pages`, `--page-size`, `--cache`, `--stale-minutes`, `--min-remaining`, filters, pagination, `--json` |

Catalog filters are `--org`, `--repo`, `--language`, `--package-scope`,
`--local-path`, `--tags`, `--include-archived`, and `--include-disabled`.
Without `--sync`, the command reads the cache only. `--sync` and `--cache-only`
are mutually exclusive.

## Registry maintenance

These commands are fail-closed. Dry-run/apply workflows bind the reviewed row
set with a plan hash and write audit receipts when applied.

| Command | Required and optional flags |
|---|---|
| `repos registry health` | `--org`, `--state`, `--unusable`, `-n/--limit`, `--json`; the summary always counts all rows |
| `repos registry prune` | Dry run by default. Apply requires `--apply`, `--expected-database`, `--expected-plan-hash`, `--actor`, and `--idempotency-key`; optional `-n/--limit`, `--json` |
| `repos registry relocate-primary` | Requires `--repo-id`, `--expected-current-path`, `--expected-source-revision`, `--target-repo-id`, `--target-path`, `--expected-target-revision`, `--expected-remote`, `--expected-head`, `--actor`, `--idempotency-key`; `--apply` additionally requires `--expected-plan-hash`; optional `--preserve-divergent-branches-under`, `--dry-run`, `--json` |
| `repos registry adjudicate-branches` | Requires `--spec <path>`; actor and idempotency key may come from the spec or `--actor`/`--idempotency-key`; apply requires `--apply --expected-plan-hash`; optional `--dry-run`, `--json` |

`adjudicate-branches` only supports exact `reclassify-local` rows in its JSON
spec. `--apply` and `--dry-run` are mutually exclusive on both guarded apply
commands.

## Worktree lifecycle

The canonical root is `~/.hasna/repos/worktrees`, derived from the operating
system account rather than caller-controlled `$HOME`.

| Command | Options and behavior |
|---|---|
| `repos worktree add <repo>` | Exactly one of `--task` or `--name`; optional `--base`, `--branch`, `--run-id`, `--cleanup-policy delete-if-clean\|keep`, `--json` |
| `repos worktree list [repo]` | `--stale`, `--stale-days`, `--json` |
| `repos worktree remove <ref>` | Reference is a lease ID or `<repo>/<worktree>`, never a path; `--discard-changes`, `--json` |
| `repos worktree adopt [path]` | The only raw-path worktree verb; dry run by default; `--all`, `--apply`, `--json` |
| `repos worktree release <lease-id>` | Apply the lease cleanup policy; `--keep`, `--json` |

See the README’s [Worktrees](../README.md#worktrees) section for containment,
base-resolution, and evidence-archive guarantees.

## Repository lifecycle and import/export

| Command | Options and behavior |
|---|---|
| `repos create <org/name>` | Private by default; `--public`, `--description`, `--dir <parent>` to clone/register, `--json` |
| `repos clone <org/name>` | Clone one repo and register it; `--dir <parent>`, `--json` |
| `repos archive <repo>` | Archive, or unarchive with `--restore`; `--json` |
| `repos import <org>` | Clone all repos from an org; `--dir`, `--json` |
| `repos export` | JSON by default, or `--csv` |

`create`, `clone`, and `archive` use station-owned GitHub credentials and scrub
caller token/store overrides. There is deliberately no delete command.

## Package and local operational primitives

The commands in this section emit compact JSON by default. Except where noted,
they share `-n/--limit`, `--pretty`, and optional todos integration flags:
`--todo`, `--todo-apply`, `--todo-agent`, and `--todo-project`. Todos writes are
dry-run previews unless `--todo-apply` is present.

| Command | Additional flags |
|---|---|
| `repos package health [path]` | Package scripts, bins, lockfiles, and release metadata |
| `repos package drift [path]` | Compare `package.json` with `bun.lock` |
| `repos package dependents` | Requires `--name` and comma-separated `--paths`; optional `--max-depth` |
| `repos package resolve-bin [name]` | `--path <package-root>` |
| `repos ports scan [path]` | `--port <n>` |
| `repos triage branches [path]` | `--stale-days` |
| `repos triage prs [path]` | `--state`, `--stale-days` |
| `repos docs drift [path]` | Check README mentions for package name, bins, and standard ops commands |
| `repos release health [path]` | `--no-git`, `--registry`, `--stale-days` |
| `repos release parity [path]` | `--no-registry` |
| `repos release-health [path]` | Alias for release health; `--no-git`, `--stale-days` |
| `repos no-cloud inventory [path]` | `-n/--limit`, `--max-depth`, `--include-npm`, repeatable/comma-separated `--npm-package`, `--pretty` |

## Loop producers

Most `repos ops` producers share `--report-dir`, `--upsert-tasks`,
`--todos-project`, `--task-list`, and `--max-task-actions`. Task writes occur
only with `--upsert-tasks`.

| Command | Command-specific flags |
|---|---|
| `repos ops pr-queue` | `--sync`, `--sync-orgs`, optional `--sync-max-repos`, `--allow-sync-errors`, `--org`, `--repo`, `--state`, `-n/--limit`, `--json` |
| `repos ops global-cli-smoke` | `--commands`, `--timeout-ms`, `--json` |
| `repos ops package-hygiene` | `--scope`, `--no-npm-global`, `--timeout-ms`, `--json`; does not have the shared report/task flags |
| `repos ops release-pipeline-parity` | Required `--paths`; `--no-registry`, `--json` |
| `repos ops release-candidates` | Required `--repo`; `--github-repo`, `--package`, `--branch`, `--tag-prefix`, `--version-file`, `--quiet-minutes`, `--timeout-ms`, `--no-fetch`, `--no-require-green-ci`, `--no-open-pr-blocker`, `--json` |
| `repos ops docs-rules-drift` | Required `--repo`; `--github-repo`, `--branch`, `--docs-paths`, `--source-paths`, `--timeout-ms`, `--no-fetch`, `--json` |
| `repos ops dependency-refresh` | Required `--repo`; `--github-repo`, `--max-lock-age-days`, `--timeout-ms`, `--json` |
| `repos ops workspace-worktree-hygiene` | Repeatable/comma-separated `--root`, `--worktree-root`, `--stale-days`, `-n/--limit`, `--timeout-ms`, `--json` |
| `repos ops task-route-health` | Required `--router-loop`; `--project`, `--max-age-minutes`, `--timeout-ms`, `--json` |
| `repos ops protected-release` | Required `--repo`; release-candidate flags plus `--approval-label`, `--json` |

Release-candidate state such as “blocked” is producer output, not a producer
failure; task/report write failures still produce a non-zero exit. PR sync
errors are non-zero unless `--allow-sync-errors` is explicitly supplied.

## Knowledge graph

Run `repos graph build` after indexing before querying derived relationships.

| Command | Options |
|---|---|
| `repos graph build` | `--json` |
| `repos graph query <type> <id>` | `-n/--limit`, `--verbose`, `--json`; types are `repo`, `author`, `org`, `language` |
| `repos graph related <repo>` | `-n/--limit`, `--verbose`, `--json` |
| `repos graph path <from-type> <from-id> <to-type> <to-id>` | `--verbose`, `--json` |
| `repos graph deps <repo>` | `--depth`, `-n/--limit` for human output, `--verbose`, `--json` |
| `repos graph authors` | `-n/--limit` for human output, `--verbose`, `--json` |
| `repos graph stats` | `--json` |

## Database and completion utilities

| Command | Options and behavior |
|---|---|
| `repos backup [path]` | Copy the selected SQLite database; default filename is date-based; `--json` |
| `repos restore <path>` | Prompt before overwriting unless `--force`; `--json` |
| `repos completions bash` | Generate Bash completion; Bash is the default completions subcommand |
| `repos completions zsh` | Generate Zsh completion |
| `repos completions fish` | Generate Fish completion |

## Event commands

The pinned `@hasna/events` integration adds these command groups to `repos`.
Its default store is `~/.hasna/events`.

| Command | Options |
|---|---|
| `repos events emit <type>` | `--source`, `--subject`, `--severity`, `--message`, `--dedupe-key`, `--data`, `--metadata`, `--no-deliver`, `--no-dedupe`, `-j/--json` |
| `repos events list` | `--source`, `--type`, `--limit`, `-j/--json` |
| `repos events replay` | `--id`, `--source`, `--type`, `--dry-run`, `-j/--json` |
| `repos webhooks add <target>` | Required `--id`; `--transport`, `--name`, `--type`, `--source`, `--subject`, `--severity`, `--secret`, repeatable `--header`, repeatable `--arg`, `--timeout-ms`, `--retry-attempts`, `--retry-backoff-ms`, repeatable `--redact`, `--disabled`, `-j/--json` |
| `repos webhooks list` | `-j/--json` |
| `repos webhooks remove <id>` | `-j/--json` |
| `repos webhooks test <id>` | `--type`, `--subject`, `--message`, `--data`, `-j/--json` |

## Standalone executable help

`repos-mcp` and `repos-serve` are documented in [MCP server](mcp.md) and
[HTTP API and dashboard](http-api.md).

`repos-verify-release` requires:

```text
--expected-commit <object-id>
--expected-tree <object-id>
--expected-package-sha256 <sha256>
--expected-executable-sha256 <sha256>
--package <path>
--executable <path>
```

It verifies the package digest before reading its embedded provenance, then
binds the reviewed commit/tree and the exact packaged and selected executable
bytes. Success prints a versioned JSON receipt; any mismatch exits non-zero.
