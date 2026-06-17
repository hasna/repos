import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { bulkInsertBranches, bulkInsertCommits, bulkInsertPullRequests, upsertRepo } from "../db/repos";
import { clearConfigCache } from "./config";
import { getReposStatus } from "./status";

let tempDir = "";

beforeEach(() => {
  closeDb();
  tempDir = join(tmpdir(), `repos-status-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  process.env["HASNA_REPOS_CONFIG_PATH"] = join(tempDir, "private-config.json");
  process.env["HASNA_REPOS_HOOK_QUEUE_PATH"] = join(tempDir, "private-hook-events.tsv");
  writeFileSync(process.env["HASNA_REPOS_CONFIG_PATH"], JSON.stringify({
    workspaceRoots: [join(tempDir, "private-workspace-root")],
    aliases: {
      private: {
        paths: [join(tempDir, "private-workspace-root")],
      },
    },
  }));
  clearConfigCache();
  getDb(":memory:");
});

afterEach(() => {
  closeDb();
  clearConfigCache();
  delete process.env["HASNA_REPOS_DB_PATH"];
  delete process.env["HASNA_REPOS_CONFIG_PATH"];
  delete process.env["HASNA_REPOS_HOOK_QUEUE_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getReposStatus", () => {
  it("reports inventory counts without repo names, paths, branch names, commits, or remote URLs", () => {
    const repo = upsertRepo({
      path: join(tempDir, "private-workspace-root", "secret-repo"),
      name: "secret-repo",
      org: "private-org",
      remote_url: "https://raw-token@github.com/private-org/secret-repo.git",
      last_scanned: "2026-01-01T00:00:00Z",
      commit_count: 1,
      branch_count: 2,
      tag_count: 0,
    });
    bulkInsertBranches([
      {
        repo_id: repo.id,
        name: "main",
        is_remote: false,
        last_commit_sha: "abc123",
        last_commit_date: "2026-01-01T00:00:00Z",
        ahead: 0,
        behind: 0,
      },
      {
        repo_id: repo.id,
        name: "origin/private-feature",
        is_remote: true,
        last_commit_sha: "def456",
        last_commit_date: "2026-01-01T00:00:00Z",
        ahead: 0,
        behind: 0,
      },
    ]);
    bulkInsertCommits([
      {
        repo_id: repo.id,
        sha: "abc123",
        author_name: "Private Person",
        author_email: "person@example.test",
        date: "2026-01-01T00:00:00Z",
        message: "private commit message",
        files_changed: 1,
        insertions: 1,
        deletions: 0,
      },
    ]);
    bulkInsertPullRequests([
      {
        repo_id: repo.id,
        number: 1,
        title: "Private PR title",
        state: "open",
        author: "private-author",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: null,
        merged_at: null,
        closed_at: null,
        url: "https://github.com/private-org/secret-repo/pull/1",
        base_branch: "main",
        head_branch: "private-feature",
        additions: 1,
        deletions: 0,
        changed_files: 1,
      },
    ]);

    const status = getReposStatus("0.0.0-test");

    expect(status).toMatchObject({
      service: "repos",
      schemaVersion: "1.0",
      package: {
        name: "@hasna/repos",
        version: "0.0.0-test",
      },
      workspace: {
        rootCount: 1,
        aliasCount: 1,
      },
      counts: {
        repos: {
          total: 1,
          scanned: 1,
          unscanned: 0,
          withRemote: 1,
          withoutRemote: 0,
          withCredentialLikeRemote: 1,
          orgs: 1,
        },
        commits: 1,
        branches: {
          total: 2,
          local: 1,
          remote: 1,
        },
        pullRequests: {
          total: 1,
          open: 1,
          closed: 0,
          merged: 0,
        },
      },
      health: {
        status: "warn",
        databaseReachable: true,
        hasRepos: true,
        hasCredentialLikeRemoteUrls: true,
      },
      safety: {
        includesRepoNames: false,
        includesRepoPaths: false,
        includesRemoteUrls: false,
        includesBranchNames: false,
        includesCommitMessages: false,
        includesPrivatePaths: false,
        statusOutputIsMetadataOnly: true,
      },
    });

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(tempDir);
    expect(serialized).not.toContain("secret-repo");
    expect(serialized).not.toContain("private-org");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("github.com/private-org");
    expect(serialized).not.toContain("origin/private-feature");
    expect(serialized).not.toContain("private commit message");
    expect(serialized).not.toContain("Private PR title");
  });
});
