import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getDb, closeDb } from "../db/database.js";
import { upsertRepo, bulkInsertPullRequests, listPullRequests, countPullRequests, type PullRequestInput } from "../db/repos.js";
import { syncRemotePullRequests, syncAllGithubPRs, parseGithubRemote, type GithubPullRequestClient, type GraphqlPr } from "./github.js";

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
});

function ghPr(number: number, overrides: Partial<GraphqlPr> = {}): GraphqlPr {
  return {
    number,
    title: `PR #${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "andrei-hasna" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    url: `https://github.com/hasna/codewith/pull/${number}`,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    headRefOid: `sha-${number}`,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

/** Records what the sync asked GitHub for, and answers from a fixed world. */
function stubClient(world: {
  open: GraphqlPr[];
  closed?: GraphqlPr[];
  states?: Record<number, { state: string; mergedAt: string | null; closedAt: string | null; updatedAt: string | null }>;
}): GithubPullRequestClient & { fetchCalls: number; stateQueries: number[][] } {
  const client = {
    fetchCalls: 0,
    stateQueries: [] as number[][],
    fetchPullRequests(_repo: string, opts: { states: string[] }) {
      client.fetchCalls++;
      return opts.states.includes("OPEN") ? world.open : (world.closed ?? []);
    },
    fetchPullRequestStates(_repo: string, numbers: number[]) {
      client.stateQueries.push(numbers);
      const result = new Map<number, { state: string; mergedAt: string | null; closedAt: string | null; updatedAt: string | null }>();
      for (const n of numbers) {
        const entry = world.states?.[n];
        if (entry) result.set(n, entry);
      }
      return result;
    },
  };
  return client;
}

function seedPr(repoId: number, number: number, overrides: Partial<PullRequestInput> = {}) {
  bulkInsertPullRequests([{
    repo_id: repoId,
    number,
    title: `PR #${number}`,
    state: "open",
    author: "andrei-hasna",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    merged_at: null,
    closed_at: null,
    url: `https://github.com/hasna/codewith/pull/${number}`,
    base_branch: "main",
    head_branch: "old",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    ...overrides,
  }]);
}

describe("sync reconciliation", () => {
  it("closes out rows GitHub no longer lists as open", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    // The index believes 4 PRs are open; GitHub only still lists #4.
    for (const n of [1, 2, 3, 4]) seedPr(repo.id, n);
    expect(countPullRequests({ state: "open" })).toBe(4);

    const client = stubClient({
      open: [ghPr(4)],
      states: {
        1: { state: "MERGED", mergedAt: "2026-07-10T00:00:00Z", closedAt: "2026-07-10T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
        2: { state: "CLOSED", mergedAt: null, closedAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z" },
        3: { state: "MERGED", mergedAt: "2026-07-12T00:00:00Z", closedAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z" },
      },
    });

    const result = syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    expect(result.reconciled).toBe(3);
    expect(countPullRequests({ state: "open" })).toBe(1);
    expect(listPullRequests({ state: "open" })[0]!.number).toBe(4);
    expect(countPullRequests({ state: "merged" })).toBe(2);
    expect(countPullRequests({ state: "closed" })).toBe(1);
  });

  it("reconciles a repo whose open set is now completely empty", () => {
    // The old sync only ever touched what it fetched, so a repo with no open
    // PRs left was never visited and its stale rows lived forever.
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    seedPr(repo.id, 1);

    const client = stubClient({
      open: [],
      states: { 1: { state: "MERGED", mergedAt: "2026-07-10T00:00:00Z", closedAt: null, updatedAt: "2026-07-10T00:00:00Z" } },
    });
    const result = syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    expect(result.reconciled).toBe(1);
    expect(countPullRequests({ state: "open" })).toBe(0);
  });

  it("leaves a PR alone when GitHub will not resolve its number", () => {
    // Deleted, transferred, or never existed — guessing a terminal state here
    // would invent history.
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    seedPr(repo.id, 99);

    const result = syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client: stubClient({ open: [], states: {} }) });

    expect(result.reconciled).toBe(0);
    expect(countPullRequests({ state: "open" })).toBe(1);
  });

  it("does not reconcile a PR GitHub still reports as open", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    seedPr(repo.id, 5);
    const client = stubClient({
      open: [],
      states: { 5: { state: "OPEN", mergedAt: null, closedAt: null, updatedAt: "2026-07-20T00:00:00Z" } },
    });

    expect(syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client }).reconciled).toBe(0);
    expect(countPullRequests({ state: "open" })).toBe(1);
  });

  it("skips reconciliation entirely when asked to", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    seedPr(repo.id, 1);
    const client = stubClient({
      open: [],
      states: { 1: { state: "MERGED", mergedAt: "2026-07-10T00:00:00Z", closedAt: null, updatedAt: null } },
    });

    expect(syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client, reconcile: false }).reconciled).toBe(0);
    expect(client.stateQueries).toHaveLength(0);
    expect(countPullRequests({ state: "open" })).toBe(1);
  });

  it("reconciles every local checkout of the remote from a single fetch", () => {
    // Syncing per directory refetched identical data once per checkout and left
    // any checkout it did not visit holding stale open rows.
    const paths = ["/w/primary", "/w/worktrees/a", "/w/worktrees/b"];
    const ids = paths.map((path) => upsertRepo({ path, name: path.split("/").pop()!, org: "hasna", remote_url: "github.com/hasna/codewith" }).id);
    for (const id of ids) seedPr(id, 1);
    expect(countPullRequests({ state: "open", duplicates: true })).toBe(3);

    const client = stubClient({
      open: [],
      states: { 1: { state: "MERGED", mergedAt: "2026-07-10T00:00:00Z", closedAt: null, updatedAt: "2026-07-10T00:00:00Z" } },
    });
    const result = syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    expect(result.checkouts).toBe(3);
    expect(result.reconciled).toBe(3);
    // One open fetch plus one closed-history fetch, regardless of checkout count.
    expect(client.fetchCalls).toBe(2);
    // And exactly ONE state-reconciliation query for the whole remote. Asking
    // per checkout would re-send the same question once per local directory;
    // this machine has a remote checked out 115 times.
    expect(client.stateQueries).toEqual([[1]]);
    expect(countPullRequests({ state: "open", duplicates: true })).toBe(0);
  });

  it("asks GitHub once for the union of stale numbers across checkouts", () => {
    const a = upsertRepo({ path: "/w/a", name: "a", org: "hasna", remote_url: "github.com/hasna/codewith" }).id;
    const b = upsertRepo({ path: "/w/b", name: "b", org: "hasna", remote_url: "github.com/hasna/codewith" }).id;
    // The checkouts disagree about which PRs they still call open.
    seedPr(a, 1); seedPr(a, 2);
    seedPr(b, 2); seedPr(b, 3);

    const client = stubClient({
      open: [],
      states: {
        1: { state: "MERGED", mergedAt: "2026-07-10T00:00:00Z", closedAt: null, updatedAt: "2026-07-10T00:00:00Z" },
        2: { state: "CLOSED", mergedAt: null, closedAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z" },
        3: { state: "MERGED", mergedAt: "2026-07-12T00:00:00Z", closedAt: null, updatedAt: "2026-07-12T00:00:00Z" },
      },
    });
    const result = syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    expect(client.stateQueries).toEqual([[1, 2, 3]]);
    expect(result.reconciled).toBe(4);
    expect(countPullRequests({ state: "open", duplicates: true })).toBe(0);
  });

  it("skips the closed-history fetch when the caller only wants open PRs", () => {
    upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const client = stubClient({ open: [ghPr(1)], closed: [ghPr(9, { state: "MERGED", mergedAt: "2026-07-01T00:00:00Z" })] });

    syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client, state: "open" });

    // Only the open-set fetch, not the merged/closed page.
    expect(client.fetchCalls).toBe(1);
    expect(countPullRequests({ state: "merged" })).toBe(0);
  });

  it("stores the merge-gate fields the GraphQL connection returns", () => {
    upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const client = stubClient({
      open: [ghPr(424, { isDraft: true, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "CHANGES_REQUESTED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } })],
    });
    syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    const row = listPullRequests({ state: "open" })[0]!;
    expect(row.head_sha).toBe("sha-424");
    expect(row.mergeable).toBe("CONFLICTING");
    expect(row.merge_state_status).toBe("DIRTY");
    expect(row.ci_state).toBe("FAILURE");
    expect(row.review_decision).toBe("CHANGES_REQUESTED");
    expect(row.is_draft).toBe(true);
    expect(row.org).toBe("hasna");
    expect(row.repo).toBe("codewith");
  });

  it("records a merged PR returned by the closed-history fetch as merged", () => {
    upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const client = stubClient({
      open: [],
      closed: [ghPr(10, { state: "MERGED", mergedAt: "2026-07-15T00:00:00Z", closedAt: "2026-07-15T00:00:00Z" })],
    });
    syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    expect(countPullRequests({ state: "open" })).toBe(0);
    expect(listPullRequests({ state: "merged" })[0]!.merged_at).toBe("2026-07-15T00:00:00Z");
  });

  it("tolerates a repository with no statusCheckRollup at all", () => {
    upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const client = stubClient({ open: [ghPr(1, { commits: { nodes: [] }, mergeStateStatus: null })] });
    syncRemotePullRequests("github.com/hasna/codewith", "hasna/codewith", { client });

    const row = listPullRequests({ state: "open" })[0]!;
    expect(row.ci_state).toBeNull();
    expect(row.merge_state_status).toBeNull();
  });
});

describe("syncAllGithubPRs fan-out", () => {
  it("does one pass per distinct remote, not one per checkout", () => {
    for (const path of ["/w/a", "/w/b", "/w/c"]) {
      upsertRepo({ path, name: path.slice(3), org: "hasna", remote_url: "github.com/hasna/codewith" });
    }
    upsertRepo({ path: "/w/other", name: "other", org: "hasna", remote_url: "github.com/hasna/repos" });

    // A stub client keeps this hermetic — without one the call would spawn real
    // `gh api graphql` subprocesses and pass only because the failures land in
    // result.errors, which nothing asserts on.
    const client = stubClient({ open: [] });
    const result = syncAllGithubPRs({ org: "hasna", limit: 0, client });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.repos_seen).toBe(4);
    expect(result.remotes_seen).toBe(2);
    expect(result.repos_checked).toBe(2);
    // Two distinct remotes behind four checkouts, so two open-set fetches.
    expect(client.fetchCalls).toBe(2);
  });
});

describe("parseGithubRemote", () => {
  it("accepts a normalized GitHub identity", () => {
    expect(parseGithubRemote("github.com/hasna/repos")).toBe("hasna/repos");
  });

  it("rejects non-GitHub or malformed remotes", () => {
    expect(parseGithubRemote("gitlab.com/hasna/repos")).toBeNull();
    expect(parseGithubRemote("github.com/hasna")).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});
