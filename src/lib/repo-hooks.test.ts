import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HOOK_MARKER_START,
  describeDanglingCheckouts,
  drainHookQueue,
  installPostCommitHook,
  installPostCommitHooks,
  resolveGitDir,
} from "./repo-hooks";

const TEST_DIR = join(import.meta.dir, "../../.test-hooks");

function createTestRepo(name: string): string {
  const repoPath = join(TEST_DIR, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# test");
  execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
  return repoPath;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["HASNA_REPOS_HOOK_QUEUE_PATH"] = join(TEST_DIR, "hook-events.tsv");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env["HASNA_REPOS_HOOK_QUEUE_PATH"];
});

describe("resolveGitDir", () => {
  it("returns null and fabricates nothing when the .git file points at a missing gitdir", () => {
    // An orphan worktree: the checkout survives, but the repository it belonged to is gone.
    const goneRepo = join(TEST_DIR, "gone-repo");
    const orphan = join(TEST_DIR, "orphan-worktree");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, ".git"), `gitdir: ${join(goneRepo, ".git", "worktrees", "orphan")}\n`);

    expect(existsSync(goneRepo)).toBe(false);

    expect(resolveGitDir(orphan)).toBeNull();

    // The real assertion: resolving a dangling pointer must not bring the repo into existence.
    expect(existsSync(goneRepo)).toBe(false);
  });

  it("resolves an absolute pointer to a gitdir that exists", () => {
    const mainRepo = createTestRepo("pointer-main");
    const linked = join(TEST_DIR, "pointer-worktree");
    execSync(`git worktree add ${linked} -b pointer-branch`, { cwd: mainRepo, stdio: "pipe" });

    // A live worktree's .git is a FILE holding a gitdir: pointer — the same branch the
    // dangling case takes. If this returns null the guard is too broad.
    expect(resolveGitDir(linked)).toBe(resolve(mainRepo, ".git", "worktrees", "pointer-worktree"));
  });

  it("resolves a relative pointer to a gitdir that exists", () => {
    const realGitDir = join(TEST_DIR, "relative-target", ".git");
    mkdirSync(realGitDir, { recursive: true });
    const consumer = join(TEST_DIR, "relative-consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, ".git"), "gitdir: ../relative-target/.git\n");

    expect(resolveGitDir(consumer)).toBe(resolve(realGitDir));
  });

  it("returns the .git directory itself for an ordinary checkout", () => {
    const repoPath = createTestRepo("ordinary-repo");
    expect(resolveGitDir(repoPath)).toBe(join(repoPath, ".git"));
  });

  it("returns null for a directory that has no .git at all", () => {
    const bare = join(TEST_DIR, "no-git-here");
    mkdirSync(bare, { recursive: true });
    expect(resolveGitDir(bare)).toBeNull();
  });
});

describe("repo-hooks", () => {
  it("skips a dangling worktree pointer without creating any directory", () => {
    const goneRepo = join(TEST_DIR, "hook-gone-repo");
    const orphan = join(TEST_DIR, "hook-orphan-worktree");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, ".git"), `gitdir: ${join(goneRepo, ".git", "worktrees", "orphan")}\n`);

    const result = installPostCommitHook(orphan);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dangling_git_dir");
    expect(result.hookPath).toBeNull();

    // The bug this covers: mkdirSync(..., { recursive: true }) used to fabricate the whole
    // chain — repo root, .git, worktrees/<name>/hooks — inside a directory with no repository,
    // which is what made destroyed checkouts read as present-but-broken ones.
    expect(existsSync(goneRepo)).toBe(false);
  });

  it("skips a repo path that does not exist without creating it", () => {
    const missing = join(TEST_DIR, "not-cloned-yet");

    const result = installPostCommitHook(missing);

    expect(result.status).toBe("skipped");
    expect(result.hookPath).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it("installs into a live worktree whose gitdir exists", () => {
    const mainRepo = createTestRepo("live-main");
    const linked = join(TEST_DIR, "live-worktree");
    execSync(`git worktree add ${linked} -b live-branch`, { cwd: mainRepo, stdio: "pipe" });

    const result = installPostCommitHook(linked);
    const expectedHook = resolve(mainRepo, ".git", "worktrees", "live-worktree", "hooks", "post-commit");

    expect(result.status).toBe("installed");
    expect(result.hookPath).toBe(expectedHook);
    expect(existsSync(expectedHook)).toBe(true);
    expect(readFileSync(expectedHook, "utf-8")).toContain(HOOK_MARKER_START);
  });

  it("reports dangling checkouts instead of silently skipping them", () => {
    const goneRepo = join(TEST_DIR, "reported-gone-repo");
    const orphan = join(TEST_DIR, "reported-orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, ".git"), `gitdir: ${join(goneRepo, ".git", "worktrees", "orphan")}\n`);
    const healthy = createTestRepo("reported-healthy");

    const summary = installPostCommitHooks([healthy, orphan], process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]!);
    const report = describeDanglingCheckouts(summary);

    expect(summary.installed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(report).toContain("reported-orphan");
    expect(report).not.toContain("reported-healthy");
    expect(existsSync(goneRepo)).toBe(false);
  });

  it("has nothing to report when every checkout is healthy", () => {
    const healthy = createTestRepo("all-healthy");
    const summary = installPostCommitHooks([healthy], process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]!);

    expect(describeDanglingCheckouts(summary)).toBeNull();
  });

  it("installs the automation block without clobbering existing hooks", () => {
    const repoPath = createTestRepo("hooked-repo");
    const hookPath = join(repoPath, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho existing-hook\n");

    const result = installPostCommitHook(repoPath);
    const content = readFileSync(hookPath, "utf-8");

    expect(result.status).toBe("updated");
    expect(content).toContain("echo existing-hook");
    expect(content).toContain(HOOK_MARKER_START);
    expect(content).toContain(process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]!);
  });

  it("drains and deduplicates queued repo paths", () => {
    const queuePath = process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]!;
    writeFileSync(queuePath, [
      "2026-04-08T13:00:00Z\t/tmp/repo-a",
      "2026-04-08T13:00:01Z\t/tmp/repo-a",
      "2026-04-08T13:00:02Z\t/tmp/repo-b",
    ].join("\n"));

    const repos = drainHookQueue(queuePath);

    expect(repos).toEqual([
      resolve("/tmp/repo-a"),
      resolve("/tmp/repo-b"),
    ]);
    expect(readFileSync(queuePath, "utf-8")).toBe("");
  });
});
