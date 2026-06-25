import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { listRepos } from "../db/repos";
import { ensureWorkspaceBootstrap } from "./auto-index";
import { HOOK_MARKER_START } from "./repo-hooks";

const TEST_DIR = join(import.meta.dir, "../../.test-auto-index");

function createTestRepo(name: string, commits = 1): string {
  const repoPath = join(TEST_DIR, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });

  for (let i = 0; i < commits; i++) {
    writeFileSync(join(repoPath, `file-${i}.txt`), `content ${i}`);
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync(`git commit -m "commit ${i}"`, { cwd: repoPath, stdio: "pipe" });
  }

  return repoPath;
}

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  process.env["HASNA_REPOS_HOOK_QUEUE_PATH"] = join(TEST_DIR, "hook-events.tsv");
  getDb(":memory:");
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env["HASNA_REPOS_DB_PATH"];
  delete process.env["HASNA_REPOS_HOOK_QUEUE_PATH"];
});

describe("auto-index", () => {
  it("bootstraps a workspace and installs post-commit hooks", async () => {
    const repoPath = createTestRepo("bootstrap-repo", 2);

    const result = await ensureWorkspaceBootstrap([TEST_DIR], { syncStorage: false });
    const hookPath = join(repoPath, ".git", "hooks", "post-commit");

    expect(result.bootstrapped).toBe(true);
    expect(result.scan?.repos_found).toBe(1);
    expect(result.hooks.installed).toBe(1);
    expect(listRepos().length).toBe(1);
    expect(readFileSync(hookPath, "utf-8")).toContain(HOOK_MARKER_START);

    const second = await ensureWorkspaceBootstrap([TEST_DIR], { syncStorage: false });
    expect(second.bootstrapped).toBe(false);
    expect(second.hooks.unchanged).toBe(0);
  });
});
