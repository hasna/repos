# Changelog

## Unreleased

Adds fail-closed checkout health for repository lookups and a registry-wide health command
(#33).

- `repos repo` / `repos show` / `repos inspect` still print a matched registry row, but now
  exit 1 when its path is not a usable git checkout. `--allow-unusable-checkout` preserves
  the metadata-only workflow when a successful exit is required.
- `repos registry health` counts usable and unusable registry rows, groups failures by
  checkout state, and can list or filter the affected rows.

Adds the worktree lifecycle verbs — `repos worktree add | list | remove | adopt | release`.

- **The path is computed, never supplied.** `add` takes a repo and a name and places the
  worktree at `~/.hasna/repos/worktrees/<repo-name>/<worktree-name>`. There is no `--path`,
  `--dir` or `--root` option, and a name must be a single path segment, so a crafted
  `--name ../../elsewhere` is refused before anything reaches the filesystem. The layout has
  been ratified for weeks and has not held: `worktree list` reconciled 1468 directories under
  that root on 2026-07-29, of which 303 sit flat at the root and 218 are buried under an extra
  segment.
- **Destructive verbs cannot be handed a path.** `remove` and `release` accept a lease id or
  `<repo>/<worktree>` and nothing else, so the destroy-then-create hazard (a helper that
  force-removed whatever path it was given) is unrepresentable rather than guarded. Containment
  is re-checked after symlink resolution.
- **Ref arguments cannot smuggle a git option.** `--base` and `--branch` are validated before
  they reach git: `git fetch origin <ref>` parses options anywhere on the line, and
  `--upload-pack=<cmd>` names a program to execute. Measured before the guard existed, an `add`
  with such a `--base` returned success and ran the command. `check-ref-format` alone does not
  catch it, because it is handed `refs/heads/<value>` and `refs/heads/--upload-pack=x` is
  well-formed; the leading-dash refusal and charset do, with `--` separators as a second gate.
- **Bases are pinned from origin, fail-closed.** A repo with an origin must fetch; the failure
  is `BASE_REF_UNRESOLVABLE` rather than a silent branch off a stale local HEAD. A repo with no
  remote resolves locally and reports `base.source: "local"`.
- **Re-adding returns the existing lease.** An occupied path is refused with its contents
  intact; nothing is removed to make room.
- **Backup on reap.** `--discard-changes` archives the diff, the porcelain status, the
  untracked-file list, and a `git bundle` of the branch when commits exist on no remote, under
  `<root>/.evidence/`.
- **A broken parent checkout is refused** with `PARENT_CHECKOUT_BROKEN` — the live shape being
  a `.git` holding only `hooks/` and `worktrees/`.
- **The lease table is now created by a migration.** `worktree_leases` existed on stations
  from an out-of-tree build and had never been created by any shipped migration, so a fresh
  install did not have it while an old station silently did. Migration 14 states the schema in
  the tree and fails loudly on a divergent pre-existing shape.
- **These verbs read no credential of their own.** Nothing touches `gh`, a token environment
  variable, or a vault — asserted in a child process built from an empty environment, with
  positive controls proving the probes can detect a credential when one is present. The limit
  is stated and measured rather than glossed: `add` fetches the base through the parent
  checkout's own remote, so a private https or keyless ssh remote still needs an ambient git
  credential and fails closed with `BASE_REF_UNRESOLVABLE` without one. A test points the same
  code at a local endpoint returning 401 and asserts that failure.
- **The teardown archive verifies its own output.** `--discard-changes` bundles `HEAD`, not the
  lease's claimed branch — a detached HEAD (rebase, bisect) puts commits where that branch does
  not point — and then checks the bundle actually contains `HEAD`, writing an `INCOMPLETE.txt`
  rather than reporting a successful archive it did not take.

Adds the repository plane — `repos create | clone | archive` — with the credential behind
the CLI (R5, owner directive 2026-07-28).

- **The caller's token is never the operation's authority.** `GH_TOKEN`, `GITHUB_TOKEN` and
  their enterprise forms are scrubbed from every child the CLI spawns, and so are the store
  redirections `GH_CONFIG_DIR` and `XDG_CONFIG_HOME` — pointing `gh` at a caller-written
  `hosts.yml` substituted the identity performing the mutation while the result still
  reported `credential_source: "gh-store"`, measured against a private repository before it
  was closed. `HOME` is kept, because `$HOME/.config/gh` is the station's own store. The CLI
  resolves its credential from station config (`github.credentialCommand`, an argv whose
  stdout is the token) or, absent one, from the station `gh`'s credential store. Asserted
  against the real CLI with positive controls: the same probe that finds no caller token in
  the child finds the configured command's token when one is supposed to be there.
- **Fail closed, typed.** A configured credential command that fails, is malformed, or prints
  nothing is `CREDENTIAL_UNAVAILABLE` raised before any child is spawned — never a silent
  fall-through to the gh store. An unauthenticated gh maps to the same code, so automation can
  tell a credential-plane outage from an operation failure.
- **The resolved token never reaches the caller.** Not in results, and redacted from error
  diagnostics even when a hostile child echoes it back on stderr — tested with the echo.
- **No delete verb, by construction.** Archive (reversible with `--restore`) is the terminal
  state the CLI can express, so no delete-capable credential ever needs to exist behind these
  verbs. `archive` accepts a registry name (exact-match semantics, ambiguity refuses) or an
  explicit `<org>/<name>`.
- **Acquire-and-register is one contract.** `clone` and `create --dir` refuse an occupied
  destination with its contents intact — the destroy-then-create hazard stays unrepresentable
  on this plane too — register the checkout in the index, and fail with
  `CLONE_REGISTER_FAILED` when registration does not land, instead of leaving disk and
  registry to drift apart silently.
- **Argument grammar as the injection guard.** `<org>/<name>` must start alphanumeric in both
  segments; a leading dash (gh flag injection), a `.`/`..` segment, whitespace, or extra
  segments are unrepresentable in the verbs' argv.
- **Existence preflight is fail-closed.** `create` treats anything other than a clean 404 as a
  stop — an auth failure or outage never reads as "free to create".
- The broker (design Phase 2 — hosted mint of short-lived repo-scoped tokens) slots in as one
  more source behind the same choke point; verbs and refusals do not change.

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
