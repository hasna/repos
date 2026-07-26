# Changelog

## 0.1.36

Makes `repos prs` usable as a source of truth for pull requests (#26).

- **Terminal state is reconciled.** `sync-github` only ever inserted and updated what it
  fetched, so a PR merged or closed upstream stayed `open` in the index forever. A full
  successful sync still reported 440 open PRs for the hasna org against 10 live on GitHub.
  Rows still marked open but absent from the live open set are now re-queried and driven to
  their real terminal state; a number GitHub will not resolve is left untouched rather than
  guessed. `--no-reconcile` opts out.
- **One row per pull request, not one per checkout.** The same repository is indexed once
  per local checkout — `github.com/hasna/codewith` maps to 23 repo records — and each held
  its own copy of every PR. `UNIQUE(repo_id, number)` was never the missing piece; `repo_id`
  simply is not the identity of a pull request. Listings de-duplicate on the PR's URL,
  preferring the correctly attributed copy, then the freshest, then a terminal state, then a
  primary clone over a worktree. `--duplicates` restores the per-checkout view.
- **Sync fans out by remote, not by directory.** One fetch updates every checkout of a
  repository, so unvisited checkouts no longer keep stale rows alive, and reconciliation
  resolves the union of their stale sets in a single pass.
- **Merge-gate fields**: `head_sha`, `mergeable`, `merge_state_status`, `ci_state`,
  `is_draft`, `review_decision`, sourced from the GraphQL `repository.pullRequests`
  connection. `mergeStateStatus` needs a preview media type and degrades gracefully if it is
  refused.
- **`--org` / `--repo-name`** filters, plus `org` and `repo` on every row, resolved from
  each PR's own URL rather than the repo record it happens to be attached to.
- **Explicit truncation.** `repos --json` and `prs --json` report the true total on stderr
  instead of silently stopping at the page size.
- **Deterministic targeting.** `--remote host/org/name` on `repo`/`show`/`inspect`/`cd`/
  `open` and `--exact` on `cd`/`open`. The fuzzy default resolves `todos` to whichever of
  `open-todos` and `platform-todos` it reaches first.
- **The scanner no longer erases remote identities.** A failed `git remote get-url origin`
  read used to overwrite a known-good `remote_url` with NULL; supplying a remote that fails
  sanitization still clears it. `git -C` also searches upward, so a directory with a gutted
  `.git` answered with its *ancestor's* remote — that read is now rejected unless git
  considers the path the top of its working tree.
- **`open-repos.pr-queue.v1`** shares the de-duplicated listing, so the queue no longer
  spends its `limit` on duplicate copies, and task fingerprints name the repository that
  owns the pull request. Adds `repo.github_repo` / `repo.github_org`; `repo.name`, `org` and
  `path` keep describing the local checkout.
- **Migration 12** adds the new columns, backfills `gh_owner`/`gh_repo`, restores
  `remote_url` from the `remotes` table, and rebuilds the FTS index, which
  `INSERT OR REPLACE` had left with roughly seven orphaned entries per live row.

## 0.1.35

- Publish the merged PR-drain line to npm (registry was stuck at 0.1.33). Includes all
  changes merged into `main` after the 0.1.33 release, notably:
  - feat: compact CLI and MCP output defaults (#2)
  - Branch adjudication / relocation hardening series (#15–#22): fail-closed primary repo
    relocation, divergent branch preservation, abbreviated relocation SHA resolution, fsck
    timeout fix for large repos, release-gate and Git-evidence hardening.
  - fix(pr-queue): pagination + stale-ref skip, seed pr_author/pr_state + State/Author in
    seed body, repair npm publish auth (NPM_CONFIG_TOKEN) (#8–#11, #13).
  - feat: release-pipeline parity check on the release_health surface (#14).
