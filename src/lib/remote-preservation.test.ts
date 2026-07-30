import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import { readRemoteIdentity, scanRepos } from "./scanner.js";
import { getRepo } from "../db/repos.js";

// Temp dir, not checkout-relative — see scanner.test.ts: fixtures under a
// worktrees path segment would be refused by the derived-checkout admission gate.
const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), "repos-remote-preservation-test-")));

function createRepoWithOrigin(name: string, origin: string): string {
  const repoPath = join(TEST_DIR, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  execSync(`git remote add origin ${origin}`, { cwd: repoPath, stdio: "pipe" });
  writeFileSync(join(repoPath, "file.txt"), "content");
  execSync("git add .", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: repoPath, stdio: "pipe" });
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
  delete process.env["HASNA_REPOS_DB_PATH"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readRemoteIdentity", () => {
  it("reports a readable origin as supplied", () => {
    const path = createRepoWithOrigin("has-origin", "https://github.com/hasna/emails.git");
    expect(readRemoteIdentity(path)).toEqual({ supplied: true, remoteUrl: "github.com/hasna/emails" });
  });

  it("reports a repo with no origin as supplied-but-empty rather than unreadable", () => {
    const path = join(TEST_DIR, "no-origin");
    mkdirSync(path, { recursive: true });
    execSync("git init", { cwd: path, stdio: "pipe" });
    // `git remote get-url origin` exits non-zero when there is no origin, which
    // is indistinguishable from an unreadable repo — both must be "not supplied".
    expect(readRemoteIdentity(path)).toEqual({ supplied: false, remoteUrl: null });
  });

  it("reports an unreadable git directory as not supplied", () => {
    const path = createRepoWithOrigin("gutted", "https://github.com/hasna/emails.git");
    // Reproduce the live failure mode: a .git directory that exists but has
    // lost its config, so git refuses to treat it as a repository at all.
    rmSync(join(path, ".git", "config"), { force: true });
    rmSync(join(path, ".git", "HEAD"), { force: true });
    expect(readRemoteIdentity(path)).toEqual({ supplied: false, remoteUrl: null });
  });

  it("never inherits an ancestor repository's remote", () => {
    // `git -C <path>` searches upwards, so a directory whose .git is present but
    // unusable answers with the enclosing project's remote. Stamping a parent's
    // identity onto a child would silently mis-attribute all of its pull
    // requests to the wrong GitHub repository.
    const parent = createRepoWithOrigin("parent", "https://github.com/hasna/parent.git");
    const child = join(parent, "nested");
    mkdirSync(join(child, ".git", "hooks"), { recursive: true });

    expect(readRemoteIdentity(child)).toEqual({ supplied: false, remoteUrl: null });
    expect(readRemoteIdentity(parent)).toEqual({ supplied: true, remoteUrl: "github.com/hasna/parent" });
  });

  it("reports a rejected remote as supplied with a null identity", () => {
    const path = createRepoWithOrigin("unsupported", "/srv/local/mirror.git");
    // git can read it, we simply refuse to trust it — that IS a claim, and it
    // must clear any previously indexed identity.
    expect(readRemoteIdentity(path)).toEqual({ supplied: true, remoteUrl: null });
  });
});

describe("rescanning an unreadable checkout", () => {
  it("keeps the indexed remote when git can no longer be read", async () => {
    const path = createRepoWithOrigin("preserved", "https://github.com/hasna/banking.git");
    await scanRepos([TEST_DIR], { full: true });
    expect(getRepo(path)!.remote_url).toBe("github.com/hasna/banking");

    // Gut the .git directory the way the live workspace was gutted, then
    // rescan. The identity must survive: failing to read a remote is missing
    // information, not evidence the repository lost its remote.
    renameSync(join(path, ".git"), join(path, ".git-broken"));
    mkdirSync(join(path, ".git"), { recursive: true });
    mkdirSync(join(path, ".git", "hooks"), { recursive: true });

    await scanRepos([TEST_DIR], { full: true });
    expect(getRepo(path)!.remote_url).toBe("github.com/hasna/banking");
    expect(getRepo(path)!.org).toBe("hasna");
  });

  it("still clears the remote when git reports one we refuse to trust", async () => {
    const path = createRepoWithOrigin("downgraded", "https://github.com/hasna/banking.git");
    await scanRepos([TEST_DIR], { full: true });
    expect(getRepo(path)!.remote_url).toBe("github.com/hasna/banking");

    execSync("git remote set-url origin /srv/local/mirror.git", { cwd: path, stdio: "pipe" });
    await scanRepos([TEST_DIR], { full: true });
    expect(getRepo(path)!.remote_url).toBeNull();
  });
});
