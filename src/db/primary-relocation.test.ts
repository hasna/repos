import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./database.js";
import {
  PrimaryRelocationError,
  relocatePrimaryRepo,
  sanitizeGitRemoteUrl,
} from "./primary-relocation.js";

let tempDir = "";
let canonicalRoot = "";
const originalHome = process.env["HOME"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createCheckout(name: string, remote: string): { path: string; head: string } {
  const path = join(canonicalRoot, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "repos-test@invalid.example");
  git(path, "config", "user.name", "Repos Test");
  git(path, "remote", "add", "origin", remote);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
  return { path, head: git(path, "rev-parse", "HEAD") };
}

function cloneSource(name: string, targetPath: string, remote: string): string {
  const sourcePath = join(tempDir, "sources", name);
  mkdirSync(join(tempDir, "sources"), { recursive: true });
  execFileSync("git", ["clone", "--no-local", targetPath, sourcePath], { stdio: "pipe" });
  git(sourcePath, "remote", "set-url", "origin", remote);
  git(sourcePath, "config", "user.email", "repos-test@invalid.example");
  git(sourcePath, "config", "user.name", "Repos Test");
  return sourcePath;
}

function insertRepo(options: {
  id: number;
  path: string;
  name: string;
  remote: string;
}): void {
  getDb().query(`INSERT INTO repos (
    id, path, name, org, remote_url, default_branch, description,
    last_scanned, commit_count, branch_count, tag_count
  ) VALUES (?, ?, ?, 'hasna', ?, 'main', 'fixture', '2026-07-14T00:00:00Z', 1, 1, 1)`).run(
    options.id,
    options.path,
    options.name,
    options.remote,
  );
}

function requestFor(options: {
  id?: number;
  source?: string;
  target: string;
  remote: string;
  head: string;
  apply?: boolean;
}) {
  return {
    repoId: options.id ?? 661,
    expectedCurrentPath: options.source ?? `/dev/shm/${options.id ?? 661}`,
    targetPath: options.target,
    expectedRemote: options.remote,
    expectedHead: options.head,
    actor: "test:primary-relocation",
    apply: options.apply,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PrimaryRelocationError);
    expect((error as PrimaryRelocationError).code).toBe(code);
  }
}

beforeEach(() => {
  closeDb();
  tempDir = mkdtempSync(join(tmpdir(), "repos-primary-relocation-"));
  process.env["HOME"] = join(tempDir, "home");
  canonicalRoot = join(process.env["HOME"], ".hasna", "repos", "worktrees");
  mkdirSync(canonicalRoot, { recursive: true });
  process.env["HASNA_REPOS_DB_PATH"] = join(tempDir, "repos.db");
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
  canonicalRoot = "";
});

describe("primary repo relocation", () => {
  it("sanitizes HTTPS, SSH, and credential-bearing remote URLs without retaining credentials", () => {
    expect(sanitizeGitRemoteUrl("https://github.com/hasna/repos.git")).toBe("github.com/hasna/repos");
    expect(sanitizeGitRemoteUrl("git@github.com:hasna/repos.git")).toBe("github.com/hasna/repos");
    expect(sanitizeGitRemoteUrl("https://user:secret@github.com/hasna/repos.git")).toBe("github.com/hasna/repos");
    expect(sanitizeGitRemoteUrl("/home/hasna/accounts")).toBe("");
    expect(sanitizeGitRemoteUrl("../relative/repo")).toBe("");
    expect(sanitizeGitRemoteUrl("https://github-.com/hasna/repos.git")).toBe("");
  });

  it("defaults to a read-only dry run with no audit receipt", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "git@github.com:hasna/accounts.git" });

    const result = relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    }));

    expect(result.applied).toBe(false);
    expect(result.receipt).toBeNull();
    expect(result.after.path).toBe(target.path);
    expect(getDb().query("SELECT path FROM repos WHERE id = 661").get()).toEqual({ path: "/dev/shm/accounts" });
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
  });

  it("atomically updates only the path and preserves all child metadata and foreign keys", () => {
    const target = createCheckout("infinity", "https://github.com/hasna/infinity.git");
    insertRepo({ id: 663, path: "/dev/shm/infinity", name: "infinity", remote: "https://github.com/hasna/infinity.git" });
    const db = getDb();
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (663, 'abc', 'A', 'a@example.invalid', '2026-07-14', 'commit')").run();
    db.query("INSERT INTO branches (repo_id, name) VALUES (663, 'main')").run();
    db.query("INSERT INTO tags (repo_id, name, sha) VALUES (663, 'v1', 'abc')").run();
    db.query("INSERT INTO remotes (repo_id, name, url) VALUES (663, 'origin', 'https://github.com/hasna/infinity.git')").run();
    db.query("INSERT INTO pull_requests (repo_id, number, title, author, created_at) VALUES (663, 1, 'PR', 'A', '2026-07-14')").run();
    const before = db.query("SELECT * FROM repos WHERE id = 663").get();

    const result = relocatePrimaryRepo(requestFor({
      id: 663,
      source: "/dev/shm/infinity",
      target: target.path,
      remote: "github.com/hasna/infinity",
      head: target.head,
      apply: true,
    }));

    expect(result.applied).toBe(true);
    expect(result.receipt?.repo_id).toBe(663);
    expect(result.receipt?.source_state).toBe("missing");
    const after = db.query("SELECT * FROM repos WHERE id = 663").get() as Record<string, unknown>;
    expect(after).toEqual({ ...(before as Record<string, unknown>), path: target.path });
    for (const table of ["commits", "branches", "tags", "remotes", "pull_requests"]) {
      expect(db.query(`SELECT count(*) AS count FROM ${table} WHERE repo_id = 663`).get()).toEqual({ count: 1 });
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const audit = db.query("SELECT * FROM repo_relocation_audit WHERE repo_id = 663").get() as Record<string, unknown>;
    const safeBefore = { ...(before as Record<string, unknown>), remote_url: "github.com/hasna/infinity" };
    const safeAfter = { ...after, remote_url: "github.com/hasna/infinity" };
    expect(JSON.parse(String(audit.before_json))).toEqual(safeBefore);
    expect(JSON.parse(String(audit.after_json))).toEqual(safeAfter);
  });

  it("validates an existing source checkout against the same remote and exact HEAD", () => {
    const target = createCheckout("accounts-target", "https://github.com/hasna/accounts.git");
    const source = cloneSource("accounts-source", target.path, "git@github.com:hasna/accounts.git");
    insertRepo({ id: 661, path: source, name: "accounts", remote: "https://github.com/hasna/accounts.git" });

    const result = relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
      apply: true,
    }));
    expect(result.validation.source_checkout).toBe("matched");
    expect(result.receipt?.source_state).toBe("matched");
    expect(getDb().query("SELECT source_state FROM repo_relocation_audit WHERE repo_id = 661").get()).toEqual({ source_state: "matched" });
  });

  it("rejects divergent, local-remote, and non-Git existing source paths", () => {
    const target = createCheckout("accounts-target", "https://github.com/hasna/accounts.git");
    const source = cloneSource("accounts-source", target.path, "https://github.com/hasna/wrong.git");
    insertRepo({ id: 661, path: source, name: "accounts", remote: "https://github.com/hasna/accounts.git" });

    expectCode(() => relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
      apply: true,
    })), "SOURCE_REMOTE_MISMATCH");

    git(source, "remote", "set-url", "origin", target.path);
    expectCode(() => relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "SOURCE_REMOTE_MISMATCH");

    git(source, "remote", "set-url", "origin", "local/hasna/accounts");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "local/hasna/accounts",
      head: target.head,
    })), "SOURCE_REMOTE_MISMATCH");

    git(source, "remote", "set-url", "origin", "https://github.com/hasna/accounts.git");
    writeFileSync(join(source, "untracked.txt"), "must preserve\n");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "SOURCE_DIRTY");
    rmSync(join(source, "untracked.txt"));

    writeFileSync(join(source, "source-only.txt"), "divergent\n");
    git(source, "add", "source-only.txt");
    git(source, "commit", "-m", "source-only commit");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "SOURCE_HEAD_MISMATCH");

    const nonGit = join(tempDir, "non-git-source");
    mkdirSync(nonGit);
    getDb().query("UPDATE repos SET path = ? WHERE id = 661").run(nonGit);
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: nonGit,
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "SOURCE_NOT_GIT_CHECKOUT");
  });

  it("does not classify inaccessible source paths as missing", () => {
    if (process.platform === "win32") return;
    const target = createCheckout("accounts-target", "https://github.com/hasna/accounts.git");
    const blockedParent = join(tempDir, "blocked-source-parent");
    const source = join(blockedParent, "accounts");
    mkdirSync(source, { recursive: true });
    insertRepo({ id: 661, path: source, name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    chmodSync(blockedParent, 0o000);
    try {
      expectCode(() => relocatePrimaryRepo(requestFor({
        source,
        target: target.path,
        remote: "github.com/hasna/accounts",
        head: target.head,
      })), "SOURCE_NOT_GIT_CHECKOUT");
    } finally {
      chmodSync(blockedParent, 0o700);
    }
  });

  it("never returns or audits credential-bearing remote material", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({
      id: 661,
      path: "/dev/shm/accounts",
      name: "accounts",
      remote: "https://credential-value@github.com/hasna/accounts.git",
    });
    const result = relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
      apply: true,
    }));
    expect(result.before.remote_url).toBe("github.com/hasna/accounts");
    expect(JSON.stringify(result)).not.toContain("credential-value");
    const audit = getDb().query("SELECT before_json, after_json FROM repo_relocation_audit WHERE repo_id = 661").get();
    expect(JSON.stringify(audit)).not.toContain("credential-value");
  });

  it("supports the four Infinity-shaped primary IDs 661-664 without changing identity", () => {
    const fixtures = [
      [661, "accounts"],
      [662, "sandboxes"],
      [663, "infinity"],
      [664, "codewith"],
    ] as const;
    for (const [id, name] of fixtures) {
      const remote = `github.com/hasna/${name}`;
      const target = createCheckout(name, `https://${remote}.git`);
      insertRepo({ id, path: `/dev/shm/${name}`, name, remote: `git@github.com:hasna/${name}.git` });
      const result = relocatePrimaryRepo(requestFor({
        id,
        source: `/dev/shm/${name}`,
        target: target.path,
        remote,
        head: target.head,
        apply: true,
      }));
      expect(result.repo_id).toBe(id);
      expect(getDb().query("SELECT id, path FROM repos WHERE id = ?").get(id)).toEqual({ id, path: target.path });
    }
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 4 });
  });

  it("rejects stale expected paths", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/stale",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "STALE_CURRENT_PATH");
  });

  it("rejects registered-row, checkout-remote, and exact-HEAD mismatches", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/wrong.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "REMOTE_MISMATCH");

    git(target.path, "remote", "set-url", "origin", "https://github.com/hasna/accounts.git");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: "0".repeat(40),
    })), "HEAD_MISMATCH");

    git(target.path, "remote", "set-url", "origin", "/home/hasna/accounts");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "home/hasna/accounts",
      head: target.head,
    })), "REMOTE_MISMATCH");

    getDb().query("UPDATE repos SET remote_url = 'local/hasna/accounts' WHERE id = 661").run();
    git(target.path, "remote", "set-url", "origin", "local/hasna/accounts");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "local/hasna/accounts",
      head: target.head,
    })), "REMOTE_MISMATCH");
  });

  it("does not let public SDK callers override the canonical worktree root", () => {
    const outsideRoot = join(tempDir, "outside", "accounts");
    mkdirSync(outsideRoot, { recursive: true });
    git(outsideRoot, "init", "-b", "main");
    git(outsideRoot, "config", "user.email", "repos-test@invalid.example");
    git(outsideRoot, "config", "user.name", "Repos Test");
    git(outsideRoot, "remote", "add", "origin", "https://github.com/hasna/accounts.git");
    writeFileSync(join(outsideRoot, "README.md"), "# outside\n");
    git(outsideRoot, "add", "README.md");
    git(outsideRoot, "commit", "-m", "initial");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: outsideRoot,
      remote: "github.com/hasna/accounts",
      head: git(outsideRoot, "rev-parse", "HEAD"),
    })), "TARGET_OUTSIDE_ROOT");
  });

  it("rejects dirty or untracked target state despite a matching HEAD", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    writeFileSync(join(target.path, "untracked.txt"), "not part of exact HEAD\n");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "TARGET_DIRTY");
  });

  it("rejects missing targets, duplicate target rows, and duplicate exact names", () => {
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: join(canonicalRoot, "missing"),
      remote: "github.com/hasna/accounts",
      head: "0".repeat(40),
    })), "TARGET_MISSING");

    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: `${target.path}/.`,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "TARGET_NOT_CANONICAL");

    insertRepo({ id: 700, path: target.path, name: "other", remote: "https://github.com/hasna/other.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "TARGET_ALREADY_REGISTERED");

    getDb().query("DELETE FROM repos WHERE id = 700").run();
    const targetAlias = join(tempDir, "target-alias");
    symlinkSync(target.path, targetAlias, "dir");
    insertRepo({ id: 700, path: targetAlias, name: "other", remote: "https://github.com/hasna/other.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "TARGET_ALREADY_REGISTERED");

    getDb().query("DELETE FROM repos WHERE id = 700").run();
    insertRepo({ id: 701, path: "/dev/shm/accounts-copy", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
    })), "AMBIGUOUS_REPO_NAME");
  });

  it("rolls back the path update when audit persistence fails", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    getDb().exec(`CREATE TRIGGER force_relocation_audit_failure
      BEFORE INSERT ON repo_relocation_audit
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);

    expectCode(() => relocatePrimaryRepo(requestFor({
      source: "/dev/shm/accounts",
      target: target.path,
      remote: "github.com/hasna/accounts",
      head: target.head,
      apply: true,
    })), "TRANSACTION_CONFLICT");
    expect(getDb().query("SELECT path FROM repos WHERE id = 661").get()).toEqual({ path: "/dev/shm/accounts" });
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
  });

  it("rejects malformed object IDs and unsafe audit actor values before validation", () => {
    const target = createCheckout("accounts", "https://github.com/hasna/accounts.git");
    insertRepo({ id: 661, path: "/dev/shm/accounts", name: "accounts", remote: "https://github.com/hasna/accounts.git" });
    expectCode(() => relocatePrimaryRepo({
      ...requestFor({
        source: "/dev/shm/accounts",
        target: target.path,
        remote: "github.com/hasna/accounts",
        head: "0".repeat(41),
      }),
    }), "INVALID_REQUEST");
    expectCode(() => relocatePrimaryRepo({
      ...requestFor({
        source: "/dev/shm/accounts",
        target: target.path,
        remote: "github.com/hasna/accounts",
        head: target.head,
      }),
      actor: "unsafe\nactor",
    }), "INVALID_REQUEST");
  });
});
