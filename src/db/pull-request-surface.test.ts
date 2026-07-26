import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getDb, closeDb } from "./database";
import {
  upsertRepo,
  bulkInsertPullRequests,
  bulkInsertRemotes,
  listPullRequests,
  countPullRequests,
  listOpenPullRequestNumbers,
  applyPullRequestTerminalStates,
  getRepoByRemote,
  listReposByRemote,
  countRepos,
  listPullRequestsWithRepo,
  isDerivedCheckoutPath,
  AmbiguousRemoteError,
  type PullRequestInput,
} from "./repos";

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
});

function pr(overrides: Partial<PullRequestInput> & { repo_id: number; number: number }): PullRequestInput {
  return {
    title: `PR #${overrides.number}`,
    state: "open",
    author: "andrei-hasna",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    merged_at: null,
    closed_at: null,
    url: `https://github.com/hasna/codewith/pull/${overrides.number}`,
    base_branch: "main",
    head_branch: "feature",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    ...overrides,
  };
}

describe("cross-checkout de-duplication", () => {
  it("reports one row per pull request, not one per local checkout", () => {
    // github.com/hasna/codewith is checked out 3 times on this machine: a
    // primary clone plus two worktrees. Each becomes its own repos row and each
    // stores its own copy of PR #415.
    const paths = [
      "/home/user/workspace/open-codewith",
      "/home/user/.hasna/repos/worktrees/codewith/a",
      "/home/user/.hasna/repos/worktrees/codewith/b",
    ];
    for (const path of paths) {
      const repo = upsertRepo({ path, name: path.split("/").pop()!, org: "hasna", remote_url: "github.com/hasna/codewith" });
      bulkInsertPullRequests([pr({ repo_id: repo.id, number: 415 })]);
    }

    expect(countPullRequests({ state: "open" })).toBe(1);
    const rows = listPullRequests({ state: "open" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).toBe(415);
  });

  it("picks the primary clone, not a worktree, as the surviving copy", () => {
    // The surviving row's path is what downstream consumers route work to.
    // Worktrees are indexed after the clone they came from, so without an
    // explicit rank term the final `id DESC` tiebreak always selects one —
    // pointing callers at another task's working directory.
    const primary = upsertRepo({ path: "/home/u/workspace/open-codewith", name: "open-codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const wtA = upsertRepo({ path: "/home/u/.hasna/repos/worktrees/codewith/task-a", name: "task-a", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const wtB = upsertRepo({ path: "/home/u/.hasna/repos/worktrees/station01/open-codewith/task-b", name: "task-b", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const shm = upsertRepo({ path: "/dev/shm/build-20260710/repos/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    // Identical timestamps, exactly as one fan-out sync writes them.
    for (const id of [primary.id, wtA.id, wtB.id, shm.id]) {
      bulkInsertPullRequests([pr({ repo_id: id, number: 424, updated_at: "2026-07-26T01:00:00Z" })]);
    }

    const rows = listPullRequestsWithRepo({ state: "open" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo_path).toBe("/home/u/workspace/open-codewith");
    expect(isDerivedCheckoutPath(rows[0]!.repo_path!)).toBe(false);
  });

  it("falls back to a worktree only when no primary clone holds the PR", () => {
    const wt = upsertRepo({ path: "/home/u/.hasna/repos/worktrees/codewith/only", name: "only", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: wt.id, number: 7 })]);

    const rows = listPullRequestsWithRepo({ state: "open" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo_path).toBe("/home/u/.hasna/repos/worktrees/codewith/only");
  });

  it("does not let the primary preference override fresher data", () => {
    // Path preference ranks below freshness: a stale primary must not beat a
    // worktree that actually saw the merge.
    const primary = upsertRepo({ path: "/home/u/workspace/open-codewith", name: "open-codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const wt = upsertRepo({ path: "/home/u/.hasna/repos/worktrees/codewith/fresh", name: "fresh", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: primary.id, number: 8, state: "open", updated_at: "2026-07-01T00:00:00Z" }),
      pr({ repo_id: wt.id, number: 8, state: "merged", merged_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" }),
    ]);

    expect(listPullRequests({})[0]!.state).toBe("merged");
  });

  it("still exposes every stored copy behind --duplicates", () => {
    for (const path of ["/w/a", "/w/b"]) {
      const repo = upsertRepo({ path, name: path.slice(3), org: "hasna", remote_url: "github.com/hasna/codewith" });
      bulkInsertPullRequests([pr({ repo_id: repo.id, number: 415 })]);
    }
    expect(listPullRequests({ state: "open", duplicates: true })).toHaveLength(2);
    expect(countPullRequests({ state: "open", duplicates: true })).toBe(2);
  });

  it("keeps the reconciled row and drops the stale open copy of the same PR", () => {
    // The stale copy is the bug: a checkout that stopped being synced still
    // calls the PR open long after it merged. Filtering by state before
    // de-duplicating would surface the stale row and hide the merged one.
    const stale = upsertRepo({ path: "/w/stale", name: "stale", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const fresh = upsertRepo({ path: "/w/fresh", name: "fresh", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: stale.id, number: 300, state: "open", updated_at: "2026-07-01T00:00:00Z" }),
      pr({ repo_id: fresh.id, number: 300, state: "merged", merged_at: "2026-07-10T00:00:00Z", updated_at: "2026-07-10T00:00:00Z" }),
    ]);

    expect(listPullRequests({ state: "open" })).toHaveLength(0);
    const merged = listPullRequests({ state: "merged" });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.merged_at).toBe("2026-07-10T00:00:00Z");
  });

  it("prefers the copy whose repo record actually owns the pull request", () => {
    // Live mis-attribution: hasna/aicopilot#9 was also recorded against the
    // unrelated platform-aicopilot record, and that wrong copy said 'open'
    // while the correctly attributed one had merged.
    const wrong = upsertRepo({ path: "/w/platform-aicopilot", name: "platform-aicopilot", org: "hasnatools", remote_url: "github.com/hasnatools/platform-aicopilot" });
    const right = upsertRepo({ path: "/w/open-aicopilot", name: "open-aicopilot", org: "hasna", remote_url: "github.com/hasna/aicopilot" });
    const url = "https://github.com/hasna/aicopilot/pull/9";
    bulkInsertPullRequests([
      pr({ repo_id: wrong.id, number: 9, url, state: "open", updated_at: "2026-07-20T00:00:00Z" }),
      pr({ repo_id: right.id, number: 9, url, state: "merged", merged_at: "2026-07-05T00:00:00Z", updated_at: "2026-07-05T00:00:00Z" }),
    ]);

    const rows = listPullRequests({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("merged");
    expect(rows[0]!.repo_id).toBe(right.id);
  });

  it("reports a reopened pull request as open, not as its earlier closed state", () => {
    // GitHub pull requests can be reopened, so a terminal state is NOT
    // permanent and must never outrank freshness. A copy that saw the closure
    // must not win over a copy that saw the reopen.
    const stale = upsertRepo({ path: "/w/stale", name: "stale", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const fresh = upsertRepo({ path: "/w/fresh", name: "fresh", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: stale.id, number: 50, state: "closed", closed_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z" }),
      pr({ repo_id: fresh.id, number: 50, state: "open", updated_at: "2026-07-09T00:00:00Z" }),
    ]);

    const rows = listPullRequests({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("open");
    expect(listPullRequests({ state: "open" })).toHaveLength(1);
    expect(listPullRequests({ state: "closed" })).toHaveLength(0);
  });

  it("prefers a terminal state only when copies share a timestamp", () => {
    const stale = upsertRepo({ path: "/w/stale", name: "stale", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const fresh = upsertRepo({ path: "/w/fresh", name: "fresh", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: stale.id, number: 51, state: "open", updated_at: "2026-07-05T00:00:00Z" }),
      pr({ repo_id: fresh.id, number: 51, state: "merged", merged_at: "2026-07-05T00:00:00Z", updated_at: "2026-07-05T00:00:00Z" }),
    ]);

    expect(listPullRequests({})[0]!.state).toBe("merged");
  });

  it("never merges distinct pull requests that share no URL", () => {
    const repo = upsertRepo({ path: "/w/one", name: "one", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: repo.id, number: 1, url: null as unknown as string }),
      pr({ repo_id: repo.id, number: 2, url: null as unknown as string }),
    ]);
    // Rows with no URL cannot be proven identical, so both survive.
    expect(listPullRequests({ state: "open" })).toHaveLength(2);
  });

  it("does not hide a repo's own PRs when scoped with --repo", () => {
    const a = upsertRepo({ path: "/w/a", name: "a", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const b = upsertRepo({ path: "/w/b", name: "b", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: a.id, number: 7 }), pr({ repo_id: b.id, number: 7 })]);

    expect(listPullRequests({ repo_id: a.id, state: "open" })).toHaveLength(1);
    expect(listPullRequests({ repo_id: b.id, state: "open" })).toHaveLength(1);
  });
});

describe("--org filtering", () => {
  it("filters by the GitHub owner taken from the PR URL", () => {
    const hasna = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    const studio = upsertRepo({ path: "/w/platform-todos", name: "platform-todos", org: "hasnastudio", remote_url: "github.com/hasnastudio/platform-todos" });
    bulkInsertPullRequests([
      pr({ repo_id: hasna.id, number: 1 }),
      pr({ repo_id: studio.id, number: 2, url: "https://github.com/hasnastudio/platform-todos/pull/2" }),
    ]);

    expect(listPullRequests({ org: "hasna", state: "open" })).toHaveLength(1);
    expect(listPullRequests({ org: "hasnastudio", state: "open" })).toHaveLength(1);
    expect(listPullRequests({ org: "nobody", state: "open" })).toHaveLength(0);
  });

  it("attributes a PR to the org in its URL, not the org of the repo record", () => {
    const repo = upsertRepo({ path: "/w/platform-aicopilot", name: "platform-aicopilot", org: "hasnatools", remote_url: "github.com/hasnatools/platform-aicopilot" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 9, url: "https://github.com/hasna/aicopilot/pull/9" })]);

    expect(listPullRequests({ org: "hasna", state: "open" })).toHaveLength(1);
    expect(listPullRequests({ org: "hasnatools", state: "open" })).toHaveLength(0);
  });

  it("exposes org and repo names on every row", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "open-codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 415 })]);

    const row = listPullRequests({ state: "open" })[0]!;
    expect(row.org).toBe("hasna");
    // The GitHub name, not the local directory name it is checked out as.
    expect(row.repo).toBe("codewith");
  });

  it("filters by GitHub repository name independently of the local directory name", () => {
    const repo = upsertRepo({ path: "/w/open-emails", name: "open-emails", org: "hasna", remote_url: "github.com/hasna/emails" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 3, url: "https://github.com/hasna/emails/pull/3" })]);

    expect(listPullRequests({ repo_name: "emails", state: "open" })).toHaveLength(1);
    expect(listPullRequests({ repo_name: "open-emails", state: "open" })).toHaveLength(0);
  });
});

describe("merge-gate fields", () => {
  it("round-trips every field a merge gate needs", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({
      repo_id: repo.id,
      number: 424,
      head_sha: "bbcead840ce32d7ee3e6637faf85a020451f4671",
      mergeable: "MERGEABLE",
      merge_state_status: "UNSTABLE",
      ci_state: "PENDING",
      is_draft: true,
      review_decision: "APPROVED",
    })]);

    const row = listPullRequests({ state: "open" })[0]!;
    expect(row.head_sha).toBe("bbcead840ce32d7ee3e6637faf85a020451f4671");
    expect(row.mergeable).toBe("MERGEABLE");
    expect(row.merge_state_status).toBe("UNSTABLE");
    expect(row.ci_state).toBe("PENDING");
    expect(row.is_draft).toBe(true);
    expect(row.review_decision).toBe("APPROVED");
  });

  it("defaults gate fields to null for callers that do not supply them", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 1 })]);

    const row = listPullRequests({ state: "open" })[0]!;
    expect(row.head_sha).toBeNull();
    expect(row.mergeable).toBeNull();
    expect(row.is_draft).toBe(false);
  });

  it("updates an existing row in place instead of duplicating it", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 1, ci_state: "PENDING" })]);
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 1, ci_state: "SUCCESS" })]);

    const rows = listPullRequests({ state: "open", duplicates: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ci_state).toBe("SUCCESS");
  });
});

describe("terminal state reconciliation", () => {
  it("drives rows that left the open set to their real terminal state", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([
      pr({ repo_id: repo.id, number: 1 }),
      pr({ repo_id: repo.id, number: 2 }),
      pr({ repo_id: repo.id, number: 3 }),
    ]);
    expect(listOpenPullRequestNumbers(repo.id)).toEqual([1, 2, 3]);

    const changed = applyPullRequestTerminalStates(repo.id, [
      { number: 1, state: "merged", merged_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
      { number: 2, state: "closed", closed_at: "2026-07-21T00:00:00Z" },
    ]);

    expect(changed).toBe(2);
    expect(listOpenPullRequestNumbers(repo.id)).toEqual([3]);
    expect(listPullRequests({ state: "merged" })[0]!.merged_at).toBe("2026-07-20T00:00:00Z");
    expect(listPullRequests({ state: "closed" })[0]!.closed_at).toBe("2026-07-21T00:00:00Z");
  });

  it("never resurrects or rewrites a row that is already terminal", () => {
    const repo = upsertRepo({ path: "/w/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    bulkInsertPullRequests([pr({ repo_id: repo.id, number: 1, state: "merged", merged_at: "2026-01-01T00:00:00Z" })]);

    expect(applyPullRequestTerminalStates(repo.id, [{ number: 1, state: "closed", closed_at: "2026-09-09T00:00:00Z" }])).toBe(0);
    expect(listPullRequests({ state: "merged" })[0]!.merged_at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("deterministic repo targeting", () => {
  it("resolves a repo by its exact GitHub remote, not its local directory name", () => {
    upsertRepo({ path: "/w/open-emails", name: "open-emails", org: "hasna", remote_url: "github.com/hasna/emails" });

    expect(getRepoByRemote("github.com/hasna/emails")!.path).toBe("/w/open-emails");
    expect(getRepoByRemote("hasna/emails")!.path).toBe("/w/open-emails");
    expect(getRepoByRemote("https://github.com/hasna/emails.git")!.path).toBe("/w/open-emails");
  });

  it("returns null rather than guessing when no remote matches", () => {
    upsertRepo({ path: "/w/open-todos", name: "open-todos", org: "hasna", remote_url: "github.com/hasna/todos" });
    // The fuzzy `cd` lookup would happily return open-todos for this.
    expect(getRepoByRemote("github.com/hasnastudio/platform-todos")).toBeNull();
    expect(getRepoByRemote("nonsense")).toBeNull();
  });

  it("prefers the real checkout over worktree copies of the same remote", () => {
    upsertRepo({ path: "/home/u/.hasna/repos/worktrees/codewith/a", name: "a", org: "hasna", remote_url: "github.com/hasna/codewith" });
    upsertRepo({ path: "/home/u/workspace/open-codewith", name: "open-codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });
    upsertRepo({ path: "/dev/shm/build/codewith", name: "codewith", org: "hasna", remote_url: "github.com/hasna/codewith" });

    expect(getRepoByRemote("github.com/hasna/codewith")!.path).toBe("/home/u/workspace/open-codewith");
    expect(listReposByRemote("github.com/hasna/codewith")).toHaveLength(3);
  });

  it("fails loudly when a remote has several equally plausible checkouts", () => {
    upsertRepo({ path: "/w/one", name: "one", org: "hasna", remote_url: "github.com/hasna/codewith" });
    upsertRepo({ path: "/w/two", name: "two", org: "hasna", remote_url: "github.com/hasna/codewith" });

    expect(() => getRepoByRemote("github.com/hasna/codewith")).toThrow(AmbiguousRemoteError);
    expect(getRepoByRemote("github.com/hasna/codewith", { allowAmbiguous: true })!.path).toBe("/w/one");
  });
});

describe("explicit truncation", () => {
  it("reports the true total independently of the page size", () => {
    for (let i = 0; i < 60; i++) {
      upsertRepo({ path: `/w/repo-${i}`, name: `repo-${i}`, org: "hasna", remote_url: `github.com/hasna/repo-${i}` });
    }
    expect(countRepos()).toBe(60);
    expect(countRepos({ org: "hasna" })).toBe(60);
    expect(countRepos({ org: "other" })).toBe(0);
  });

  it("counts de-duplicated pull requests, matching what the listing returns", () => {
    for (const path of ["/w/a", "/w/b", "/w/c"]) {
      const repo = upsertRepo({ path, name: path.slice(3), org: "hasna", remote_url: "github.com/hasna/codewith" });
      bulkInsertPullRequests([pr({ repo_id: repo.id, number: 1 }), pr({ repo_id: repo.id, number: 2 })]);
    }
    expect(countPullRequests({ state: "open" })).toBe(2);
    expect(listPullRequests({ state: "open", limit: 100 })).toHaveLength(2);
  });
});

describe("remote identity preservation", () => {
  it("restores a lost remote_url from the remotes table on migration", () => {
    // Simulates the live index state: the scan nulled remote_url when it could
    // not read .git, but the per-repo remotes row still holds the identity.
    const repo = upsertRepo({ path: "/w/open-banking", name: "open-banking" });
    bulkInsertRemotes([{ repo_id: repo.id, name: "origin", url: "github.com/hasna/banking", fetch_url: null }]);
    const db = getDb();
    db.query("UPDATE repos SET remote_url = NULL, org = NULL WHERE id = ?").run(repo.id);

    // Re-run only the repair the migration performs.
    db.exec(`
      UPDATE repos SET remote_url = (
        SELECT url FROM remotes WHERE remotes.repo_id = repos.id AND remotes.name = 'origin' LIMIT 1
      ) WHERE remote_url IS NULL AND EXISTS (
        SELECT 1 FROM remotes WHERE remotes.repo_id = repos.id AND remotes.name = 'origin'
      );
    `);

    expect((db.query("SELECT remote_url FROM repos WHERE id = ?").get(repo.id) as any).remote_url)
      .toBe("github.com/hasna/banking");
  });

  it("still clears a remote that fails sanitization", () => {
    // Security invariant: a contaminated or unsupported remote must not be
    // preserved just because an older, safer value was indexed earlier.
    const repo = upsertRepo({ path: "/w/x", name: "x", remote_url: "github.com/hasna/x" });
    const updated = upsertRepo({ path: repo.path, name: repo.name, remote_url: "file:///tmp/x" });
    expect(updated.remote_url).toBeNull();
  });
});
