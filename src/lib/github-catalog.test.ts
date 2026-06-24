import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGithubCatalogFilter,
  enumerateGithubRepoCatalog,
  extractGithubFullNameFromRemote,
  syncGithubRepoCatalog,
} from "./github-catalog";
import type { Repo } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-catalog-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(path: string, remoteUrl: string): Repo {
  return {
    id: 1,
    path,
    name: "repos",
    org: "hasna",
    remote_url: remoteUrl,
    default_branch: "main",
    description: null,
    last_scanned: null,
    commit_count: 0,
    branch_count: 0,
    tag_count: 0,
    created_at: "2026-06-24T00:00:00.000Z",
    updated_at: "2026-06-24T00:00:00.000Z",
  };
}

function repoPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: { login: "hasna", type: "Organization", html_url: "https://github.com/hasna" },
    name: "repos",
    full_name: "hasna/repos",
    default_branch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    fork: false,
    topics: ["open-loops", "sdk"],
    description: "Repository catalog",
    html_url: "https://github.com/hasna/repos",
    clone_url: "https://github.com/hasna/repos.git",
    ssh_url: "git@github.com:hasna/repos.git",
    pushed_at: "2026-06-24T05:00:00Z",
    updated_at: "2026-06-24T05:01:00Z",
    created_at: "2026-06-20T05:00:00Z",
    language: "TypeScript",
    ...overrides,
  };
}

function isPage(endpoint: string, page: number): boolean {
  return new URL(endpoint, "https://api.github.test").searchParams.get("page") === String(page);
}

function gitRunner(_repoPath: string, args: string[]): string {
  const key = args.join(" ");
  if (key === "symbolic-ref --short HEAD") return "main";
  if (key === "rev-parse --abbrev-ref --symbolic-full-name @{u}") return "origin/main";
  if (key === "rev-list --left-right --count HEAD...@{u}") return "2\t1";
  if (key === "status --porcelain=v1") return " M src/index.ts\n?? notes.md";
  if (key === "rev-parse HEAD") return "abcdef1234567890";
  return "";
}

describe("github catalog SDK", () => {
  test("syncs a stable JSON cache with local package and branch metadata", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", "package.json"), JSON.stringify({ name: "@hasna/repos", packageManager: "bun@1.2.0" }));
    const cachePath = join(dir, "github-catalog.json");
    const localRepos = [makeRepo(join(dir, "repo"), "https://token-value@github.com/hasna/repos.git")];
    const endpoints: string[] = [];
    const requestJson = (endpoint: string): unknown => {
      endpoints.push(endpoint);
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 4999, used: 1, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User", html_url: "https://github.com/hasna" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [{ login: "hasna", html_url: "https://github.com/hasna" }];
      if (isPage(endpoint, 1)) return [repoPayload()];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    const cache = syncGithubRepoCatalog({
      cachePath,
      maxPages: 1,
      pageSize: 100,
      localRepos,
      requestJson,
      git: gitRunner,
      now: new Date("2026-06-24T06:00:00.000Z"),
    });

    expect(cache.completed).toBe(true);
    expect(cache.repositories).toHaveLength(1);
    expect(cache.repositories[0]!.full_name).toBe("hasna/repos");
    expect(cache.repositories[0]!.package_hints.package_scope).toBe("@hasna");
    expect(cache.repositories[0]!.local?.dirty).toBe(true);
    expect(cache.repositories[0]!.local?.ahead).toBe(2);
    expect(cache.repositories[0]!.loop.tags).toContain("language:typescript");
    expect(cache.repositories[0]!.loop.tags).toContain("scope:hasna");
    expect(readFileSync(cachePath, "utf-8")).not.toContain("token-value");
    expect(endpoints.some((endpoint) => endpoint.startsWith("/user/repos"))).toBe(true);
  });

  test("enumerates cached records with OpenLoops filters and pagination", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const requestJson = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 100, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [];
      if (isPage(endpoint, 1)) {
        return [
          repoPayload(),
          repoPayload({
            owner: { login: "other", type: "Organization" },
            name: "api",
            full_name: "other/api",
            language: "Go",
            topics: ["backend"],
            private: false,
            visibility: "public",
          }),
        ];
      }
      if (isPage(endpoint, 2)) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    syncGithubRepoCatalog({ cachePath, pageSize: 2, requestJson, includeLocal: false });

    const envelope = enumerateGithubRepoCatalog({
      cachePath,
      includeLocal: false,
      limit: 1,
      offset: 0,
      filter: { org: "hasna", language: "TypeScript", tags: ["open-loops"] },
      now: new Date("2026-06-24T06:30:00.000Z"),
    });

    expect(envelope.schemaVersion).toBe("open-repos.github-catalog.v1");
    expect(envelope.page.total).toBe(1);
    expect(envelope.page.count).toBe(1);
    expect(envelope.repositories[0]!.full_name).toBe("hasna/repos");
    expect(envelope.source.cacheExists).toBe(true);
  });

  test("reports missing cache as unsynced and stale", () => {
    const dir = tempDir();
    const envelope = enumerateGithubRepoCatalog({
      cachePath: join(dir, "missing-catalog.json"),
      includeLocal: false,
      now: new Date("2026-06-24T06:30:00.000Z"),
    });

    expect(envelope.source.cacheExists).toBe(false);
    expect(envelope.source.cacheSyncedAt).toBeNull();
    expect(envelope.source.staleAt).toBeNull();
    expect(envelope.source.stale).toBe(true);
    expect(envelope.warnings[0]).toContain("No github-catalog cache found");
  });

  test("resumes from nextCursor and preserves cached records", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const requestJson = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 100, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [];
      if (isPage(endpoint, 1)) return [repoPayload({ name: "one", full_name: "hasna/one" })];
      if (isPage(endpoint, 2)) return [repoPayload({ name: "two", full_name: "hasna/two" })];
      if (isPage(endpoint, 3)) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    const partial = syncGithubRepoCatalog({ cachePath, pageSize: 1, maxPages: 1, requestJson, includeLocal: false });
    expect(partial.completed).toBe(false);
    expect(partial.nextCursor).toBe("2");

    const resumed = syncGithubRepoCatalog({ cachePath, pageSize: 1, maxPages: 2, resume: true, requestJson, includeLocal: false });
    expect(resumed.completed).toBe(true);
    expect(resumed.repositories.map((repo) => repo.full_name)).toEqual(["hasna/one", "hasna/two"]);
  });

  test("resume on a completed cache does not restart page one or mark it partial", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const initialRequest = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 100, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [];
      if (isPage(endpoint, 1)) return [repoPayload()];
      if (isPage(endpoint, 2)) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    syncGithubRepoCatalog({ cachePath, pageSize: 1, maxPages: 2, requestJson: initialRequest, includeLocal: false });

    const endpoints: string[] = [];
    const resumeRequest = (endpoint: string): unknown => {
      endpoints.push(endpoint);
      throw new Error(`resume should not call ${endpoint}`);
    };

    const resumed = syncGithubRepoCatalog({ cachePath, resume: true, maxPages: 1, requestJson: resumeRequest, includeLocal: false });
    expect(resumed.completed).toBe(true);
    expect(resumed.nextCursor).toBeNull();
    expect(resumed.repositories).toHaveLength(1);
    expect(endpoints).toEqual([]);
  });

  test("returns cached data instead of syncing when rate limit is below the floor", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const highLimitRequest = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 100, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [];
      if (isPage(endpoint, 1)) return [repoPayload()];
      if (isPage(endpoint, 2)) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    syncGithubRepoCatalog({ cachePath, pageSize: 1, maxPages: 2, requestJson: highLimitRequest, includeLocal: false });

    const endpoints: string[] = [];
    const lowLimitRequest = (endpoint: string): unknown => {
      endpoints.push(endpoint);
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 0, used: 5000, reset: 1782288000 } } };
      }
      throw new Error(`should not call ${endpoint}`);
    };

    const cache = syncGithubRepoCatalog({ cachePath, requestJson: lowLimitRequest, includeLocal: false, minRemaining: 1 });
    expect(cache.repositories).toHaveLength(1);
    expect(cache.warnings[cache.warnings.length - 1]).toContain("rate limit remaining");
    expect(endpoints).toEqual(["rate_limit"]);
  });

  test("preflights planned calls against the rate-limit safety floor", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const requestJson = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 2, used: 4998, reset: 1782288000 } } };
      }
      throw new Error(`should not call ${endpoint}`);
    };

    expect(() => syncGithubRepoCatalog({ cachePath, maxPages: 1, requestJson, includeLocal: false, minRemaining: 1 }))
      .toThrow("cannot preserve safety floor");
  });

  test("paginates GitHub organization account discovery", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ login: `org-${index}`, html_url: `https://github.com/org-${index}` }));
    const requestJson = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 500, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return firstPage;
      if (endpoint === "/user/orgs?per_page=100&page=2") return [{ login: "extra-org", html_url: "https://github.com/extra-org" }];
      if (isPage(endpoint, 1)) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    const cache = syncGithubRepoCatalog({ cachePath, pageSize: 100, maxPages: 1, requestJson, includeLocal: false });
    expect(cache.accounts.some((account) => account.login === "extra-org")).toBe(true);
    expect(cache.accounts.length).toBe(102);
  });

  test("rejects malformed repository pages and parses credential remotes without retaining secrets", () => {
    const dir = tempDir();
    const cachePath = join(dir, "github-catalog.json");
    const requestJson = (endpoint: string): unknown => {
      if (endpoint === "rate_limit") {
        return { resources: { core: { limit: 5000, remaining: 100, used: 10, reset: 1782288000 } } };
      }
      if (endpoint === "user") return { login: "hasna", type: "User" };
      if (endpoint === "/user/orgs?per_page=100&page=1") return [];
      if (isPage(endpoint, 1)) return { message: "not an array" };
      throw new Error(`unexpected endpoint ${endpoint}`);
    };

    expect(() => syncGithubRepoCatalog({ cachePath, requestJson, includeLocal: false })).toThrow("non-array");
    expect(extractGithubFullNameFromRemote("https://x-access-token:secret@github.com/hasna/repos.git")).toBe("hasna/repos");
    expect(
      applyGithubCatalogFilter([
        {
          account: "hasna",
          account_type: "Organization",
          org: "hasna",
          name: "archived",
          full_name: "hasna/archived",
          default_branch: "main",
          visibility: "private",
          private: true,
          archived: true,
          disabled: false,
          fork: false,
          topics: [],
          description: null,
          html_url: null,
          clone_urls: { https: null, ssh: null },
          pushed_at: null,
          updated_at: null,
          created_at: null,
          primary_language: null,
          package_hints: { ecosystem: null, package_manager: null, package_name: null, package_scope: null, manifests: [] },
          local: null,
          loop: { labels: [], tags: [] },
          sync: {
            github_synced_at: "2026-06-24T00:00:00.000Z",
            local_checked_at: null,
            stale_at: "2026-06-24T01:00:00.000Z",
          },
        },
      ]),
    ).toHaveLength(0);
  });
});
