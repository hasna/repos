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
  args.push("-f", `query=${query}`);
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);

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
    throw new Error("GitHub GraphQL request failed");
  }
  return parsed?.data;
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
  return graphql(query, variables, false) as T;
}

/**
 * Fetch a complete set of pull requests in the given states.
 *
 * The GraphQL `repository.pullRequests` connection is used rather than
 * `gh search prs`: the search index lags reality by days and will report merged
 * pull requests as open while omitting genuinely open ones, which is precisely
 * the error this sync exists to correct.
 */
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

    const connection: any = data?.repository?.pullRequests;
    if (!connection) throw new Error("GitHub repository is unavailable");
    collected.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }

  return collected;
}

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

  for (let i = 0; i < numbers.length; i += RECONCILE_BATCH) {
    const batch = numbers.slice(i, i + RECONCILE_BATCH);
    const aliases = batch
      .map((n) => `pr${n}: pullRequest(number: ${n}) { number state mergedAt closedAt updatedAt }`)
      .join("\n");
    const data = graphql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
      { owner, name },
      false,
    );
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
  synced: number;
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
  const { limit = 100, reconcile = true, client = liveClient } = opts;
  const state = { mergeStateSupported: true };

  // The complete open set is what reconciliation is judged against, so it is
  // never truncated by --limit. Open sets are small; closed history is not.
  const open = client.fetchPullRequests(ghRepo, { states: ["OPEN"], limit: 1000, state });
  const recent = limit > 0
    ? client.fetchPullRequests(ghRepo, { states: ["MERGED", "CLOSED"], limit, state })
    : [];

  const byNumber = new Map<number, GraphqlPr>();
  for (const pr of [...recent, ...open]) byNumber.set(pr.number, pr);
  const fetched = [...byNumber.values()];
  const openNumbers = new Set(open.map((pr) => pr.number));

  const checkouts = listReposByRemote(remoteUrl);
  let synced = 0;
  let reconciled = 0;

  for (const checkout of checkouts) {
    synced += bulkInsertPullRequests(fetched.map((pr) => toPullRequestInput(checkout.id, pr)));

    if (!reconcile) continue;
    // Anything this checkout still calls open but GitHub did not list as open
    // has left the open set since it was last seen.
    const stale = listOpenPullRequestNumbers(checkout.id).filter((n) => !openNumbers.has(n));
    if (stale.length === 0) continue;

    const live = client.fetchPullRequestStates(ghRepo, stale);
    const updates: PullRequestTerminalState[] = [];
    for (const number of stale) {
      const entry = live.get(number);
      // A number GitHub will not resolve (deleted, transferred, never existed)
      // is left untouched rather than guessed into a terminal state.
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
    reconciled += applyPullRequestTerminalStates(checkout.id, updates);
  }

  return {
    synced,
    reconciled,
    repo_name: opts.repoName ?? ghRepo,
    remote: remoteUrl,
    checkouts: checkouts.length,
    merge_state_available: state.mergeStateSupported,
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
  opts: { org?: string; limit?: number; state?: string; maxRepos?: number; reconcile?: boolean; onProgress?: (msg: string) => void } = {}
): { total_synced: number; total_reconciled: number; repos_seen: number; repos_checked: number; repos_synced: number; remotes_seen: number; truncated: boolean; errors: string[]; skipped: string[] } {
  const { org, limit = 50, maxRepos, reconcile = true, onProgress } = opts;

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
  let total_reconciled = 0;
  let repos_synced = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [remoteUrl, ghRepo] = entries[i]!;
    onProgress?.(`[${i + 1}/${entries.length}] Syncing PRs for ${ghRepo}...`);
    try {
      const result = syncRemotePullRequests(remoteUrl, ghRepo, { limit, reconcile });
      total_synced += result.synced;
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
