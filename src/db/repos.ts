import { getDb } from "./database.js";
import type {
  Repo,
  Commit,
  Branch,
  Tag,
  Remote,
  PullRequest,
  PullRequestRecord,
  SearchResult,
  RepoStats,
  ListOptions,
} from "../types/index.js";
import { sanitizeRemoteIdentity } from "../lib/remote-identity.js";
import { resolvePullRequestOrigin } from "../lib/pr-identity.js";
import { classifyCheckout } from "../lib/checkout-health.js";

// ── Repos ──

export class AmbiguousRepoNameError extends Error {
  constructor(public readonly repoName: string) {
    super(`Multiple repos have the exact name '${repoName}'; use an explicit repo ID or path`);
    this.name = "AmbiguousRepoNameError";
  }
}

export function sanitizeRepoForOutput(repo: Repo): Repo {
  return { ...repo, remote_url: sanitizeRemoteIdentity(repo.remote_url) };
}

export function sanitizeRemoteForOutput(remote: Remote): Remote | null {
  const url = sanitizeRemoteIdentity(remote.url);
  if (!url) return null;
  return {
    ...remote,
    url,
    fetch_url: sanitizeRemoteIdentity(remote.fetch_url),
  };
}

export function listRepos(opts: ListOptions & { org?: string; query?: string } = {}): Repo[] {
  const db = getDb();
  const { limit = 50, offset = 0, org, query } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (org) {
    where.push("org = ?");
    params.push(org);
  }
  if (query) {
    where.push("(name LIKE ? OR description LIKE ? OR remote_url LIKE ?)");
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return (db
    .query(`SELECT * FROM repos ${whereClause} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
    .all(...params) as Repo[]).map(sanitizeRepoForOutput);
}

/**
 * Total repos matching a filter, ignoring limit/offset. `repos --json` used to
 * stop at its default page size with nothing in the output to say so, which
 * makes a truncated page indistinguishable from a complete one.
 */
export function countRepos(opts: { org?: string; query?: string } = {}): number {
  const db = getDb();
  const params: any[] = [];
  const where: string[] = [];
  if (opts.org) { where.push("org = ?"); params.push(opts.org); }
  if (opts.query) {
    where.push("(name LIKE ? OR description LIKE ? OR remote_url LIKE ?)");
    params.push(`%${opts.query}%`, `%${opts.query}%`, `%${opts.query}%`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return (db.query(`SELECT COUNT(*) AS c FROM repos ${whereClause}`).get(...params) as { c: number }).c;
}

export function listAllRepos(
  opts: Omit<ListOptions, "limit" | "offset"> & { org?: string; query?: string } = {},
  pageSize = 500,
): Repo[] {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("repository page size must be a positive integer");
  }
  const db = getDb();
  const repos: Repo[] = [];
  let lastId = 0;
  while (true) {
    const params: Array<string | number> = [lastId];
    const where = ["id > ?"];
    if (opts.org) {
      where.push("org = ?");
      params.push(opts.org);
    }
    if (opts.query) {
      where.push("(name LIKE ? OR description LIKE ? OR remote_url LIKE ?)");
      const query = `%${opts.query}%`;
      params.push(query, query, query);
    }
    params.push(pageSize);
    const page = (db
      .query(`SELECT * FROM repos WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`)
      .all(...params) as Repo[]).map(sanitizeRepoForOutput);
    repos.push(...page);
    if (page.length < pageSize) return repos;
    lastId = page[page.length - 1]!.id;
  }
}

/**
 * Resolve by row id (numeric) or exact path/name (string).
 *
 * The by-name branch used to match the `name` column with no regard for
 * whether the matching row was a derived checkout. A canonical checkout of
 * `github.com/hasna/loops` is indexed as `open-loops`, while a shallow,
 * single-commit `_factory_src/loops` scratch clone of the SAME remote is
 * indexed under the bare name `loops`. Those are two DIFFERENT `name` values,
 * so `getRepo("loops")` had exactly one exact match — the scratch clone — and
 * returned it: deterministic, unambiguous, and wrong. This is not the
 * tie-break `AmbiguousRepoNameError` exists for; it is a single match that
 * should never have been treated as authoritative.
 *
 * A derived checkout is therefore filtered out of the by-name candidate set
 * before deciding what to return:
 *   - one non-derived match remains → return it (the common case, and also
 *     what now happens when a derived row happens to share an exact `name`
 *     with a real checkout — previously an accidental `AmbiguousRepoNameError`
 *     for a "conflict" that was never real);
 *   - more than one non-derived match remains → genuinely ambiguous, throw as
 *     before;
 *   - none remains (every exact-name match was derived) → refuse (return
 *     null) rather than silently handing back scratch-clone data. Silently
 *     substituting a canonical row under a DIFFERENT name would be fuzzy
 *     matching wearing an exact-match's clothes, which this lookup's whole
 *     contract (see `getRepoByRemote`'s docstring) exists to avoid. The
 *     caller's existing "not found" + fuzzy-suggestion path is where a hint
 *     toward the canonical name belongs — see `fuzzyFindRepo` in lib/utils.ts,
 *     which excludes derived checkouts from its own suggestions for the same
 *     reason.
 */
export function getRepo(idOrPath: string | number): Repo | null {
  const db = getDb();
  if (typeof idOrPath === "number") {
    const row = db.query("SELECT * FROM repos WHERE id = ?").get(idOrPath) as Repo | null;
    return row ? sanitizeRepoForOutput(row) : null;
  }
  const byPath = db.query("SELECT * FROM repos WHERE path = ?").get(idOrPath) as Repo | null;
  if (byPath) return sanitizeRepoForOutput(byPath);

  const primary = db
    .query(`SELECT * FROM repos WHERE name = ? AND ${nonDerivedCheckoutSql("path")} ORDER BY id LIMIT 2`)
    .all(idOrPath) as Repo[];
  if (primary.length > 1) {
    throw new AmbiguousRepoNameError(idOrPath);
  }
  return primary[0] ? sanitizeRepoForOutput(primary[0]) : null;
}

export class AmbiguousRemoteError extends Error {
  constructor(public readonly remote: string, public readonly paths: string[]) {
    super(
      `Remote '${remote}' is checked out ${paths.length} times; pass an explicit path:\n  ${paths.join("\n  ")}`
    );
    this.name = "AmbiguousRemoteError";
  }
}

/**
 * Resolve a repo by its GitHub remote identity — the only deterministic way to
 * name a repository.
 *
 * `name` is the local directory name, which routinely differs from the GitHub
 * repository name (`github.com/hasna/emails` is checked out as `open-emails`),
 * and the fuzzy `cd`-style lookup happily resolves `todos` to whichever of
 * `open-todos`, `platform-todos` or `hasnastudio/platform-todos` it reaches
 * first. Automation needs a lookup that either matches exactly or fails.
 *
 * Accepts `github.com/org/name`, `org/name`, or any supported remote URL form.
 * Returns null when nothing matches — including when every indexed checkout of
 * the remote is a foreign scratch clone (see `FOREIGN_COPY_SEGMENTS`) — and
 * throws when a single remote has multiple local checkouts and no primary can
 * be distinguished.
 */
export function getRepoByRemote(
  remote: string,
  opts: { allowAmbiguous?: boolean; isUsableCheckout?: (path: string) => boolean } = {},
): Repo | null {
  const db = getDb();
  const normalized = sanitizeRemoteIdentity(remote)
    ?? sanitizeRemoteIdentity(`github.com/${remote.replace(/^\/+/, "")}`);
  if (!normalized) return null;

  const rows = (db
    .query("SELECT * FROM repos WHERE remote_url = ? COLLATE NOCASE ORDER BY id ASC")
    .all(normalized) as Repo[]).map(sanitizeRepoForOutput);
  if (rows.length === 0) return null;

  // A FOREIGN COPY — a `_factory_src` scratch clone or a `/dev/shm` build copy —
  // is dropped here, before every other rule, because it is a separate
  // repository that merely shares this remote and can be arbitrarily stale.
  // Dropping it FIRST is the whole fix for todos c0ac7e9b: previously the
  // usability filter below removed a hollow canonical checkout, left the mirror
  // as the sole candidate, and the single-candidate early return handed it back
  // at exit code 0 with `checkout_health: usable` — a two-and-a-half-month-old
  // tree reported as the answer. Note this cannot be fixed by moving the
  // derived-path filter further down instead: a worktree is derived too, and a
  // live worktree winning over a hollow primary is deliberate.
  const own = rows.filter((row) => !isForeignCheckoutPath(row.path));
  // Every checkout of the remote is a scratch clone. Refuse, as the by-name
  // lookup in `getRepo` already does, rather than hand back scratch data under
  // an exact-match contract; the caller's not-found path is a message it can
  // act on, and `listReposByRemote` still enumerates the rows. Measured
  // read-only on the station01 registry 2026-08-07: 60 foreign rows across 60
  // of 283 remotes, and ZERO remotes made up only of them.
  if (own.length === 0) return null;
  if (opts.allowAmbiguous) return own[0]!;

  // A row whose path git cannot open is never the right answer while a working
  // checkout of the same remote exists. On this machine 1056 of 1581 rows are in
  // that state, and several remotes have both a gutted primary and a live
  // worktree — resolving to the gutted one is what sent agents off to re-clone by
  // hand. Narrow to what actually works FIRST, before preferring a primary
  // clone over a derived copy: a live worktree beats a hollow primary.
  const isUsable = opts.isUsableCheckout ?? ((path: string) => classifyCheckout(path).usable);
  const usable = own.filter((row) => isUsable(row.path));
  // When nothing is usable, keep answering from the full set: the caller still
  // needs the row to be told what is wrong with it, and the CLI reports the
  // health verdict rather than pretending the path works.
  const candidates = usable.length > 0 ? usable : own;
  if (candidates.length === 1) return candidates[0]!;

  // A worktree or throwaway build copy is never the answer when a real checkout
  // exists, so narrow before declaring the remote ambiguous.
  const primary = candidates.filter((row) => !isDerivedCheckoutPath(row.path));
  if (primary.length === 1) return primary[0]!;

  throw new AmbiguousRemoteError(normalized, candidates.map((row) => row.path));
}

/**
 * Path markers that identify a copy of a checkout rather than the checkout
 * itself. Kept as data so the TypeScript predicate and the SQL rank term below
 * cannot drift apart into two different definitions of "derived".
 *
 * `_factory_src` is a shallow, single-commit factory scratch clone (see
 * `getRepo()` below) — never a checkout anything should be routed to, and
 * never the primary copy of a remote when a real checkout also exists.
 */
const DERIVED_CHECKOUT_SEGMENTS = ["worktrees", ".worktrees", "_factory_src"] as const;
const DERIVED_CHECKOUT_PREFIXES = ["/dev/shm/"] as const;

/**
 * The subset of the markers above that identifies a SEPARATE CLONE of the
 * remote rather than another view of the same clone.
 *
 * "Derived" covers two things that behave nothing alike when a caller asks
 * "where is this remote checked out":
 *   - a WORKTREE shares the canonical checkout's object store, so its HEAD
 *     cannot silently drift away from the repository it belongs to. A live
 *     worktree beating a hollow primary is correct, and `getRepoByRemote`
 *     depends on it.
 *   - a `_factory_src` factory scratch clone or a `/dev/shm` build copy is its
 *     OWN repository with its OWN object store and its own HEAD, which goes
 *     stale the moment nothing refreshes it — measured at two and a half months
 *     on `_factory_src/iapp-takumi` (todos c0ac7e9b). It is never the answer,
 *     not even when it is the only row git can open, because "the only copy I
 *     can read" and "the copy you asked for" are different claims.
 *
 * Declared as a subset of `DERIVED_CHECKOUT_SEGMENTS` so that renaming a marker
 * there fails to typecheck here rather than silently emptying this predicate.
 */
const FOREIGN_COPY_SEGMENTS: readonly (typeof DERIVED_CHECKOUT_SEGMENTS)[number][] = ["_factory_src"];
const FOREIGN_COPY_PREFIXES: readonly (typeof DERIVED_CHECKOUT_PREFIXES)[number][] = ["/dev/shm/"];

/**
 * SQLite's LIKE is ASCII case-insensitive and treats `%` and `_` as wildcards.
 * Every marker embedded in a LIKE pattern below is run through
 * `escapeLikeMarker()` first (with a matching `ESCAPE '\'` clause), so a
 * literal underscore in a marker — `_factory_src`'s leading character — no
 * longer needs to be rejected here to stay safe. What still cannot be made
 * safe by escaping is a marker containing `%` (nothing in this module escapes
 * a literal percent sign it did not put there itself) or anything outside
 * plain ASCII, so those remain rejected at load.
 */
export function assertLikeSafeMarker(marker: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(marker)) {
    throw new Error(`derived-checkout marker '${marker}' must be ASCII and free of LIKE metacharacters`);
  }
  return marker;
}

for (const marker of [...DERIVED_CHECKOUT_SEGMENTS, ...DERIVED_CHECKOUT_PREFIXES]) {
  assertLikeSafeMarker(marker);
}

/**
 * A path matches when a segment marker appears as a whole path segment, or a
 * prefix marker starts the path. Shared by both predicates below so the two
 * cannot drift into different definitions of the same match.
 */
function matchesCheckoutMarkers(
  path: string,
  segments: readonly string[],
  prefixes: readonly string[],
): boolean {
  const lower = path.toLowerCase();
  const hasSegment = segments.some((segment) => {
    const escaped = segment.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|/)${escaped}/`).test(lower);
  });
  return hasSegment || prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** Paths that are copies of a checkout rather than the checkout itself. */
export function isDerivedCheckoutPath(path: string): boolean {
  return matchesCheckoutMarkers(path, DERIVED_CHECKOUT_SEGMENTS, DERIVED_CHECKOUT_PREFIXES);
}

/**
 * Paths that are a SEPARATE clone of the remote — a strict subset of
 * `isDerivedCheckoutPath`. See `FOREIGN_COPY_SEGMENTS` for why the two differ.
 */
export function isForeignCheckoutPath(path: string): boolean {
  return matchesCheckoutMarkers(path, FOREIGN_COPY_SEGMENTS, FOREIGN_COPY_PREFIXES);
}

/**
 * Escape a marker for safe embedding in a SQL `LIKE ... ESCAPE '\'` pattern
 * built by string interpolation (these markers are compile-time constants,
 * never user input, so this is about LIKE semantics, not injection). SQLite's
 * LIKE treats `%` and `_` as wildcards; this is what lets `assertLikeSafeMarker`
 * accept `_factory_src` instead of rejecting every marker with an underscore.
 * `PR_RANK_ORDER` further below already relies on the identical convention for
 * `owner_remote`.
 */
function escapeLikeMarker(marker: string): string {
  return marker.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * The raw LIKE conditions that classify `column` as a derived checkout.
 * Shared by `derivedCheckoutRankSql` (rank a derived copy last) and
 * `nonDerivedCheckoutSql` (exclude a derived copy outright) so the two never
 * drift into different definitions of "derived".
 */
function derivedCheckoutTests(column: string): string[] {
  return [
    ...DERIVED_CHECKOUT_SEGMENTS.flatMap((segment) => {
      const escaped = escapeLikeMarker(segment);
      return [
        `${column} LIKE '%/${escaped}/%' ESCAPE '\\'`,
        `${column} LIKE '${escaped}/%' ESCAPE '\\'`,
      ];
    }),
    ...DERIVED_CHECKOUT_PREFIXES.map((prefix) => `${column} LIKE '${escapeLikeMarker(prefix)}%' ESCAPE '\\'`),
  ];
}

/**
 * SQL ordering term that sorts primary clones (0) ahead of derived copies (1).
 * Kept in lockstep with isDerivedCheckoutPath by construction: same markers,
 * same case-insensitive comparison, metacharacters rejected at load.
 */
function derivedCheckoutRankSql(column: string): string {
  return `CASE WHEN ${column} IS NOT NULL AND (${derivedCheckoutTests(column).join(" OR ")}) THEN 1 ELSE 0 END`;
}

/**
 * SQL WHERE-clause fragment that is true only for rows that are NOT a derived
 * checkout — the exclusion counterpart of `derivedCheckoutRankSql`, for
 * callers that must never SUGGEST a derived checkout rather than merely rank
 * it last. `fuzzyFindRepo` (lib/utils.ts) is the reason this exists: pointing
 * an agent at `_factory_src/loops` after `getRepo()` correctly refused to
 * resolve `loops` there directly would undo the refusal one step later.
 *
 * SCOPE — this excludes FOUR markers, not just the factory mirror that
 * motivated it, because it is built from `derivedCheckoutTests`:
 *   - path SEGMENTS: `worktrees`, `.worktrees`, `_factory_src`
 *   - path PREFIX:   `/dev/shm/`
 * A row is derived when a marker appears as a whole path segment (or, for the
 * prefix, at the start of the path) — `…/my-worktrees` and `…/worktrees-scratch`
 * are NOT derived, and the `_` in `_factory_src` is LIKE-escaped so it matches
 * literally rather than as a single-character wildcard. A NULL path counts as
 * non-derived, which is what lets rows with no path survive the filter.
 *
 * POPULATION EFFECT, so that "why does this name resolve to nothing" has a
 * pointer (measured read-only on the station01 registry, 2026-08-04: 1,968
 * rows / 1,882 distinct names): 1,520 of those 1,882 names have NO surviving
 * row and therefore resolve to nothing here rather than to a derived row. That
 * headline is dominated by ephemera — 1,475 of the 1,520 are loop/task
 * worktree LEAF DIRECTORY names (task ids and uuids under `…/worktrees/<repo>/`)
 * that were never a lookup target. The operator-visible remainder is 45 names
 * whose only checkout is a `_factory_src` mirror, which is precisely the case
 * this exclusion exists to refuse (todos c357a1f3). All 45 remain reachable
 * through a non-derived checkout of the same remote — measured, 0 names lose
 * their last non-derived row — so the exclusion hides no repository, it only
 * refuses to answer with a scratch copy.
 *
 * The four markers above are drift-guarded by a test in
 * `pull-request-surface.test.ts` that fails if a marker is added to either
 * constant without being named here.
 */
export function nonDerivedCheckoutSql(column: string): string {
  return `(${column} IS NULL OR NOT (${derivedCheckoutTests(column).join(" OR ")}))`;
}

/** Every local checkout of a remote, in index order. */
export function listReposByRemote(remote: string): Repo[] {
  const db = getDb();
  const normalized = sanitizeRemoteIdentity(remote)
    ?? sanitizeRemoteIdentity(`github.com/${remote.replace(/^\/+/, "")}`);
  if (!normalized) return [];
  return (db
    .query("SELECT * FROM repos WHERE remote_url = ? COLLATE NOCASE ORDER BY id ASC")
    .all(normalized) as Repo[]).map(sanitizeRepoForOutput);
}

export function upsertRepo(repo: Partial<Repo> & { path: string; name: string }): Repo {
  const db = getDb();
  const existing = db.query("SELECT id FROM repos WHERE path = ?").get(repo.path) as { id: number } | null;
  // Supplying `remote_url` is a claim about the repository's current remote, so
  // a value that fails sanitization still clears the stored identity rather
  // than leaving a contaminated or superseded one behind. Callers that merely
  // failed to READ a remote must omit the key instead of passing null — see
  // readRemoteIdentity in lib/scanner.ts.
  const hasRemote = Object.prototype.hasOwnProperty.call(repo, "remote_url");
  const safeRemote = hasRemote ? sanitizeRemoteIdentity(repo.remote_url) : null;

  if (existing) {
    db.query(`UPDATE repos SET
      name = coalesce(?, name),
      org = coalesce(?, org),
      remote_url = CASE WHEN ? THEN ? ELSE remote_url END,
      default_branch = coalesce(?, default_branch),
      description = coalesce(?, description),
      last_scanned = coalesce(?, last_scanned),
      commit_count = coalesce(?, commit_count),
      branch_count = coalesce(?, branch_count),
      tag_count = coalesce(?, tag_count),
      updated_at = datetime('now')
    WHERE path = ?`).run(
      repo.name, repo.org ?? null, hasRemote ? 1 : 0, safeRemote,
      repo.default_branch ?? null, repo.description ?? null,
      repo.last_scanned ?? null, repo.commit_count ?? null,
      repo.branch_count ?? null, repo.tag_count ?? null,
      repo.path
    );
    return sanitizeRepoForOutput(db.query("SELECT * FROM repos WHERE id = ?").get(existing.id) as Repo);
  }

  db.query(`INSERT INTO repos (path, name, org, remote_url, default_branch, description, last_scanned, commit_count, branch_count, tag_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    repo.path, repo.name, repo.org ?? null, safeRemote,
    repo.default_branch ?? "main", repo.description ?? null,
    repo.last_scanned ?? null, repo.commit_count ?? 0,
    repo.branch_count ?? 0, repo.tag_count ?? 0
  );
  return sanitizeRepoForOutput(db.query("SELECT * FROM repos WHERE path = ?").get(repo.path) as Repo);
}

export function deleteRepo(id: number): boolean {
  const db = getDb();
  const result = db.query("DELETE FROM repos WHERE id = ?").run(id);
  return result.changes > 0;
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

export function searchRepos(query: string, limit = 20): Repo[] {
  const db = getDb();
  const ids = db
    .query("SELECT rowid FROM fts_repos WHERE fts_repos MATCH ? LIMIT ?")
    .all(buildFtsQuery(query), limit) as { rowid: number }[];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (db.query(`SELECT * FROM repos WHERE id IN (${placeholders})`).all(...ids.map((r) => r.rowid)) as Repo[])
    .map(sanitizeRepoForOutput);
}

// ── Commits ──

export function listCommits(
  opts: ListOptions & { repo_id?: number; author?: string; since?: string; until?: string } = {}
): Commit[] {
  const db = getDb();
  const { limit = 50, offset = 0, repo_id, author, since, until } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (repo_id) { where.push("repo_id = ?"); params.push(repo_id); }
  if (author) { where.push("(author_email LIKE ? OR author_name LIKE ?)"); params.push(`%${author}%`, `%${author}%`); }
  if (since) { where.push("date >= ?"); params.push(since); }
  if (until) { where.push("date <= ?"); params.push(until); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.query(`SELECT * FROM commits ${whereClause} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...params) as Commit[];
}

export function bulkInsertCommits(commits: Array<Omit<Commit, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR IGNORE INTO commits (repo_id, sha, author_name, author_email, date, message, files_changed, insertions, deletions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const c of commits) {
      const result = stmt.run(c.repo_id, c.sha, c.author_name, c.author_email, c.date, c.message, c.files_changed, c.insertions, c.deletions);
      if (result.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
}

export function searchCommits(query: string, limit = 20): Array<Commit & { repo_name: string; repo_path: string }> {
  const db = getDb();
  return db.query(`
    SELECT c.*, r.name as repo_name, r.path as repo_path
    FROM fts_commits fc
    JOIN commits c ON c.id = fc.rowid
    JOIN repos r ON r.id = c.repo_id
    WHERE fts_commits MATCH ?
    ORDER BY c.date DESC
    LIMIT ?
  `).all(buildFtsQuery(query), limit) as Array<Commit & { repo_name: string; repo_path: string }>;
}

// ── Branches ──

export function listBranches(opts: ListOptions & { repo_id?: number; is_remote?: boolean } = {}): Branch[] {
  const db = getDb();
  const { limit = 100, offset = 0, repo_id, is_remote } = opts;
  const params: any[] = [];
  const where: string[] = [];

  if (repo_id) { where.push("repo_id = ?"); params.push(repo_id); }
  if (is_remote !== undefined) { where.push("is_remote = ?"); params.push(is_remote ? 1 : 0); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.query(`SELECT * FROM branches ${whereClause} ORDER BY last_commit_date DESC NULLS LAST LIMIT ? OFFSET ?`).all(...params) as Branch[];
}

export function bulkInsertBranches(branches: Array<Omit<Branch, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO branches (repo_id, name, is_remote, last_commit_sha, last_commit_date, ahead, behind)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const b of branches) {
      stmt.run(b.repo_id, b.name, b.is_remote ? 1 : 0, b.last_commit_sha, b.last_commit_date, b.ahead, b.behind);
      count++;
    }
  });
  tx();
  return count;
}

export function replaceBranches(
  repoId: number,
  branches: Array<Omit<Branch, "id" | "repo_id">>,
): number {
  const db = getDb();
  const remove = db.query("DELETE FROM branches WHERE repo_id = ?");
  const insert = db.query(`INSERT INTO branches
    (repo_id, name, is_remote, last_commit_sha, last_commit_date, ahead, behind)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    remove.run(repoId);
    for (const branch of branches) {
      insert.run(
        repoId,
        branch.name,
        branch.is_remote ? 1 : 0,
        branch.last_commit_sha,
        branch.last_commit_date,
        branch.ahead,
        branch.behind,
      );
    }
  });
  tx();
  return branches.length;
}

// ── Tags ──

export function listTags(opts: ListOptions & { repo_id?: number } = {}): Tag[] {
  const db = getDb();
  const { limit = 100, offset = 0, repo_id } = opts;
  if (repo_id) {
    return db.query("SELECT * FROM tags WHERE repo_id = ? ORDER BY date DESC NULLS LAST LIMIT ? OFFSET ?").all(repo_id, limit, offset) as Tag[];
  }
  return db.query("SELECT * FROM tags ORDER BY date DESC NULLS LAST LIMIT ? OFFSET ?").all(limit, offset) as Tag[];
}

export function bulkInsertTags(tags: Array<Omit<Tag, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO tags (repo_id, name, sha, date, message) VALUES (?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const t of tags) {
      stmt.run(t.repo_id, t.name, t.sha, t.date, t.message);
      count++;
    }
  });
  tx();
  return count;
}

// ── Remotes ──

export function listRemotes(repo_id: number): Remote[] {
  const db = getDb();
  return (db.query("SELECT * FROM remotes WHERE repo_id = ?").all(repo_id) as Remote[])
    .map(sanitizeRemoteForOutput)
    .filter((remote): remote is Remote => remote !== null);
}

export function bulkInsertRemotes(remotes: Array<Omit<Remote, "id">>): number {
  const db = getDb();
  const stmt = db.query(`INSERT OR REPLACE INTO remotes (repo_id, name, url, fetch_url) VALUES (?, ?, ?, ?)`);
  const remove = db.query("DELETE FROM remotes WHERE repo_id = ? AND name = ?");
  let count = 0;
  const tx = db.transaction(() => {
    for (const r of remotes) {
      const url = sanitizeRemoteIdentity(r.url);
      if (!url) {
        remove.run(r.repo_id, r.name);
        continue;
      }
      stmt.run(r.repo_id, r.name, url, sanitizeRemoteIdentity(r.fetch_url));
      count++;
    }
  });
  tx();
  return count;
}

// ── Pull Requests ──

export interface ListPullRequestOptions extends ListOptions {
  repo_id?: number;
  state?: string;
  author?: string;
  /** GitHub owner, resolved from each PR's own URL — not the local repo's org. */
  org?: string;
  /** GitHub repository name, resolved from each PR's own URL. */
  repo_name?: string;
  /**
   * Return one row per local checkout instead of one row per pull request.
   * Off by default: a repository checked out N times otherwise reports every
   * one of its pull requests N times.
   */
  duplicates?: boolean;
  /** Sort key: newest created (default) or most recently updated. */
  orderBy?: "created" | "updated";
}

/**
 * Rank rows that describe the same pull request so the most trustworthy copy
 * wins. Order of preference:
 *
 *   1. the row whose owning repo record's remote actually matches the PR URL —
 *      a PR attached to an unrelated repo record is a mis-attributed sync;
 *   2. the most recently updated row, because `updated_at` comes from GitHub
 *      and is the only field that tracks which copy saw reality last. This has
 *      to outrank state: a pull request can be REOPENED, so preferring a
 *      terminal state first would keep reporting a reopened PR as closed. The
 *      merge/close/create timestamps stand in when `updated_at` is missing, so
 *      a terminal row without one is not ranked as though it had no history;
 *   3. a terminal state over `open`, to break ties when copies share a
 *      timestamp — `open` is the value that goes stale when a copy stops being
 *      synced, whereas `merged`/`closed` carry a timestamp from GitHub. This
 *      MUST stay above the path preference: reconciliation writes
 *      `updated_at = COALESCE(?, updated_at)`, so a row whose GitHub
 *      `updatedAt` came back null flips state while keeping its old timestamp,
 *      leaving copies tied on the key above but disagreeing on state. Ranking
 *      the path first would resolve that disagreement differently depending on
 *      which copy happened to be a worktree;
 *   4. a primary clone over a worktree or throwaway build copy. The winning
 *      row's `path` is what downstream consumers route work to, and a sync
 *      writes every checkout of a remote in one pass, so copies normally agree
 *      on state and this is what actually decides. Without it the final id
 *      tiebreak systematically selected a worktree — pointing callers at
 *      another task's working directory;
 *   5. the LOWEST pull request row id.
 *
 *      This is `pull_requests.id` — the id of the PR ROW, not of the owning
 *      repo record. It therefore orders by which checkout first acquired this
 *      pull request, which turns out to be an accidental but real liveness
 *      signal: a repo record that stopped being synced never acquires an early
 *      row for a recent PR.
 *
 *      Two seemingly better signals were measured end-to-end against the live
 *      index (758 pull requests) and both are WORSE. Counting winners whose
 *      `path` no longer exists on disk: this rule 31, `last_scanned DESC` 38,
 *      `owner_id ASC` 43.
 *
 *      `last_scanned` looks like the right answer and is not, because it
 *      records when the scanner last VISITED a path, not whether that path
 *      still exists — a vanished checkout keeps the timestamp from its final
 *      successful visit. Live and dead rows are ~2.6 days apart with heavily
 *      overlapping distributions, and because the rules above resolve most
 *      comparisons first, this rule only fires on checkouts scanned in the same
 *      pass, where the timestamps differ by seconds of directory-walk order.
 *      One remote, hasnaxyz/iapp-wallets, has a dead checkout that beats its
 *      live one by 1.7 seconds.
 *
 *      None of these is a real fix. 273 of 524 remote-bearing repo records
 *      point at paths that no longer exist, and no ordering over a proxy can
 *      repair that — the index needs to record path existence directly, after
 *      which any tiebreak works. Measure end-to-end before changing this rule:
 *      evaluating a candidate tiebreak in isolation is misleading, because the
 *      rules above it decide most cases first.
 */
const PR_RANK_ORDER = `
  CASE WHEN url IS NOT NULL AND owner_remote IS NOT NULL
         AND url LIKE 'https://' || replace(replace(owner_remote, '\\', '\\\\'), '_', '\\_') || '/pull/%'
         ESCAPE '\\' THEN 0 ELSE 1 END,
  COALESCE(updated_at, merged_at, closed_at, created_at, '') DESC,
  CASE WHEN state = 'open' THEN 1 ELSE 0 END,
  ${derivedCheckoutRankSql("owner_path")},
  id ASC`;

/**
 * Partition on the PR's own URL, which is stable across every local checkout of
 * the repository. Rows with no URL cannot be matched to anything else, so they
 * partition on their own row id and always survive.
 */
const PR_IDENTITY = `CASE WHEN url IS NOT NULL AND url <> '' THEN lower(url) ELSE 'row:' || id END`;

function buildPullRequestQuery(opts: ListPullRequestOptions): { cte: string; params: any[]; stateFilter: string; stateParams: any[] } {
  const { repo_id, state, author, org, repo_name, duplicates } = opts;
  const params: any[] = [];
  const where: string[] = [];

  // Identity filters are properties of the pull request itself, so every row in
  // a de-duplication group shares them and they can be applied before ranking.
  if (repo_id) { where.push("p.repo_id = ?"); params.push(repo_id); }
  if (author) { where.push("p.author LIKE ?"); params.push(`%${author}%`); }
  if (org) { where.push("p.gh_owner = ? COLLATE NOCASE"); params.push(org); }
  if (repo_name) { where.push("p.gh_repo = ? COLLATE NOCASE"); params.push(repo_name); }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // The state filter must be applied AFTER de-duplication. Filtering first
  // would keep a stale `open` copy alive and discard the reconciled `merged`
  // row that supersedes it — the exact bug this surface had.
  const stateFilter = state ? "WHERE state = ?" : "";
  const stateParams = state ? [state] : [];

  const cte = duplicates
    ? `WITH candidate AS (
         SELECT p.*, r.remote_url AS owner_remote, r.org AS owner_org,
                r.name AS owner_name, r.path AS owner_path
         FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id
         ${whereClause}
       ), ranked AS (SELECT candidate.*, 1 AS rn FROM candidate)`
    : `WITH candidate AS (
         SELECT p.*, r.remote_url AS owner_remote, r.org AS owner_org,
                r.name AS owner_name, r.path AS owner_path
         FROM pull_requests p LEFT JOIN repos r ON r.id = p.repo_id
         ${whereClause}
       ), ranked AS (
         SELECT candidate.*,
           ROW_NUMBER() OVER (PARTITION BY ${PR_IDENTITY} ORDER BY ${PR_RANK_ORDER}) AS rn
         FROM candidate
       )`;

  return { cte, params, stateFilter, stateParams };
}

/**
 * Project a ranked row onto the public record shape.
 *
 * `org`/`repo` are read from the stored gh_owner/gh_repo columns and nothing
 * else. Falling back to the owning repo record here would print an org that
 * `--org` cannot match, so the tool would advertise a filter value that returns
 * nothing. The columns are kept authoritative at write time instead — see
 * bulkInsertPullRequests.
 */
function toPullRequestRecord(row: any): PullRequestRecord {
  const { owner_remote, owner_org, owner_name, owner_path, rn, gh_owner, gh_repo, ...pr } = row;
  return {
    ...(pr as PullRequest),
    is_draft: Boolean(row.is_draft),
    org: gh_owner ?? null,
    repo: gh_repo ?? null,
  };
}

export function listPullRequests(opts: ListPullRequestOptions = {}): PullRequestRecord[] {
  return listRankedPullRequests(opts).map(toPullRequestRecord);
}

/**
 * De-duplicated pull requests with their owning repo record attached.
 *
 * Exists so every PR surface — the CLI listing and the `pr-queue` producer that
 * automation consumes — shares one de-duplication implementation. A second,
 * hand-rolled JOIN is how the producer ended up returning the same pull request
 * once per local checkout.
 */
export function listPullRequestsWithRepo(opts: ListPullRequestOptions = {}): Array<PullRequestRecord & {
  repo_name: string;
  repo_org: string | null;
  repo_path: string;
  repo_remote_url: string | null;
}> {
  return listRankedPullRequests(opts).map((row) => ({
    ...toPullRequestRecord(row),
    repo_name: row.owner_name,
    repo_org: row.owner_org,
    repo_path: row.owner_path,
    repo_remote_url: row.owner_remote,
  }));
}

function listRankedPullRequests(opts: ListPullRequestOptions): any[] {
  const db = getDb();
  const { limit = 50, offset = 0, orderBy } = opts;
  const { cte, params, stateFilter, stateParams } = buildPullRequestQuery(opts);
  const order = orderBy === "updated"
    ? "COALESCE(updated_at, created_at) DESC, id DESC"
    : "created_at DESC, id DESC";

  return db
    .query(`${cte}
      SELECT * FROM (SELECT * FROM ranked WHERE rn = 1) ${stateFilter}
      ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, ...stateParams, limit, offset) as any[];
}

/**
 * Total pull requests matching a filter, ignoring limit/offset, so callers can
 * tell a full page from a truncated one instead of silently losing rows.
 */
export function countPullRequests(opts: ListPullRequestOptions = {}): number {
  const db = getDb();
  const { cte, params, stateFilter, stateParams } = buildPullRequestQuery(opts);
  const row = db
    .query(`${cte}
      SELECT COUNT(*) AS c FROM (SELECT * FROM ranked WHERE rn = 1) ${stateFilter}`)
    .get(...params, ...stateParams) as { c: number };
  return row.c;
}

/**
 * A pull request as supplied by a sync. Merge-gate fields are optional so that
 * callers written against the pre-0.1.36 shape keep compiling and their rows
 * simply carry null gate data.
 */
export type PullRequestInput =
  Omit<PullRequest, "id" | "head_sha" | "mergeable" | "merge_state_status" | "ci_state" | "is_draft" | "review_decision">
  & Partial<Pick<PullRequest, "head_sha" | "mergeable" | "merge_state_status" | "ci_state" | "is_draft" | "review_decision">>;

export function bulkInsertPullRequests(prs: PullRequestInput[]): number {
  const db = getDb();
  // Upsert rather than INSERT OR REPLACE: REPLACE deletes and re-inserts the
  // row, which changes its rowid and appends a duplicate entry to the
  // external-content FTS index on every sync.
  const stmt = db.query(`INSERT INTO pull_requests
    (repo_id, number, title, state, author, created_at, updated_at, merged_at, closed_at, url,
     base_branch, head_branch, additions, deletions, changed_files,
     head_sha, mergeable, merge_state_status, ci_state, is_draft, review_decision, gh_owner, gh_repo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title = excluded.title, state = excluded.state, author = excluded.author,
      created_at = excluded.created_at, updated_at = excluded.updated_at,
      merged_at = excluded.merged_at, closed_at = excluded.closed_at, url = excluded.url,
      base_branch = excluded.base_branch, head_branch = excluded.head_branch,
      additions = excluded.additions, deletions = excluded.deletions,
      changed_files = excluded.changed_files,
      head_sha = excluded.head_sha, mergeable = excluded.mergeable,
      merge_state_status = excluded.merge_state_status, ci_state = excluded.ci_state,
      is_draft = excluded.is_draft, review_decision = excluded.review_decision,
      gh_owner = excluded.gh_owner, gh_repo = excluded.gh_repo`);
  // Resolving a row with an unusable URL needs its owning repo's remote, so
  // look that up once per repo rather than once per pull request.
  const repoLookup = db.query("SELECT remote_url, org FROM repos WHERE id = ?");
  const repoCache = new Map<number, { remote_url: string | null; org: string | null }>();
  const repoFor = (id: number) => {
    let row = repoCache.get(id);
    if (!row) {
      row = (repoLookup.get(id) as { remote_url: string | null; org: string | null } | null)
        ?? { remote_url: null, org: null };
      repoCache.set(id, row);
    }
    return row;
  };

  let count = 0;
  const tx = db.transaction(() => {
    for (const pr of prs) {
      // Stored so that --org filters and the printed org are the same value.
      const owner = repoFor(pr.repo_id);
      const origin = resolvePullRequestOrigin(pr.url, owner.remote_url, owner.org);
      stmt.run(
        pr.repo_id, pr.number, pr.title, pr.state, pr.author, pr.created_at, pr.updated_at,
        pr.merged_at, pr.closed_at, pr.url, pr.base_branch, pr.head_branch,
        pr.additions, pr.deletions, pr.changed_files,
        pr.head_sha ?? null, pr.mergeable ?? null, pr.merge_state_status ?? null,
        pr.ci_state ?? null, pr.is_draft ? 1 : 0, pr.review_decision ?? null,
        origin.org, origin.repo,
      );
      count++;
    }
  });
  tx();
  return count;
}

/** Numbers of every pull request still recorded as open for a repo record. */
export function listOpenPullRequestNumbers(repo_id: number): number[] {
  const db = getDb();
  return (db
    .query("SELECT number FROM pull_requests WHERE repo_id = ? AND state = 'open' ORDER BY number")
    .all(repo_id) as Array<{ number: number }>).map((row) => row.number);
}

/** Stays well under SQLite's default 999-parameter ceiling. */
const SQL_VARIABLE_CHUNK = 500;

export interface PullRequestTerminalState {
  number: number;
  state: "closed" | "merged";
  merged_at?: string | null;
  closed_at?: string | null;
  updated_at?: string | null;
}

/**
 * Drive rows out of `open` once GitHub no longer reports them as open.
 *
 * Without this, a sync only ever inserts and updates what it saw, so a pull
 * request that was merged or closed upstream stays `open` in the index forever
 * and `--state open` grows without bound.
 */
export function applyPullRequestTerminalStates(repo_id: number, states: PullRequestTerminalState[]): number {
  const db = getDb();
  const stmt = db.query(`UPDATE pull_requests
    SET state = ?,
        merged_at = COALESCE(?, merged_at),
        closed_at = COALESCE(?, closed_at),
        updated_at = COALESCE(?, updated_at)
    WHERE repo_id = ? AND number = ? AND state = 'open'`);
  if (states.length === 0) return 0;

  // Which rows are still open is read in bulk, not once per number: the count
  // has to reflect rows this call actually transitioned, and the driver's own
  // change count is inflated by the writes the FTS trigger performs. Chunked so
  // the statement can never exceed SQLite's variable limit (999 by default).
  const stillOpen = new Set<number>();
  const numbers = states.map((entry) => entry.number);
  for (let i = 0; i < numbers.length; i += SQL_VARIABLE_CHUNK) {
    const chunk = numbers.slice(i, i + SQL_VARIABLE_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of db
      .query(`SELECT number FROM pull_requests WHERE repo_id = ? AND state = 'open' AND number IN (${placeholders})`)
      .all(repo_id, ...chunk) as Array<{ number: number }>) {
      stillOpen.add(row.number);
    }
  }

  let changed = 0;
  const tx = db.transaction(() => {
    for (const entry of states) {
      if (!stillOpen.has(entry.number)) continue;
      stmt.run(
        entry.state, entry.merged_at ?? null, entry.closed_at ?? null,
        entry.updated_at ?? null, repo_id, entry.number,
      );
      changed++;
    }
  });
  tx();
  return changed;
}

export function searchPullRequests(query: string, limit = 20): Array<PullRequest & { repo_name: string }> {
  const db = getDb();
  return db.query(`
    SELECT pr.*, r.name as repo_name
    FROM fts_prs fp
    JOIN pull_requests pr ON pr.id = fp.rowid
    JOIN repos r ON r.id = pr.repo_id
    WHERE fts_prs MATCH ?
    ORDER BY pr.created_at DESC
    LIMIT ?
  `).all(buildFtsQuery(query), limit) as Array<PullRequest & { repo_name: string }>;
}

// ── Unified Search ──

export function searchAll(query: string, limit = 20): SearchResult[] {
  const results: SearchResult[] = [];

  const repos = searchRepos(query, limit);
  for (const r of repos) {
    results.push({
      type: "repo",
      repo_name: r.name,
      repo_path: r.path,
      title: r.name,
      snippet: r.description || r.remote_url || r.path,
      date: r.updated_at,
      score: 1.0,
    });
  }

  const commits = searchCommits(query, limit);
  for (const c of commits) {
    results.push({
      type: "commit",
      repo_name: c.repo_name,
      repo_path: c.repo_path,
      title: c.sha.slice(0, 8),
      snippet: c.message.slice(0, 200),
      date: c.date,
      score: 0.9,
    });
  }

  const prs = searchPullRequests(query, limit);
  for (const pr of prs) {
    results.push({
      type: "pr",
      repo_name: pr.repo_name,
      repo_path: "",
      title: `#${pr.number}: ${pr.title}`,
      snippet: `${pr.state} by ${pr.author}`,
      date: pr.created_at,
      score: 0.85,
    });
  }

  results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return results.slice(0, limit);
}

// ── Stats ──

export function getRepoStats(repoId: number): {
  commit_count: number;
  branch_count: number;
  tag_count: number;
  pr_count: number;
  recent_commits: Commit[];
  top_authors: Array<{ author: string; count: number }>;
} {
  const db = getDb();
  const commit_count = (db.query("SELECT COUNT(*) as c FROM commits WHERE repo_id = ?").get(repoId) as any).c;
  const branch_count = (db.query("SELECT COUNT(*) as c FROM branches WHERE repo_id = ?").get(repoId) as any).c;
  const tag_count = (db.query("SELECT COUNT(*) as c FROM tags WHERE repo_id = ?").get(repoId) as any).c;
  const pr_count = (db.query("SELECT COUNT(*) as c FROM pull_requests WHERE repo_id = ?").get(repoId) as any).c;
  const recent_commits = db.query("SELECT * FROM commits WHERE repo_id = ? ORDER BY date DESC LIMIT 10").all(repoId) as Commit[];
  const top_authors = db.query(
    "SELECT author_name as author, COUNT(*) as count FROM commits WHERE repo_id = ? GROUP BY author_email ORDER BY count DESC LIMIT 10"
  ).all(repoId) as Array<{ author: string; count: number }>;

  return { commit_count, branch_count, tag_count, pr_count, recent_commits, top_authors };
}

export function getGlobalStats(): RepoStats {
  const db = getDb();
  const total_repos = (db.query("SELECT COUNT(*) as c FROM repos").get() as any).c;
  const total_commits = (db.query("SELECT COUNT(*) as c FROM commits").get() as any).c;
  const total_branches = (db.query("SELECT COUNT(*) as c FROM branches").get() as any).c;
  const total_tags = (db.query("SELECT COUNT(*) as c FROM tags").get() as any).c;
  const total_prs = (db.query("SELECT COUNT(*) as c FROM pull_requests").get() as any).c;

  const orgRows = db.query("SELECT org, COUNT(*) as c FROM repos WHERE org IS NOT NULL GROUP BY org ORDER BY c DESC").all() as Array<{ org: string; c: number }>;
  const repos_by_org: Record<string, number> = {};
  for (const r of orgRows) repos_by_org[r.org] = r.c;

  const most_active_repos = db.query(
    "SELECT r.name, COUNT(c.id) as commits FROM repos r LEFT JOIN commits c ON c.repo_id = r.id GROUP BY r.id ORDER BY commits DESC LIMIT 10"
  ).all() as Array<{ name: string; commits: number }>;

  const stale_repos = db.query(
    "SELECT r.name, MAX(c.date) as last_commit FROM repos r LEFT JOIN commits c ON c.repo_id = r.id GROUP BY r.id HAVING last_commit < datetime('now', '-30 days') OR last_commit IS NULL ORDER BY last_commit ASC LIMIT 20"
  ).all() as Array<{ name: string; last_commit: string }>;

  return { total_repos, total_commits, total_branches, total_tags, total_prs, repos_by_org, most_active_repos, stale_repos };
}
