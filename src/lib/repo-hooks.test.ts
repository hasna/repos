import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeDanglingCheckouts, resolveGitDirDetailed } from "../index";
import type { GitDirResolution } from "../index";
import {
  HOOK_MARKER_START,
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
  it("exports detailed resolution from the package root", () => {
    const bare = join(TEST_DIR, "public-resolution");
    mkdirSync(bare, { recursive: true });

    const resolution: GitDirResolution = resolveGitDirDetailed(bare);

    expect(resolution).toEqual({ status: "missing_git_dir" });
  });

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
    writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/main\n"); // as a real submodule gitdir has
    const consumer = join(TEST_DIR, "relative-consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, ".git"), "gitdir: ../relative-target/.git\n");

    expect(resolveGitDir(consumer)).toBe(resolve(realGitDir));
  });

  it("returns the .git directory itself for an ordinary checkout", () => {
    const repoPath = createTestRepo("ordinary-repo");
    expect(resolveGitDir(repoPath)).toBe(join(repoPath, ".git"));
  });

  it("returns null for a pointer to an ordinary directory that is not a git dir", () => {
    // `gitdir: ../innocent` resolves to a real directory that is not a repository. Existence is
    // not gitness — without this check an arbitrary directory acquires a hooks/ tree.
    const innocent = join(TEST_DIR, "innocent");
    mkdirSync(join(innocent, "subdir"), { recursive: true });
    const traversal = join(TEST_DIR, "traversal-consumer");
    mkdirSync(traversal, { recursive: true });
    writeFileSync(join(traversal, ".git"), "gitdir: ../innocent\n");

    expect(resolveGitDir(traversal)).toBeNull();
    expect(installPostCommitHook(traversal).status).toBe("skipped");
    expect(existsSync(join(innocent, "hooks"))).toBe(false);
  });

  it("returns null for a husk .git holding only hooks/ and worktrees/", () => {
    // The shape this bug already left on disk. Re-touching one rewrites the mtimes that date
    // whatever emptied it, so it must not be treated as a repository either.
    const husk = join(TEST_DIR, "husk-repo");
    mkdirSync(join(husk, ".git", "hooks"), { recursive: true });
    mkdirSync(join(husk, ".git", "worktrees"), { recursive: true });

    expect(resolveGitDir(husk)).toBeNull();
    expect(installPostCommitHook(husk).status).toBe("skipped");
    expect(existsSync(join(husk, ".git", "hooks", "post-commit"))).toBe(false);
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

  it("isolates a failing repo so the rest of the batch still installs", () => {
    // The non-recursive mkdir turns a gitdir that vanishes mid-run into a throw. In the watcher
    // that throw would escape the fs.watch callback, so it must not leave the loop.
    const blocked = join(TEST_DIR, "blocked-repo");
    const blockedGitDir = join(TEST_DIR, "blocked-gitdir");
    mkdirSync(blockedGitDir, { recursive: true });
    writeFileSync(join(blockedGitDir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, ".git"), `gitdir: ${blockedGitDir}\n`);
    chmodSync(blockedGitDir, 0o500); // read+execute only: mkdir inside it fails with EACCES

    const healthy = createTestRepo("after-the-failure");
    let summary;
    try {
      summary = installPostCommitHooks([blocked, healthy], process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]!);
    } finally {
      // Restore even if the call throws, or the unwritable dir breaks cleanup for every later test.
      chmodSync(blockedGitDir, 0o700);
    }

    expect(summary.results[0]!.status).toBe("skipped");
    expect(summary.results[0]!.reason).toBe("install_failed");
    expect(summary.installed).toBe(1);
    expect(existsSync(join(healthy, ".git", "hooks", "post-commit"))).toBe(true);
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
