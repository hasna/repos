import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { scanRepos } from "./scanner";
import { listRepos, listCommits, listBranches, listTags } from "../db/repos";

const TEST_DIR = join(import.meta.dir, "../../.test-repos");

function createTestRepo(name: string, commits = 1): string {
  const repoPath = join(TEST_DIR, name);
  mkdirSync(repoPath, { recursive: true });
  execSync(`git init`, { cwd: repoPath, stdio: "pipe" });
  execSync(`git config user.email "test@test.com"`, { cwd: repoPath, stdio: "pipe" });
  execSync(`git config user.name "Test User"`, { cwd: repoPath, stdio: "pipe" });

  for (let i = 0; i < commits; i++) {
    writeFileSync(join(repoPath, `file-${i}.txt`), `content ${i}`);
    execSync(`git add .`, { cwd: repoPath, stdio: "pipe" });
    execSync(`git commit -m "commit ${i}"`, { cwd: repoPath, stdio: "pipe" });
  }

  return repoPath;
}

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env["HASNA_REPOS_DB_PATH"];
});

describe("scanner", () => {
  it("should discover repos in a directory", async () => {
    createTestRepo("repo-a", 2);
    createTestRepo("repo-b", 1);
    const result = await scanRepos([TEST_DIR]);
    expect(result.repos_found).toBe(2);
    expect(result.repos_new).toBe(2);
  });

  it("should index commits from discovered repos", async () => {
    createTestRepo("repo-with-commits", 3);
    await scanRepos([TEST_DIR]);
    const repos = listRepos();
    expect(repos.length).toBe(1);
    const commits = listCommits({ repo_id: repos[0]!.id });
    expect(commits.length).toBe(3);
  });

  it("should index branches", async () => {
    const repoPath = createTestRepo("repo-with-branch", 1);
    execSync(`git checkout -b feature-branch`, { cwd: repoPath, stdio: "pipe" });
    writeFileSync(join(repoPath, "feature.txt"), "feature");
    execSync(`git add . && git commit -m "feature commit"`, { cwd: repoPath, stdio: "pipe" });

    await scanRepos([TEST_DIR]);
    const repos = listRepos();
    const branches = listBranches({ repo_id: repos[0]!.id });
    expect(branches.length).toBeGreaterThanOrEqual(2);
  });

  it("should index tags", async () => {
    const repoPath = createTestRepo("repo-with-tag", 1);
    execSync(`git tag v1.0.0`, { cwd: repoPath, stdio: "pipe" });

    await scanRepos([TEST_DIR]);
    const repos = listRepos();
    const tags = listTags({ repo_id: repos[0]!.id });
    expect(tags.length).toBe(1);
    expect(tags[0]!.name).toBe("v1.0.0");
  });

  it("should report scan duration", async () => {
    createTestRepo("timing-test", 1);
    const result = await scanRepos([TEST_DIR]);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it("should skip non-git directories", async () => {
    mkdirSync(join(TEST_DIR, "not-a-repo"), { recursive: true });
    writeFileSync(join(TEST_DIR, "not-a-repo", "file.txt"), "test");
    createTestRepo("real-repo", 1);

    const result = await scanRepos([TEST_DIR]);
    expect(result.repos_found).toBe(1);
  });

  it("should skip node_modules", async () => {
    mkdirSync(join(TEST_DIR, "node_modules", "some-pkg"), { recursive: true });
    createTestRepo("actual-repo", 1);

    const result = await scanRepos([TEST_DIR]);
    expect(result.repos_found).toBe(1);
  });

  it("should call onProgress callback", async () => {
    createTestRepo("progress-test", 1);
    const messages: string[] = [];
    await scanRepos([TEST_DIR], { onProgress: (msg) => messages.push(msg) });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("Discovering"))).toBe(true);
    expect(messages.some((m) => m.includes("Found"))).toBe(true);
  });

  it("should handle empty directories", async () => {
    const result = await scanRepos([TEST_DIR]);
    expect(result.repos_found).toBe(0);
  });

  it("should extract repo name from path", async () => {
    createTestRepo("my-awesome-repo", 1);
    await scanRepos([TEST_DIR]);
    const repos = listRepos();
    expect(repos[0]!.name).toBe("my-awesome-repo");
  });

  it("should handle repos with no commits gracefully", async () => {
    const repoPath = join(TEST_DIR, "empty-repo");
    mkdirSync(repoPath, { recursive: true });
    execSync(`git init`, { cwd: repoPath, stdio: "pipe" });

    const result = await scanRepos([TEST_DIR]);
    expect(result.repos_found).toBe(1);
    expect(result.commits_indexed).toBe(0);
  });

  it("should set default branch", async () => {
    createTestRepo("branch-check", 1);
    await scanRepos([TEST_DIR]);
    const repos = listRepos();
    expect(repos[0]!.default_branch).toBeTruthy();
  });
});
