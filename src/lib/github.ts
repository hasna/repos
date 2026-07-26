import { execFileSync } from "node:child_process";
import { getDb } from "../db/database.js";
import {
  getRepo,
  bulkInsertPullRequests,
  listAllRepos,
  listReposByRemote,
  listOpenPullRequestNumbers,
  applyPullRequestTerminalStates,
  type PullRequestInput,
  type PullRequestTerminalState,
} from "../db/repos.js";

function gh(args: string[]): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as Error & { stderr?: Buffer | string; status?: number | null; signal?: NodeJS.Signals | null };
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : err.stderr;
    const detail = (stderr || err.message || "").replace(/\s+/g, " ").trim();
    const status = err.status == null ? "" : ` exit=${err.status}`;
    const signal = err.signal ? ` signal=${err.signal}` : "";
    if (isMissingRepoError(detail)) throw new Error("GitHub repository is unavailable");
    // Field-level GraphQL rejections must stay recognisable so the caller can
    // retry a reduced query, but the message never carries response bytes.
    if (isUnsupportedFieldError(detail)) throw new UnsupportedGraphqlFieldError();
    throw new Error(`GitHub CLI request failed${status}${signal}`);
  }
}

export class UnsupportedGraphqlFieldError extends Error {
  constructor() {
    super("GitHub GraphQL rejected a requested field");
    this.name = "UnsupportedGraphqlFieldError";
  }
}

const UNSUPPORTED_FIELD_PATTERNS: RegExp[] = [
  /mergeStateStatus/i,
  /field .* doesn't exist/i,
  /undefinedField/i,
  /requires .* preview/i,
];

function isUnsupportedFieldError(message: string): boolean {
  return UNSUPPORTED_FIELD_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * `mergeStateStatus` is still behind a preview media type. Requesting it
 * without the header is rejected outright, and the header itself can be refused
 * by proxies or older GitHub Enterprise, so the field is always optional.
 */
const MERGE_INFO_PREVIEW = "Accept: application/vnd.github.merge-info-preview+json";

export interface GraphqlPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefOid: string | null;
  mergeable: string | null;
  mergeStateStatus?: string | null;
  reviewDecision: string | null;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}

function pullRequestFields(withMergeState: boolean): string {
  return `
    number title state isDraft author { login }
    createdAt updatedAt mergedAt closedAt url
    baseRefName headRefName additions deletions changedFiles
    headRefOid mergeable reviewDecision${withMergeState ? "\n    mergeStateStatus" : ""}
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
}

function graphql(query: string, variables: Record<string, string>, withMergeState: boolean): any {
  const args = ["api", "graphql"];
  if (withMergeState) args.push("-H", MERGE_INFO_PREVIEW);
  // `-f/--raw-field` throughout, never `-F/--field`: -F applies magic type
  // conversion, so an all-numeric repository name (GitHub permits e.g. "2048")
  // would be sent as an Int against a String! variable, and a value starting
  // with "@" would be read as a filename.
  args.push("-f", `query=${query}`);
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);

  const output = gh(args);
  if (!output) throw new Error("GitHub GraphQL returned empty output");
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("GitHub GraphQL returned invalid JSON");
  }
  if (parsed?.errors?.length) {
    const detail = String(parsed.errors[0]?.message ?? "").replace(/\s+/g, " ");
    if (isUnsupportedFieldError(detail)) throw new UnsupportedGraphqlFieldError();
    if (isMissingRepoError(detail)) throw new Error("GitHub repository is unavailable");
    // GitHub answers a partially-resolvable query with data AND errors. One
    // unresolvable alias among fifty must not discard the forty-nine that did
    // resolve, so only a response with nothing usable is an outright failure.
    if (!hasUsableData(parsed.data)) throw new Error("GitHub GraphQL request failed");
  }
  return parsed?.data;
}

function hasUsableData(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return false;
  return Object.values(repository as Record<string, unknown>).some((value) => value != null);
}

/**
 * Run a query, transparently dropping `mergeStateStatus` if GitHub refuses it.
 * Degrading is preferable to failing: every other merge-gate field is still
 * worth indexing.
 */
function graphqlWithOptionalMergeState<T>(build: (withMergeState: boolean) => { query: string; variables: Record<string, string> }, state: { mergeStateSupported: boolean }): T {
  if (state.mergeStateSupported) {
    const { query, variables } = build(true);
    try {
      return graphql(query, variables, true) as T;
    } catch (error) {
      if (!(error instanceof UnsupportedGraphqlFieldError)) throw error;
      state.mergeStateSupported = false;
    }
  }
  const { query, variables } = build(false);
  try {
    return graphql(query, variables, false) as T;
  } catch (error) {
    // The reduced query no longer mentions mergeStateStatus, so a field
    // rejection here is about some OTHER field. Reporting it as the same
    // generic error would hide which field GitHub actually refused.
    if (error instanceof UnsupportedGraphqlFieldError) {
      throw new Error("GitHub GraphQL rejected a field this client requires");
    }
    throw error;
  }
}

/**
 * Fetch a complete set of pull requests in the given states.
 *
 * The GraphQL `repository.pullRequests` connection is used rather than
 * `gh search prs`: the search index lags reality by days and will report merged
 * pull requests as open while omitting genuinely open ones, which is precisely
 * the error this sync exists to correct.
 */
/**
 * Keep only usable pull request nodes from a connection page.
 *
 * A partially-resolved page arrives as `nodes` containing null holes alongside
 * an `errors` entry — and since partial responses are deliberately allowed
 * through, those holes reach this code. Dereferencing one throws and aborts the
 * whole sync, so they are dropped rather than trusted.
 */
export function collectPullRequestNodes(nodes: unknown): GraphqlPr[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node): node is GraphqlPr => {
    if (!node || typeof node !== "object") return false;
    const pr = node as Partial<GraphqlPr>;
    // Everything the writer stores into a NOT NULL column is required here, so
    // a half-resolved node is dropped at the boundary rather than aborting a
    // write transaction further in.
    return typeof pr.number === "number" && Number.isSafeInteger(pr.number) && pr.number > 0
      && typeof pr.title === "string"
      && typeof pr.createdAt === "string" && pr.createdAt !== ""
      && typeof pr.state === "string" && pr.state !== "";
  });
}

export function fetchPullRequests(
  ghRepo: string,
  opts: { states: string[]; limit: number; state: { mergeStateSupported: boolean } },
): GraphqlPr[] {
  const [owner, name] = ghRepo.split("/");
  if (!owner || !name) throw new Error("Cannot parse GitHub repository identity");

  const collected: GraphqlPr[] = [];
  let after: string | null = null;

  while (collected.length < opts.limit) {
    const pageSize = Math.min(100, opts.limit - collected.length);
    const cursorArg: string | null = after;
    const data: any = graphqlWithOptionalMergeState<any>((withMergeState) => ({
      query: `query($owner: String!, $name: String!${cursorArg ? ", $after: String!" : ""}) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: [${opts.states.join(", ")}], first: ${pageSize}${cursorArg ? ", after: $after" : ""}, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes { ${pullRequestFields(withMergeState)} }
          }
        }
      }`,
      variables: (cursorArg ? { owner, name, after: cursorArg } : { owner, name }) as Record<string, string>,
    }), opts.state);

    // Distinguish "this repository is gone" from "this request did not come
    // back cleanly". Only the former may be classified as skipped-and-continued
    // by a fleet-wide sync; a transient failure must surface as an error rather
    // than be silently filed alongside renamed and deleted repositories.
    if (!data?.repository) throw new Error("GitHub repository is unavailable");
    const connection: any = data.repository.pullRequests;
    if (!connection) throw new Error("GitHub GraphQL returned no pull request connection");
    collected.push(...collectPullRequestNodes(connection.nodes));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }

  return collected;
}

/**
 * Ceiling on the open set fetched for reconciliation. Exceeding it does not
 * cause wrongful closure — every number missing from the set is individually
 * re-queried and skipped when GitHub still answers OPEN — it only costs extra
 * requests.
 */
const OPEN_SET_CAP = 1000;

const RECONCILE_BATCH = 50;

/**
 * Ask GitHub for the current state of specific pull request numbers.
 *
 * Used for rows the index still calls open that were absent from the live open
 * set. They cannot simply be marked closed: a merged pull request must record
 * that it merged, and a number can also have been deleted or never existed.
 */
export function fetchPullRequestStates(
  ghRepo: string,
  numbers: number[],
): Map<number, { state: string; mergedAt: string | null; closedAt: string | null; updatedAt: string | null }> {
  const [owner, name] = ghRepo.split("/");
  const result = new Map<number, { state: string; mergedAt: string | null; closedAt: string | null; updatedAt: string | null }>();
  if (!owner || !name || numbers.length === 0) return result;

  // Only well-formed positive integers become aliases. The values come from an
  // INTEGER column today, but a malformed one would otherwise be interpolated
  // straight into the query and fail the whole batch.
  const safeNumbers = numbers.filter((n) => Number.isSafeInteger(n) && n > 0);

  for (let i = 0; i < safeNumbers.length; i += RECONCILE_BATCH) {
    const batch = safeNumbers.slice(i, i + RECONCILE_BATCH);
    const aliases = batch
      .map((n) => `pr${n}: pullRequest(number: ${n}) { number state mergedAt closedAt updatedAt }`)
      .join("\n");
    let data: any;
    try {
      data = graphql(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
        { owner, name },
        false,
      );
    } catch {
      // A batch that fails outright leaves its numbers unresolved, and
      // unresolved numbers are left in place rather than guessed. Continuing
      // keeps one bad batch from abandoning reconciliation for the rest of the
      // repository — and for every other checkout of it.
      continue;
    }
    const repository = data?.repository ?? {};
    for (const n of batch) {
      const node = repository[`pr${n}`];
      if (!node) continue;
      result.set(n, {
        state: String(node.state ?? "").toUpperCase(),
        mergedAt: node.mergedAt ?? null,
        closedAt: node.closedAt ?? null,
        updatedAt: node.updatedAt ?? null,
      });
    }
  }

  return result;
}

function toPullRequestInput(repoId: number, pr: GraphqlPr): PullRequestInput {
  return {
    repo_id: repoId,
    number: pr.number,
    title: pr.title,
    state: pr.mergedAt ? "merged" : (String(pr.state).toLowerCase() === "open" ? "open" : "closed"),
    author: pr.author?.login || "unknown",
    created_at: pr.createdAt,
    updated_at: pr.updatedAt || null,
    merged_at: pr.mergedAt || null,
    closed_at: pr.closedAt || null,
    url: pr.url,
    base_branch: pr.baseRefName || null,
    head_branch: pr.headRefName || null,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changed_files: pr.changedFiles || 0,
    head_sha: pr.headRefOid || null,
    mergeable: pr.mergeable || null,
    merge_state_status: pr.mergeStateStatus ?? null,
    ci_state: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    is_draft: Boolean(pr.isDraft),
    review_decision: pr.reviewDecision || null,
  };
}

export interface SyncPullRequestsResult {
  /**
   * Distinct pull requests synced. NOT the number of rows written: the same
   * pull request is stored once per local checkout, so reporting rows would
   * overstate a 3-PR repository as 69 on a remote checked out 23 times.
   */
  synced: number;
  /** Rows written across every checkout of this remote. */
  rows_written: number;
  reconciled: number;
  repo_name: string;
  remote: string;
  checkouts: number;
  merge_state_available: boolean;
}

export function parseGithubRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/^github\.com\/([^/]+\/[^/]+)$/);
  return match ? match[1]!.replace(/\.git$/, "") : null;
}

/**
 * Sync one GitHub repository into every local checkout of it.
 *
 * Two properties matter here and neither held before:
 *
 *  - **Reconciliation.** Fetching only what is currently open (or recently
 *    updated) and upserting it can never move a row out of `open`. Rows the
 *    index still calls open that GitHub no longer lists are re-queried and
 *    driven to their real terminal state.
 *  - **Fan-out by remote, not by directory.** The same repository is indexed
 *    once per local checkout. Syncing per directory refetched identical data
 *    dozens of times and, worse, left every checkout that was not visited
 *    holding stale open rows forever.
 */
export function syncGithubPRs(
  repoIdOrName: string | number,
  opts: { limit?: number; state?: string; reconcile?: boolean; client?: GithubPullRequestClient } = {}
): SyncPullRequestsResult {
  const repo = getRepo(repoIdOrName);
  if (!repo) throw new Error(`Repo not found: ${repoIdOrName}`);
  if (!repo.remote_url) throw new Error(`Repo has no remote URL: ${repo.name}`);

  const ghRepo = parseGithubRemote(repo.remote_url);
  if (!ghRepo) throw new Error(`Cannot parse GitHub repo from: ${repo.remote_url}`);

  return syncRemotePullRequests(repo.remote_url, ghRepo, { ...opts, repoName: repo.name });
}

/**
 * The GitHub reads a sync performs. Injectable so the reconciliation rules can
 * be tested against known responses instead of the live API.
 */
export interface GithubPullRequestClient {
  fetchPullRequests(ghRepo: string, opts: { states: string[]; limit: number; state: { mergeStateSupported: boolean } }): GraphqlPr[];
  fetchPullRequestStates(ghRepo: string, numbers: number[]): ReturnType<typeof fetchPullRequestStates>;
}

const liveClient: GithubPullRequestClient = { fetchPullRequests, fetchPullRequestStates };

export function syncRemotePullRequests(
  remoteUrl: string,
  ghRepo: string,
  opts: { limit?: number; state?: string; reconcile?: boolean; repoName?: string; client?: GithubPullRequestClient } = {},
): SyncPullRequestsResult {
  const { limit = 100, state: stateFilter = "all", reconcile = true, client = liveClient } = opts;
  const caps = { mergeStateSupported: true };

  // The complete open set is what reconciliation is judged against, so it is
  // never truncated by --limit. Open sets are small; closed history is not.
  const open = client.fetchPullRequests(ghRepo, { states: ["OPEN"], limit: OPEN_SET_CAP, state: caps });
  // `state` selects how much history to page, not which rows are written. The
  // open set is always fetched because reconciliation is judged against it.
  // "open" therefore skips the merged/closed page; "all" (the default),
  // "closed" and "merged" all page it, since each needs closed history.
  const wantsClosedHistory = stateFilter !== "open" && limit > 0;
  const recent = wantsClosedHistory
    ? client.fetchPullRequests(ghRepo, { states: ["MERGED", "CLOSED"], limit, state: caps })
    : [];

  const byNumber = new Map<number, GraphqlPr>();
  for (const pr of [...recent, ...open]) byNumber.set(pr.number, pr);
  const fetched = [...byNumber.values()];
  const openNumbers = new Set(open.map((pr) => pr.number));

  const checkouts = listReposByRemote(remoteUrl);
  let rows_written = 0;
  let reconciled = 0;

  for (const checkout of checkouts) {
    rows_written += bulkInsertPullRequests(fetched.map((pr) => toPullRequestInput(checkout.id, pr)));
  }

  if (reconcile && checkouts.length > 0) {
    // Every checkout of a remote holds copies of the same pull requests, so
    // their stale sets overlap almost entirely. Collect the union and resolve
    // it in ONE pass: querying per checkout would re-ask GitHub the same
    // question once per local directory, and this machine has remotes checked
    // out over a hundred times.
    const staleByCheckout = new Map<number, number[]>();
    const allStale = new Set<number>();
    for (const checkout of checkouts) {
      const stale = listOpenPullRequestNumbers(checkout.id).filter((n) => !openNumbers.has(n));
      if (stale.length === 0) continue;
      staleByCheckout.set(checkout.id, stale);
      for (const number of stale) allStale.add(number);
    }

    if (allStale.size > 0) {
      const live = client.fetchPullRequestStates(ghRepo, [...allStale].sort((a, b) => a - b));
      for (const [checkoutId, stale] of staleByCheckout) {
        const updates: PullRequestTerminalState[] = [];
        for (const number of stale) {
          const entry = live.get(number);
          // A number GitHub will not resolve (deleted, transferred, never
          // existed) is left untouched rather than guessed into a terminal state.
          if (!entry) continue;
          if (entry.state === "OPEN") continue;
          updates.push({
            number,
            state: entry.state === "MERGED" || entry.mergedAt ? "merged" : "closed",
            merged_at: entry.mergedAt,
            closed_at: entry.closedAt,
            updated_at: entry.updatedAt,
          });
        }
        reconciled += applyPullRequestTerminalStates(checkoutId, updates);
      }
    }
  }

  return {
    synced: fetched.length,
    rows_written,
    reconciled,
    repo_name: opts.repoName ?? ghRepo,
    remote: remoteUrl,
    checkouts: checkouts.length,
    merge_state_available: caps.mergeStateSupported,
  };
}

// Stale/renamed/deleted GitHub repos surface as resolvable-only errors from `gh`.
// These are expected (a repo in the local inventory was renamed or removed on the
// remote) and must NOT abort or fail a fleet-wide sync — they are skipped, not errored.
const MISSING_REPO_PATTERNS: RegExp[] = [
  /GitHub repository is unavailable/i,
  /could not resolve to a repository/i,
  /http 404/i,
  /404: not found/i,
  /repository not found/i,
];

export function isMissingRepoError(message: string): boolean {
  return MISSING_REPO_PATTERNS.some((pattern) => pattern.test(message));
}

export function syncAllGithubPRs(
  opts: { org?: string; limit?: number; state?: string; maxRepos?: number; reconcile?: boolean; client?: GithubPullRequestClient; onProgress?: (msg: string) => void } = {}
): { total_synced: number; total_rows_written: number; total_reconciled: number; repos_seen: number; repos_checked: number; repos_synced: number; remotes_seen: number; truncated: boolean; errors: string[]; skipped: string[] } {
  const { org, limit = 50, state, maxRepos, reconcile = true, client, onProgress } = opts;

  const repos = listAllRepos(org ? { org } : {})
    .filter((repo) => repo.remote_url?.startsWith("github.com/"));
  const repos_seen = repos.length;

  // Collapse local checkouts to the distinct remotes behind them: the network
  // work is per repository, not per directory, and every checkout of a remote
  // is updated by a single fetch.
  const remotes = new Map<string, string>();
  for (const repo of repos) {
    const ghRepo = parseGithubRemote(repo.remote_url);
    if (ghRepo && !remotes.has(repo.remote_url!)) remotes.set(repo.remote_url!, ghRepo);
  }

  let entries = [...remotes.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  const remotes_seen = entries.length;
  const normalizedMaxRepos = normalizePositiveInteger(maxRepos);
  if (normalizedMaxRepos && entries.length > normalizedMaxRepos) entries = entries.slice(0, normalizedMaxRepos);

  let total_synced = 0;
  let total_rows_written = 0;
  let total_reconciled = 0;
  let repos_synced = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [remoteUrl, ghRepo] = entries[i]!;
    onProgress?.(`[${i + 1}/${entries.length}] Syncing PRs for ${ghRepo}...`);
    try {
      const result = syncRemotePullRequests(remoteUrl, ghRepo, { limit, state, reconcile, client });
      total_synced += result.synced;
      total_rows_written += result.rows_written;
      total_reconciled += result.reconciled;
      repos_synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A renamed/deleted remote (404) is skipped-and-continued, never a hard error.
      if (isMissingRepoError(message)) {
        skipped.push(`${ghRepo}: ${message}`);
      } else {
        errors.push(`${ghRepo}: ${message}`);
      }
    }
  }

  return {
    total_synced,
    total_rows_written,
    total_reconciled,
    repos_seen,
    repos_checked: entries.length,
    repos_synced,
    remotes_seen,
    truncated: entries.length < remotes_seen,
    errors,
    skipped,
  };
}

export function fetchRepoMetadata(repoIdOrName: string | number): {
  description: string | null;
  topics: string[];
  stars: number;
  forks: number;
  language: string | null;
} | null {
  const repo = getRepo(repoIdOrName);
  if (!repo?.remote_url) return null;

  const ghRepo = parseGithubRemote(repo.remote_url);
  if (!ghRepo) return null;

  try {
    const output = gh(["repo", "view", ghRepo, "--json", "description,repositoryTopics,stargazerCount,forkCount,primaryLanguage"]);
    if (!output) return null;
    const data = JSON.parse(output);
    const description = data.description || null;
    const topics = (data.repositoryTopics || []).map((t: any) => t.name);
    const stars = data.stargazerCount || 0;
    const forks = data.forkCount || 0;
    const language = data.primaryLanguage?.name || null;

    // Update repo description in DB
    if (description) {
      const db = getDb();
      db.query("UPDATE repos SET description = ?, updated_at = datetime('now') WHERE id = ?")
        .run(description, repo.id);
    }

    return { description, topics, stars, forks, language };
  } catch {
    return null;
  }
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}
