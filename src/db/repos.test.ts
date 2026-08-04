import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getDb, closeDb } from "./database";
import {
  listRepos,
  listAllRepos,
  getRepo,
  upsertRepo,
  deleteRepo,
  searchRepos,
  listCommits,
  bulkInsertCommits,
  searchCommits,
  listBranches,
  bulkInsertBranches,
  listTags,
  bulkInsertTags,
  listRemotes,
  bulkInsertRemotes,
  listPullRequests,
  bulkInsertPullRequests,
  searchPullRequests,
  searchAll,
  getRepoStats,
  getGlobalStats,
} from "./repos";

// Use in-memory DB for tests
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  db = getDb(":memory:");
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
});

describe("repos", () => {
  it("should list repos (empty)", () => {
    expect(listRepos()).toEqual([]);
  });

  it("should upsert a new repo", () => {
    const repo = upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    expect(repo.name).toBe("test-repo");
    expect(repo.path).toBe("/tmp/test-repo");
    expect(repo.id).toBeGreaterThan(0);
  });

  it("should update existing repo on upsert", () => {
    upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    const updated = upsertRepo({ path: "/tmp/test-repo", name: "test-repo", org: "myorg" });
    expect(updated.org).toBe("myorg");
    const all = listRepos();
    expect(all.length).toBe(1);
  });

  it("should get repo by path", () => {
    upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    const repo = getRepo("/tmp/test-repo");
    expect(repo).toBeTruthy();
    expect(repo!.name).toBe("test-repo");
  });

  it("should get repo by name", () => {
    upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    const repo = getRepo("test-repo");
    expect(repo).toBeTruthy();
    expect(repo!.path).toBe("/tmp/test-repo");
  });

  it("fails closed when an exact repo name matches multiple rows", () => {
    upsertRepo({ path: "/tmp/test-repo-a", name: "duplicate-name" });
    upsertRepo({ path: "/tmp/test-repo-b", name: "duplicate-name" });
    expect(() => getRepo("duplicate-name")).toThrow("Multiple repos have the exact name");
  });

  // Regression for todos c357a1f3: `repos repo <name> --json` — the exact
  // lookup non-overridable rule 5 mandates for locating a repository —
  // resolved to a stale `_factory_src` scratch clone instead of the canonical
  // checkout, because the clone is indexed under a DIFFERENT `name` value
  // (the bare "loops") than the canonical checkout ("open-loops"), so the
  // clone was the ONLY exact match for the bare name. This is not the
  // multi-row tie the test above covers — a single, deterministic, wrong
  // match — and it reproduced identically on 5 of 5 packages tested live on
  // station01, on @hasna/repos 0.1.38 and still on 0.1.39.
  describe("factory scratch clones never win a bare-name lookup", () => {
    it("refuses a bare name whose only exact match is a factory scratch clone, even though the canonical checkout is indexed under a different name", () => {
      upsertRepo({
        path: "/home/u/workspace/hasna/opensource/open-loops",
        name: "open-loops",
        org: "hasna",
        remote_url: "github.com/hasna/loops",
      });
      upsertRepo({
        path: "/home/u/workspace/hasna/opensource/_factory_src/loops",
        name: "loops",
        org: "hasna",
        remote_url: "github.com/hasna/loops",
      });

      // The bug: this used to return the _factory_src row.
      expect(getRepo("loops")).toBeNull();
      // The canonical name still resolves normally — this lookup refuses the
      // derived-only match, it does not become unable to find real checkouts.
      const canonical = getRepo("open-loops");
      expect(canonical).toBeTruthy();
      expect(canonical!.path).toBe("/home/u/workspace/hasna/opensource/open-loops");
    });

    it("refuses a bare name whose only match is a factory scratch clone with no canonical sibling at all", () => {
      upsertRepo({
        path: "/home/u/workspace/hasna/opensource/_factory_src/onlymirror",
        name: "onlymirror",
        org: "hasna",
      });
      expect(getRepo("onlymirror")).toBeNull();
    });

    it("resolves to the real checkout, not AmbiguousRepoNameError, when a factory scratch clone happens to share an exact name with it", () => {
      // Distinct from the "duplicate-name" test above: there TWO real
      // checkouts share a name, which is a genuine conflict. Here only ONE of
      // the two same-named rows is a real checkout, so it is not a conflict —
      // narrowing to the non-derived row is what getRepoByRemote already does
      // for the equivalent situation on the --remote lookup path.
      const canonical = upsertRepo({
        path: "/home/u/workspace/open-shared",
        name: "shared",
        org: "hasna",
        remote_url: "github.com/hasna/shared",
      });
      upsertRepo({
        path: "/home/u/workspace/_factory_src/shared",
        name: "shared",
        org: "hasna",
        remote_url: "github.com/hasna/shared-scratch",
      });

      const resolved = getRepo("shared");
      expect(resolved).toBeTruthy();
      expect(resolved!.id).toBe(canonical.id);
    });
  });

  it("should get repo by ID", () => {
    const created = upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    const repo = getRepo(created.id);
    expect(repo).toBeTruthy();
    expect(repo!.name).toBe("test-repo");
  });

  it("should return null for non-existent repo", () => {
    expect(getRepo("nonexistent")).toBeNull();
  });

  it("should delete repo", () => {
    const repo = upsertRepo({ path: "/tmp/test-repo", name: "test-repo" });
    expect(deleteRepo(repo.id)).toBe(true);
    expect(listRepos().length).toBe(0);
  });

  it("should filter repos by org", () => {
    upsertRepo({ path: "/tmp/a", name: "a", org: "hasna" });
    upsertRepo({ path: "/tmp/b", name: "b", org: "hasnaxyz" });
    upsertRepo({ path: "/tmp/c", name: "c", org: "hasna" });
    expect(listRepos({ org: "hasna" }).length).toBe(2);
    expect(listRepos({ org: "hasnaxyz" }).length).toBe(1);
  });

  it("should paginate repos", () => {
    for (let i = 0; i < 5; i++) {
      upsertRepo({ path: `/tmp/repo-${i}`, name: `repo-${i}` });
    }
    expect(listRepos({ limit: 2 }).length).toBe(2);
    expect(listRepos({ limit: 2, offset: 3 }).length).toBe(2);
  });

  it("enumerates every repository deterministically across small pages", () => {
    for (let i = 0; i < 7; i++) {
      upsertRepo({ path: `/tmp/all-${i}`, name: `all-${i}` });
    }
    const first = listAllRepos({}, 2);
    const second = listAllRepos({}, 3);
    expect(first.map((repo) => repo.id)).toEqual(second.map((repo) => repo.id));
    expect(first).toHaveLength(7);
    expect(new Set(first.map((repo) => repo.id)).size).toBe(7);
  });

  it("should search repos via FTS5", () => {
    upsertRepo({ path: "/tmp/open-todos", name: "open-todos", description: "task management for agents" });
    upsertRepo({ path: "/tmp/open-git", name: "open-git", description: "git intelligence platform" });
    const results = searchRepos("task management");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("open-todos");
  });

  it("sanitizes contaminated direct rows at list, get, FTS search, and unified search outputs", () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker#fragment`;
    db.query("INSERT INTO repos (path, name, remote_url) VALUES ('/tmp/unsafe', 'unsafeoutput', ?)").run(unsafe);

    expect(listRepos({ query: "unsafeoutput" })[0]!.remote_url).toBe("git.example.test/team/tool");
    expect(getRepo("unsafeoutput")!.remote_url).toBe("git.example.test/team/tool");
    expect(searchRepos("unsafeoutput")[0]!.remote_url).toBe("git.example.test/team/tool");
    expect(searchAll("unsafeoutput")[0]!.snippet).toBe("git.example.test/team/tool");
    expect(JSON.stringify({ list: listRepos(), repo: getRepo("unsafeoutput"), search: searchAll("unsafeoutput") }))
      .not.toContain(unsafe);
  });

  it("clears rejected repository remotes instead of preserving contaminated values", () => {
    const repo = upsertRepo({ path: "/tmp/rejected", name: "rejected", remote_url: "github.com/team/tool" });
    const updated = upsertRepo({ path: repo.path, name: repo.name, remote_url: "file:///tmp/tool" });
    expect(updated.remote_url).toBeNull();
    expect(db.query("SELECT remote_url FROM repos WHERE id = ?").get(repo.id)).toEqual({ remote_url: null });
  });
});

describe("commits", () => {
  it("should bulk insert commits", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    const count = bulkInsertCommits([
      { repo_id: repo.id, sha: "abc123", author_name: "Test", author_email: "test@test.com", date: "2026-01-01T00:00:00Z", message: "initial commit", files_changed: 1, insertions: 10, deletions: 0 },
      { repo_id: repo.id, sha: "def456", author_name: "Test", author_email: "test@test.com", date: "2026-01-02T00:00:00Z", message: "add feature", files_changed: 2, insertions: 20, deletions: 5 },
    ]);
    expect(count).toBe(2);
  });

  it("should ignore duplicate commits", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertCommits([
      { repo_id: repo.id, sha: "abc123", author_name: "Test", author_email: "test@test.com", date: "2026-01-01T00:00:00Z", message: "initial", files_changed: 0, insertions: 0, deletions: 0 },
    ]);
    const count = bulkInsertCommits([
      { repo_id: repo.id, sha: "abc123", author_name: "Test", author_email: "test@test.com", date: "2026-01-01T00:00:00Z", message: "initial", files_changed: 0, insertions: 0, deletions: 0 },
    ]);
    expect(count).toBe(0);
  });

  it("should list commits with filters", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertCommits([
      { repo_id: repo.id, sha: "a1", author_name: "Alice", author_email: "alice@test.com", date: "2026-01-01T00:00:00Z", message: "fix bug", files_changed: 1, insertions: 1, deletions: 1 },
      { repo_id: repo.id, sha: "b2", author_name: "Bob", author_email: "bob@test.com", date: "2026-02-01T00:00:00Z", message: "add feature", files_changed: 3, insertions: 50, deletions: 0 },
    ]);
    expect(listCommits({ repo_id: repo.id }).length).toBe(2);
    expect(listCommits({ author: "alice" }).length).toBe(1);
    expect(listCommits({ since: "2026-01-15" }).length).toBe(1);
  });

  it("should search commits via FTS5", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertCommits([
      { repo_id: repo.id, sha: "a1", author_name: "Alice", author_email: "alice@test.com", date: "2026-01-01T00:00:00Z", message: "fix critical authentication bug", files_changed: 1, insertions: 1, deletions: 1 },
      { repo_id: repo.id, sha: "b2", author_name: "Bob", author_email: "bob@test.com", date: "2026-01-02T00:00:00Z", message: "update README", files_changed: 1, insertions: 5, deletions: 2 },
    ]);
    const results = searchCommits("authentication");
    expect(results.length).toBe(1);
    expect(results[0]!.sha).toBe("a1");
    expect(results[0]!.repo_name).toBe("test");
  });
});

describe("branches", () => {
  it("should bulk insert branches", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    const count = bulkInsertBranches([
      { repo_id: repo.id, name: "main", is_remote: false, last_commit_sha: "abc", last_commit_date: "2026-01-01", ahead: 0, behind: 0 },
      { repo_id: repo.id, name: "origin/main", is_remote: true, last_commit_sha: "abc", last_commit_date: "2026-01-01", ahead: 0, behind: 0 },
    ]);
    expect(count).toBe(2);
  });

  it("should filter branches by remote/local", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertBranches([
      { repo_id: repo.id, name: "main", is_remote: false, last_commit_sha: null, last_commit_date: null, ahead: 0, behind: 0 },
      { repo_id: repo.id, name: "origin/main", is_remote: true, last_commit_sha: null, last_commit_date: null, ahead: 0, behind: 0 },
    ]);
    expect(listBranches({ repo_id: repo.id, is_remote: false }).length).toBe(1);
    expect(listBranches({ repo_id: repo.id, is_remote: true }).length).toBe(1);
  });
});

describe("tags", () => {
  it("should bulk insert tags", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    const count = bulkInsertTags([
      { repo_id: repo.id, name: "v1.0.0", sha: "abc", date: "2026-01-01", message: "release 1.0" },
      { repo_id: repo.id, name: "v1.1.0", sha: "def", date: "2026-02-01", message: "release 1.1" },
    ]);
    expect(count).toBe(2);
  });

  it("should list tags by repo", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertTags([
      { repo_id: repo.id, name: "v1.0.0", sha: "abc", date: "2026-01-01", message: null },
    ]);
    expect(listTags({ repo_id: repo.id }).length).toBe(1);
  });
});

describe("remotes", () => {
  it("should bulk insert remotes", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    const count = bulkInsertRemotes([
      { repo_id: repo.id, name: "origin", url: "git@github.com:test/test.git", fetch_url: "git@github.com:test/test.git" },
    ]);
    expect(count).toBe(1);
    expect(listRemotes(repo.id).length).toBe(1);
  });

  it("sanitizes remote rows and removes rejected required URLs at write and read boundaries", () => {
    const repo = upsertRepo({ path: "/tmp/remote-boundary", name: "remote-boundary" });
    const unsafe = `ssh://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    db.query("INSERT INTO remotes (repo_id, name, url, fetch_url) VALUES (?, 'origin', ?, ?)")
      .run(repo.id, unsafe, unsafe);
    db.query("INSERT INTO remotes (repo_id, name, url) VALUES (?, 'local', 'file:///tmp/tool')").run(repo.id);

    expect(listRemotes(repo.id)).toEqual([expect.objectContaining({
      name: "origin",
      url: "git.example.test/team/tool",
      fetch_url: "git.example.test/team/tool",
    })]);

    expect(bulkInsertRemotes([{ repo_id: repo.id, name: "origin", url: "/tmp/tool", fetch_url: null }])).toBe(0);
    expect(listRemotes(repo.id)).toEqual([]);
  });
});

describe("pull requests", () => {
  it("should bulk insert PRs", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    const count = bulkInsertPullRequests([
      { repo_id: repo.id, number: 1, title: "Add feature", state: "open", author: "alice", created_at: "2026-01-01", updated_at: null, merged_at: null, closed_at: null, url: "", base_branch: "main", head_branch: "feat-1", additions: 10, deletions: 2, changed_files: 3 },
      { repo_id: repo.id, number: 2, title: "Fix bug", state: "merged", author: "bob", created_at: "2026-01-02", updated_at: null, merged_at: "2026-01-03", closed_at: null, url: "", base_branch: "main", head_branch: "fix-1", additions: 5, deletions: 5, changed_files: 1 },
    ]);
    expect(count).toBe(2);
  });

  it("should filter PRs by state", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertPullRequests([
      { repo_id: repo.id, number: 1, title: "Open PR", state: "open", author: "alice", created_at: "2026-01-01", updated_at: null, merged_at: null, closed_at: null, url: "", base_branch: null, head_branch: null, additions: 0, deletions: 0, changed_files: 0 },
      { repo_id: repo.id, number: 2, title: "Merged PR", state: "merged", author: "bob", created_at: "2026-01-02", updated_at: null, merged_at: null, closed_at: null, url: "", base_branch: null, head_branch: null, additions: 0, deletions: 0, changed_files: 0 },
    ]);
    expect(listPullRequests({ state: "open" }).length).toBe(1);
    expect(listPullRequests({ state: "merged" }).length).toBe(1);
  });

  it("should search PRs via FTS5", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertPullRequests([
      { repo_id: repo.id, number: 1, title: "implement OAuth2 authentication", state: "open", author: "alice", created_at: "2026-01-01", updated_at: null, merged_at: null, closed_at: null, url: "", base_branch: null, head_branch: null, additions: 0, deletions: 0, changed_files: 0 },
    ]);
    const results = searchPullRequests("OAuth2");
    expect(results.length).toBe(1);
  });
});

describe("unified search", () => {
  it("should search across entities", () => {
    const repo = upsertRepo({ path: "/tmp/test-platform", name: "test-platform", description: "platform for testing" });
    bulkInsertCommits([
      { repo_id: repo.id, sha: "abc", author_name: "Test", author_email: "test@test.com", date: "2026-01-01T00:00:00Z", message: "setup platform", files_changed: 0, insertions: 0, deletions: 0 },
    ]);
    const results = searchAll("platform");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const types = results.map((r) => r.type);
    expect(types).toContain("repo");
  });
});

describe("stats", () => {
  it("should return global stats", () => {
    upsertRepo({ path: "/tmp/a", name: "a", org: "hasna" });
    upsertRepo({ path: "/tmp/b", name: "b", org: "hasnaxyz" });
    const stats = getGlobalStats();
    expect(stats.total_repos).toBe(2);
    expect(stats.repos_by_org["hasna"]).toBe(1);
    expect(stats.repos_by_org["hasnaxyz"]).toBe(1);
  });

  it("should return repo stats", () => {
    const repo = upsertRepo({ path: "/tmp/test", name: "test" });
    bulkInsertCommits([
      { repo_id: repo.id, sha: "a", author_name: "Alice", author_email: "a@t.com", date: "2026-01-01T00:00:00Z", message: "init", files_changed: 0, insertions: 0, deletions: 0 },
    ]);
    const stats = getRepoStats(repo.id);
    expect(stats.commit_count).toBe(1);
    expect(stats.recent_commits.length).toBe(1);
    expect(stats.top_authors.length).toBe(1);
  });
});
