import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import { bulkInsertCommits, upsertRepo } from "../db/repos.js";

const tempRoots: string[] = [];

function seedDb(): string {
  const root = mkdtempSync(join(tmpdir(), "repos-compact-output-"));
  tempRoots.push(root);
  const dbPath = join(root, "repos.db");

  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = dbPath;
  getDb(dbPath);

  const repo = upsertRepo({
    path: "/tmp/workspaces/very/deep/private/path/alpha-repo",
    name: "alpha-repo",
    org: "hasna",
    remote_url: "git@github.com:hasna/alpha-repo.git",
    default_branch: "main",
    description: "A deliberately long repository description that should not be dumped in compact list output by default because it wastes agent context.",
    commit_count: 2,
    branch_count: 3,
    tag_count: 1,
  });

  bulkInsertCommits([
    {
      repo_id: repo.id,
      sha: "abcdef1234567890",
      author_name: "Alice Example",
      author_email: "alice@example.com",
      date: "2026-06-01T12:00:00Z",
      message: "Implement a very long and detailed commit message that should be shortened in the default human CLI output while remaining intact for JSON consumers",
      files_changed: 4,
      insertions: 120,
      deletions: 8,
    },
  ]);

  upsertRepo({
    path: "/tmp/workspaces/secretrepo",
    name: "secretrepo",
    org: "hasna",
    remote_url: "https://secret-token@github.com/hasna/secretrepo.git",
    default_branch: "main",
    commit_count: 0,
    branch_count: 1,
    tag_count: 0,
  });

  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  return dbPath;
}

function runCli(dbPath: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      HASNA_REPOS_DB_PATH: dbPath,
      NO_COLOR: "1",
    },
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode, stderr).toBe(0);
  return stdout;
}

afterEach(() => {
  closeDb();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("compact CLI output", () => {
  test("repos list is compact by default and discloses details on request", () => {
    const dbPath = seedDb();

    const compact = runCli(dbPath, ["repos", "--query", "alpha", "--limit", "1"]);
    expect(compact).toContain("alpha-repo");
    expect(compact).toContain("2 commits, 3 branches, 1 tags");
    expect(compact).toContain("repos show <name>");
    expect(compact).not.toContain("/tmp/workspaces/very/deep/private/path/alpha-repo");
    expect(compact).not.toContain("deliberately long repository description");

    const verbose = runCli(dbPath, ["repos", "--query", "alpha", "--limit", "1", "--verbose"]);
    expect(verbose).toContain("/tmp/workspaces/very/deep/private/path/alpha-repo");
    expect(verbose).toContain("deliberately long repository description");

    const details = runCli(dbPath, ["show", "alpha-repo"]);
    expect(details).toContain("Path: /tmp/workspaces/very/deep/private/path/alpha-repo");
  });

  test("JSON output preserves full records while human commits truncate by default", () => {
    const dbPath = seedDb();

    const compact = runCli(dbPath, ["commits", "--repo", "alpha-repo", "--limit", "1"]);
    expect(compact).toContain("Implement a very long");
    expect(compact).toContain("...");
    expect(compact).not.toContain("alice@example.com");

    const verbose = runCli(dbPath, ["commits", "--repo", "alpha-repo", "--limit", "1", "--verbose"]);
    expect(verbose).toContain("alice@example.com");
    expect(verbose).toContain("+120/-8");

    const json = JSON.parse(runCli(dbPath, ["commits", "--repo", "alpha-repo", "--limit", "1", "--json"])) as Array<{ message: string; author_email: string }>;
    expect(json[0]!.author_email).toBe("alice@example.com");
    expect(json[0]!.message).toContain("remaining intact for JSON consumers");
  });

  test("compact search output redacts credential-like URL snippets", () => {
    const dbPath = seedDb();

    const compact = runCli(dbPath, ["search", "secretrepo", "--limit", "1"]);
    expect(compact).toContain("secretrepo");
    expect(compact).toContain("https://***@github.com/hasna/secretrepo.git");
    expect(compact).not.toContain("secret-token");
    expect(compact).not.toContain("next page: --cursor");
  });
});
