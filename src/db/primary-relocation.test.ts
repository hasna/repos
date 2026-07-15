import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./database.js";
import {
  PrimaryRelocationError,
  relocatePrimaryRepo,
  sanitizeGitRemoteUrl,
  setPrimaryRelocationCanonicalRootForTests,
  type PrimaryRelocationRequest,
} from "./primary-relocation.js";

let root = "";
let canonicalRoot = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function checkout(name: string, remote = `https://github.com/hasna/${name}.git`) {
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

function linkedCheckout(authorityPath: string, path: string, name: string) {
  mkdirSync(authorityPath, { recursive: true });
  git(authorityPath, "init", "-b", "main");
  git(authorityPath, "config", "user.email", "repos-test@invalid.example");
  git(authorityPath, "config", "user.name", "Repos Test");
  git(authorityPath, "remote", "add", "origin", `https://github.com/hasna/${name}.git`);
  writeFileSync(join(authorityPath, "README.md"), `# ${name}\n`);
  git(authorityPath, "add", "README.md");
  git(authorityPath, "commit", "-m", "initial");
  git(authorityPath, "worktree", "add", "-b", `canonical-${name}`, path, "HEAD");
  return { path, head: git(path, "rev-parse", "HEAD") };
}

function insertRepo(id: number, path: string, name: string, remote = `https://github.com/hasna/${name}.git`) {
  getDb().query(`INSERT INTO repos (
    id, path, name, org, remote_url, default_branch, description,
    last_scanned, commit_count, branch_count, tag_count, updated_at
  ) VALUES (?, ?, ?, 'hasna', ?, 'main', 'fixture', '2026-07-14T00:00:00Z', 0, 0, 0, ?)`)
    .run(id, path, name, remote, `revision-${id}`);
}

function seedPair(options: {
  legacyId?: number;
  targetId?: number;
  name?: string;
  sourcePath?: string;
  target?: { path: string; head: string };
} = {}) {
  const legacyId = options.legacyId ?? 661;
  const targetId = options.targetId ?? 1508;
  const name = options.name ?? "accounts";
  const target = options.target ?? checkout(`${name}-canonical`, `https://github.com/hasna/${name}.git`);
  const sourcePath = options.sourcePath ?? join(root, "source-state-is-never-read", name);
  insertRepo(legacyId, sourcePath, name, `https://legacy-token@github.com/hasna/${name}.git`);
  insertRepo(targetId, target.path, name, `git@github.com:hasna/${name}.git`);
  return { legacyId, targetId, name, sourcePath, ...target };
}

function requestFor(pair: ReturnType<typeof seedPair>, changes: Partial<PrimaryRelocationRequest> = {}): PrimaryRelocationRequest {
  return {
    repoId: pair.legacyId,
    expectedCurrentPath: pair.sourcePath,
    expectedSourceRevision: `revision-${pair.legacyId}`,
    targetRepoId: pair.targetId,
    targetPath: pair.path,
    expectedTargetRevision: `revision-${pair.targetId}`,
    expectedRemote: `github.com/hasna/${pair.name}`,
    expectedHead: pair.head,
    actor: "test:primary-relocation",
    idempotencyKey: `test-${pair.legacyId}-${pair.targetId}`,
    ...changes,
  };
}

function applyReviewed(pair: ReturnType<typeof seedPair>, changes: Partial<PrimaryRelocationRequest> = {}) {
  const request = requestFor(pair, changes);
  const dry = relocatePrimaryRepo(request);
  return { dry, applied: relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash }) };
}

function expectCode(action: () => unknown, code: string): PrimaryRelocationError {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PrimaryRelocationError);
    expect((error as PrimaryRelocationError).code).toBe(code);
    return error as PrimaryRelocationError;
  }
}

function insertChildFixtures(legacyId: number, targetId: number) {
  const db = getDb();
  // Exact duplicate commit; target-only commit; exact duplicate branch; target-only tag/remote/PR.
  for (const repoId of [legacyId, targetId]) {
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'same', 'A', 'a@invalid.example', '2026-07-14', 'same')").run(repoId);
    db.query("INSERT INTO branches (repo_id, name, last_commit_sha) VALUES (?, 'main', 'same')").run(repoId);
  }
  db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'target-only', 'B', 'b@invalid.example', '2026-07-15', 'move')").run(targetId);
  db.query("INSERT INTO tags (repo_id, name, sha) VALUES (?, 'v1', 'target-only')").run(targetId);
  db.query("INSERT INTO remotes (repo_id, name, url) VALUES (?, 'upstream', 'https://credential@github.com/hasna/upstream.git')").run(targetId);
  db.query("INSERT INTO pull_requests (repo_id, number, title, author, created_at) VALUES (?, 7, 'Move', 'A', '2026-07-14')").run(targetId);
}

beforeEach(() => {
  closeDb();
  root = mkdtempSync(join(tmpdir(), "repos-reconcile-v2-"));
  canonicalRoot = join(root, "trusted-home", ".hasna", "repos", "worktrees");
  mkdirSync(canonicalRoot, { recursive: true });
  setPrimaryRelocationCanonicalRootForTests(canonicalRoot);
  process.env["HASNA_REPOS_DB_PATH"] = join(root, "repos.db");
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  setPrimaryRelocationCanonicalRootForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe("primary relocation v2 reconciliation", () => {
  it("sanitizes network remotes and rejects local path identities", () => {
    expect(sanitizeGitRemoteUrl("https://user:secret@github.com/hasna/repos.git")).toBe("github.com/hasna/repos");
    expect(sanitizeGitRemoteUrl("git@github.com:hasna/repos.git")).toBe("github.com/hasna/repos");
    expect(sanitizeGitRemoteUrl("/home/hasna/repos")).toBe("");
    expect(sanitizeGitRemoteUrl("../hasna/repos")).toBe("");
  });

  it("produces a stable, sanitized, read-only plan with per-table decisions", () => {
    const pair = seedPair();
    insertChildFixtures(pair.legacyId, pair.targetId);
    const result = relocatePrimaryRepo(requestFor(pair));
    const again = relocatePrimaryRepo(requestFor(pair));
    expect(result.applied).toBe(false);
    expect(result.plan.plan_hash).toBe(again.plan.plan_hash);
    expect(result.plan.request_hash).toBe(again.plan.request_hash);
    expect(result.plan.counts.commits).toEqual({ legacy: 1, target: 2, move: 1, dedupe: 1, block: 0 });
    expect(result.plan.collisions.every(({ key_hash, target_hash }) => key_hash.length === 64 && target_hash.length === 64)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("legacy-token");
    expect(JSON.stringify(result)).not.toContain("credential@");
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
    expect(getDb().query("SELECT count(*) AS count FROM repos").get()).toEqual({ count: 2 });
  });

  it("atomically dedupes exact rows, moves target-only rows, deletes only target, and updates source counts/revision", () => {
    const pair = seedPair();
    insertChildFixtures(pair.legacyId, pair.targetId);
    const { dry, applied } = applyReviewed(pair);
    expect(applied.plan.plan_hash).toBe(dry.plan.plan_hash);
    expect(getDb().query("SELECT id FROM repos ORDER BY id").all()).toEqual([{ id: pair.legacyId }]);
    const repo = getDb().query("SELECT * FROM repos WHERE id = ?").get(pair.legacyId) as any;
    expect(repo.path).toBe(pair.path);
    expect(repo.updated_at).not.toBe(`revision-${pair.legacyId}`);
    expect([repo.commit_count, repo.branch_count, repo.tag_count]).toEqual([2, 1, 1]);
    for (const table of ["commits", "branches", "tags", "remotes", "pull_requests"]) {
      expect(getDb().query(`SELECT count(*) AS count FROM ${table} WHERE repo_id = ?`).get(pair.targetId)).toEqual({ count: 0 });
    }
    expect(getDb().query("PRAGMA foreign_key_check").all()).toEqual([]);
    const audit = getDb().query("SELECT * FROM repo_relocation_audit").get() as Record<string, unknown>;
    expect(audit.plan_hash).toBe(dry.plan.plan_hash);
    expect(JSON.stringify(audit)).not.toContain("legacy-token");
    expect(JSON.stringify(audit)).not.toContain("credential@");
  });

  it("absorbs canonical target operational metadata while preserving the legacy ID and earliest creation time", () => {
    const pair = seedPair();
    const db = getDb();
    db.query(`UPDATE repos SET
      name = 'stale-accounts', org = 'legacy-org', default_branch = 'develop',
      description = 'legacy description', last_scanned = '2026-06-01T00:00:00Z',
      created_at = '2026-01-01T00:00:00Z'
      WHERE id = ?`).run(pair.legacyId);
    db.query(`UPDATE repos SET
      name = 'accounts', org = 'hasna', default_branch = 'main',
      description = 'canonical description', last_scanned = '2026-07-15T00:00:00Z',
      created_at = '2026-02-01T00:00:00Z'
      WHERE id = ?`).run(pair.targetId);

    const { dry, applied } = applyReviewed(pair);
    expect(dry.before).toMatchObject({ id: pair.legacyId, name: "stale-accounts", created_at: "2026-01-01T00:00:00Z" });
    expect(dry.target).toMatchObject({ id: pair.targetId, name: "accounts", created_at: "2026-02-01T00:00:00Z" });
    expect(dry.after).toMatchObject({ id: pair.legacyId, name: "accounts", created_at: "2026-01-01T00:00:00Z" });
    expect(applied.receipt?.source).toEqual(dry.before);
    expect(applied.receipt?.target).toEqual(dry.target);
    expect(applied.receipt?.after).toEqual(applied.after);
    expect(db.query(`SELECT id, path, name, org, remote_url, default_branch, description,
      last_scanned, created_at FROM repos WHERE id = ?`).get(pair.legacyId)).toEqual({
      id: pair.legacyId,
      path: pair.path,
      name: "accounts",
      org: "hasna",
      remote_url: "git@github.com:hasna/accounts.git",
      default_branch: "main",
      description: "canonical description",
      last_scanned: "2026-07-15T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(JSON.stringify(applied.receipt)).not.toContain("legacy description");
    expect(JSON.stringify(applied.receipt)).not.toContain("canonical description");
  });

  it("allows missing, dirty, divergent, non-Git, and unreadable legacy filesystem state without accessing it", () => {
    const pair = seedPair();
    mkdirSync(pair.sourcePath, { recursive: true });
    writeFileSync(join(pair.sourcePath, "dirty-secret.txt"), "must never be read\n");
    // A symlink loop makes any accidental realpath/stat/Git inspection fail.
    const loop = join(root, "loop");
    symlinkSync(loop, loop);
    getDb().query("UPDATE repos SET path = ? WHERE id = ?").run(loop, pair.legacyId);
    const result = relocatePrimaryRepo(requestFor({ ...pair, sourcePath: loop }));
    expect(result.applied).toBe(false);
    expect(result.before.path).toBe(loop);
  });

  it("reports and blocks divergent logical-key collisions without target-wins behavior", () => {
    const pair = seedPair();
    const db = getDb();
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'same', 'A', 'a@invalid', '2026', 'legacy')").run(pair.legacyId);
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'same', 'A', 'a@invalid', '2026', 'target')").run(pair.targetId);
    const dry = relocatePrimaryRepo(requestFor(pair));
    expect(dry.plan.can_apply).toBe(false);
    const error = expectCode(() => relocatePrimaryRepo({
      ...requestFor(pair),
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "DIVERGENT_COLLISION");
    expect(error.details?.collisions?.[0]).toMatchObject({ table: "commits", decision: "block" });
    expect(JSON.stringify(error.details)).not.toContain("legacy");
    expect(JSON.stringify(error.details)).not.toContain("target\"");
    expect(db.query("SELECT message FROM commits ORDER BY repo_id").all()).toEqual([{ message: "legacy" }, { message: "target" }]);
  });

  it("requires reviewed plan hash and rejects stale plans, row revisions, and row paths", () => {
    const pair = seedPair();
    const request = requestFor(pair);
    const dry = relocatePrimaryRepo(request);
    expectCode(() => relocatePrimaryRepo({ ...request, apply: true }), "PLAN_HASH_REQUIRED");
    getDb().query("INSERT INTO branches (repo_id, name) VALUES (?, 'new-after-review')").run(pair.targetId);
    expectCode(() => relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash }), "PLAN_HASH_MISMATCH");
    expectCode(() => relocatePrimaryRepo({ ...request, expectedTargetRevision: "stale" }), "STALE_TARGET_ROW");
    expectCode(() => relocatePrimaryRepo({ ...request, expectedCurrentPath: join(root, "stale") }), "STALE_LEGACY_ROW");
  });

  it("rejects target remote, HEAD, dirty state, symlink aliases, and path escapes", () => {
    const pair = seedPair();
    git(pair.path, "remote", "set-url", "origin", "https://github.com/hasna/wrong.git");
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "REMOTE_MISMATCH");
    git(pair.path, "remote", "set-url", "origin", `https://github.com/hasna/${pair.name}.git`);
    git(pair.path, "remote", "set-url", "origin", `github.com/hasna/${pair.name}`);
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "REMOTE_MISMATCH");
    git(pair.path, "remote", "set-url", "origin", `https://github.com/hasna/${pair.name}.git`);
    expectCode(() => relocatePrimaryRepo(requestFor(pair, { expectedHead: "0".repeat(40) })), "HEAD_MISMATCH");
    writeFileSync(join(pair.path, "dirty.txt"), "dirty\n");
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_DIRTY");
    rmSync(join(pair.path, "dirty.txt"));

    const alias = join(canonicalRoot, "alias");
    symlinkSync(pair.path, alias, "dir");
    getDb().query("UPDATE repos SET path = ? WHERE id = ?").run(alias, pair.targetId);
    expectCode(() => relocatePrimaryRepo(requestFor({ ...pair, path: alias })), "TARGET_NOT_CANONICAL");

    const escaped = join(root, "outside-checkout");
    mkdirSync(escaped, { recursive: true });
    git(escaped, "init", "-b", "main");
    git(escaped, "config", "user.email", "repos-test@invalid.example");
    git(escaped, "config", "user.name", "Repos Test");
    git(escaped, "remote", "add", "origin", `https://github.com/hasna/${pair.name}.git`);
    writeFileSync(join(escaped, "README.md"), "# escaped\n");
    git(escaped, "add", "README.md");
    git(escaped, "commit", "-m", "escaped");
    getDb().query("UPDATE repos SET path = ? WHERE id = ?").run(escaped, pair.targetId);
    expectCode(() => relocatePrimaryRepo(requestFor({ ...pair, path: escaped, head: git(escaped, "rev-parse", "HEAD") })), "TARGET_OUTSIDE_ROOT");
  });

  it("rejects a canonical-path linked worktree whose Git common directory is outside the trusted root", () => {
    const name = "external-common";
    const target = linkedCheckout(
      join(root, "external-authorities", name),
      join(canonicalRoot, `${name}-canonical`),
      name,
    );
    const pair = seedPair({ name, target });

    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_OUTSIDE_ROOT");
  });

  it("rejects a gitfile that escapes to an external Git directory", () => {
    const pair = seedPair({ name: "gitfile-escape" });
    const externalGitDir = join(root, "external-gitdirs", "gitfile-escape.git");
    mkdirSync(join(root, "external-gitdirs"), { recursive: true });
    renameSync(join(pair.path, ".git"), externalGitDir);
    writeFileSync(join(pair.path, ".git"), `gitdir: ${externalGitDir}\n`);

    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_OUTSIDE_ROOT");
  });

  it("rejects symlink escapes in the Git common and object directories", () => {
    const commonName = "common-symlink";
    const commonAuthority = join(root, "external-authorities", commonName);
    const commonTarget = linkedCheckout(
      commonAuthority,
      join(canonicalRoot, `${commonName}-canonical`),
      commonName,
    );
    const externalGitDir = git(commonTarget.path, "rev-parse", "--absolute-git-dir");
    const internalGitDir = join(canonicalRoot, "gitdirs", commonName);
    mkdirSync(join(canonicalRoot, "gitdirs"), { recursive: true });
    cpSync(externalGitDir, internalGitDir, { recursive: true });
    const commonLink = join(canonicalRoot, "common-links", commonName);
    mkdirSync(join(canonicalRoot, "common-links"), { recursive: true });
    symlinkSync(join(commonAuthority, ".git"), commonLink, "dir");
    writeFileSync(join(commonTarget.path, ".git"), `gitdir: ${internalGitDir}\n`);
    writeFileSync(join(internalGitDir, "commondir"), `${commonLink}\n`);
    expect(git(commonTarget.path, "rev-parse", "HEAD")).toBe(commonTarget.head);
    const commonPair = seedPair({ name: commonName, target: commonTarget });
    expectCode(() => relocatePrimaryRepo(requestFor(commonPair)), "TARGET_OUTSIDE_ROOT");

    const objectPair = seedPair({ legacyId: 662, targetId: 1509, name: "object-symlink" });
    const externalObjects = join(root, "external-objects", "object-symlink");
    mkdirSync(join(root, "external-objects"), { recursive: true });
    renameSync(join(objectPair.path, ".git", "objects"), externalObjects);
    symlinkSync(externalObjects, join(objectPair.path, ".git", "objects"), "dir");
    expectCode(() => relocatePrimaryRepo(requestFor(objectPair)), "TARGET_OUTSIDE_ROOT");
  });

  it("rejects nested pack and loose-object fanout symlink escapes", () => {
    const packed = seedPair({ name: "pack-symlink" });
    const externalPack = join(root, "external-objects", "pack-symlink");
    mkdirSync(join(root, "external-objects"), { recursive: true });
    renameSync(join(packed.path, ".git", "objects", "pack"), externalPack);
    symlinkSync(externalPack, join(packed.path, ".git", "objects", "pack"), "dir");
    expectCode(() => relocatePrimaryRepo(requestFor(packed)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const loose = seedPair({ legacyId: 662, targetId: 1509, name: "loose-symlink" });
    const fanout = loose.head.slice(0, 2);
    const externalFanout = join(root, "external-objects", `loose-${fanout}`);
    renameSync(join(loose.path, ".git", "objects", fanout), externalFanout);
    symlinkSync(externalFanout, join(loose.path, ".git", "objects", fanout), "dir");
    expectCode(() => relocatePrimaryRepo(requestFor(loose)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("rejects external common and per-worktree config-file authority", () => {
    const common = seedPair({ name: "config-symlink" });
    const externalConfig = join(root, "external-configs", "common.config");
    mkdirSync(join(root, "external-configs"), { recursive: true });
    renameSync(join(common.path, ".git", "config"), externalConfig);
    symlinkSync(externalConfig, join(common.path, ".git", "config"));
    expectCode(() => relocatePrimaryRepo(requestFor(common)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const name = "worktree-config-symlink";
    const target = linkedCheckout(
      join(canonicalRoot, "anchors", name),
      join(canonicalRoot, `${name}-canonical`),
      name,
    );
    git(target.path, "config", "extensions.worktreeConfig", "true");
    git(target.path, "config", "--worktree", "relocation.fixture", "safe");
    const gitDir = git(target.path, "rev-parse", "--absolute-git-dir");
    const externalWorktreeConfig = join(root, "external-configs", "worktree.config");
    renameSync(join(gitDir, "config.worktree"), externalWorktreeConfig);
    symlinkSync(externalWorktreeConfig, join(gitDir, "config.worktree"));
    const worktree = seedPair({ legacyId: 662, targetId: 1509, name, target });
    expectCode(() => relocatePrimaryRepo(requestFor(worktree)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("rejects an external info directory that hides untracked files through exclude metadata", () => {
    const pair = seedPair({ name: "external-info" });
    const externalInfo = join(root, "external-info");
    renameSync(join(pair.path, ".git", "info"), externalInfo);
    writeFileSync(join(externalInfo, "exclude"), "*\n");
    symlinkSync(externalInfo, join(pair.path, ".git", "info"), "dir");
    writeFileSync(join(pair.path, "hidden-untracked.txt"), "must remain visible to validation\n");
    expect(git(pair.path, "ls-files", "--others", "--exclude-standard")).toBe("");

    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("rejects nonempty object alternates and HTTP alternates", () => {
    const alternate = seedPair({ name: "alternate" });
    const alternateObjects = join(root, "alternate-objects");
    mkdirSync(alternateObjects, { recursive: true });
    mkdirSync(join(alternate.path, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(alternate.path, ".git", "objects", "info", "alternates"), `${alternateObjects}\n`);
    expectCode(() => relocatePrimaryRepo(requestFor(alternate)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const http = seedPair({ legacyId: 662, targetId: 1509, name: "http-alternate" });
    mkdirSync(join(http.path, ".git", "objects", "info"), { recursive: true });
    writeFileSync(
      join(http.path, ".git", "objects", "info", "http-alternates"),
      "https://objects.invalid/repository/objects\n",
    );
    expectCode(() => relocatePrimaryRepo(requestFor(http)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("rejects repository-local promisor and partial-clone configuration", () => {
    const promisor = seedPair({ name: "promisor" });
    git(promisor.path, "config", "remote.origin.promisor", "true");
    expectCode(() => relocatePrimaryRepo(requestFor(promisor)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const partial = seedPair({ legacyId: 662, targetId: 1509, name: "partial" });
    git(partial.path, "config", "core.repositoryFormatVersion", "1");
    git(partial.path, "config", "extensions.partialClone", "origin");
    git(partial.path, "config", "remote.origin.partialCloneFilter", "blob:none");
    expectCode(() => relocatePrimaryRepo(requestFor(partial)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const included = seedPair({ legacyId: 663, targetId: 1510, name: "included-promisor" });
    const includePath = join(root, "external-promisor.config");
    writeFileSync(includePath, "[remote \"origin\"]\n\tpromisor = true\n");
    git(included.path, "config", "include.path", includePath);
    expectCode(() => relocatePrimaryRepo(requestFor(included)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("fails closed when object authority metadata is unreadable", () => {
    const pair = seedPair({ name: "unreadable-authority" });
    const metadata = join(pair.path, ".git", "objects", "info", "alternates");
    writeFileSync(metadata, "");
    chmodSync(metadata, 0o000);
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_NOT_GIT_CHECKOUT");
  });

  it("accepts a linked worktree whose common directory and objects remain inside the trusted root", () => {
    const name = "internal-anchor";
    const target = linkedCheckout(
      join(canonicalRoot, "anchors", name),
      join(canonicalRoot, `${name}-canonical`),
      name,
    );
    const pair = seedPair({ name, target });

    expect(relocatePrimaryRepo(requestFor(pair)).ok).toBe(true);
  });

  it("ignores inherited Git controls and cannot be tricked into hiding untracked target files", () => {
    const pair = seedPair();
    writeFileSync(join(pair.path, "dirty-untracked.txt"), "dirty\n");
    const previous = {
      count: process.env["GIT_CONFIG_COUNT"],
      key: process.env["GIT_CONFIG_KEY_0"],
      value: process.env["GIT_CONFIG_VALUE_0"],
    };
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "status.showUntrackedFiles";
    process.env["GIT_CONFIG_VALUE_0"] = "no";
    try {
      expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_DIRTY");
    } finally {
      for (const [key, value] of [
        ["GIT_CONFIG_COUNT", previous.count],
        ["GIT_CONFIG_KEY_0", previous.key],
        ["GIT_CONFIG_VALUE_0", previous.value],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("validates a clean checkout without executing repository-defined conversion callbacks", () => {
    const pair = seedPair();
    const marker = join(root, "conversion-callback-ran");
    const filter = join(root, "conversion-filter.sh");
    const filtered = join(pair.path, "callback.txt");
    writeFileSync(filter, `#!/bin/sh\nprintf x >> "${marker}"\ncat\n`);
    chmodSync(filter, 0o755);
    writeFileSync(join(pair.path, ".gitattributes"), "callback.txt filter=relocation-sentinel\n");
    writeFileSync(filtered, "callback-safe\n");
    git(pair.path, "config", "filter.relocation-sentinel.clean", filter);
    git(pair.path, "config", "filter.relocation-sentinel.smudge", "cat");
    git(pair.path, "config", "filter.relocation-sentinel.required", "true");
    git(pair.path, "add", ".gitattributes", "callback.txt");
    git(pair.path, "commit", "-m", "add callback fixture");
    pair.head = git(pair.path, "rev-parse", "HEAD");
    rmSync(marker, { force: true });
    const future = new Date(Date.now() + 60_000);
    utimesSync(filtered, future, future);

    expect(relocatePrimaryRepo(requestFor(pair)).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("detects tracked byte changes, staged changes, and tracked deletions without worktree diff", () => {
    const modified = seedPair({ legacyId: 661, targetId: 1508, name: "modified" });
    writeFileSync(join(modified.path, "README.md"), "modified\n");
    expectCode(() => relocatePrimaryRepo(requestFor(modified)), "TARGET_DIRTY");

    const staged = seedPair({ legacyId: 662, targetId: 1509, name: "staged" });
    writeFileSync(join(staged.path, "README.md"), "staged\n");
    git(staged.path, "add", "README.md");
    expectCode(() => relocatePrimaryRepo(requestFor(staged)), "TARGET_DIRTY");

    const deleted = seedPair({ legacyId: 663, targetId: 1510, name: "deleted" });
    rmSync(join(deleted.path, "README.md"));
    expectCode(() => relocatePrimaryRepo(requestFor(deleted)), "TARGET_DIRTY");
  });

  it("detects executable-mode and symlink-target changes from filesystem metadata and bytes", () => {
    const executable = seedPair({ legacyId: 661, targetId: 1508, name: "executable" });
    chmodSync(join(executable.path, "README.md"), 0o755);
    expectCode(() => relocatePrimaryRepo(requestFor(executable)), "TARGET_DIRTY");

    const symlink = seedPair({ legacyId: 662, targetId: 1509, name: "symlink" });
    symlinkSync("README.md", join(symlink.path, "current"));
    git(symlink.path, "add", "current");
    git(symlink.path, "commit", "-m", "add symlink");
    symlink.head = git(symlink.path, "rev-parse", "HEAD");
    rmSync(join(symlink.path, "current"));
    symlinkSync("missing.md", join(symlink.path, "current"));
    expectCode(() => relocatePrimaryRepo(requestFor(symlink)), "TARGET_DIRTY");
  });

  it("detects non-ignored untracked files but allows ignored cache files", () => {
    const untracked = seedPair({ legacyId: 661, targetId: 1508, name: "untracked" });
    writeFileSync(join(untracked.path, "new.txt"), "new\n");
    expectCode(() => relocatePrimaryRepo(requestFor(untracked)), "TARGET_DIRTY");

    const ignored = seedPair({ legacyId: 662, targetId: 1509, name: "ignored" });
    writeFileSync(join(ignored.path, ".gitignore"), "cache/\n");
    git(ignored.path, "add", ".gitignore");
    git(ignored.path, "commit", "-m", "ignore cache");
    ignored.head = git(ignored.path, "rev-parse", "HEAD");
    mkdirSync(join(ignored.path, "cache"));
    writeFileSync(join(ignored.path, "cache", "state.bin"), "cache\n");
    expect(relocatePrimaryRepo(requestFor(ignored)).ok).toBe(true);
  });

  it("fails closed on unresolved index conflicts and unsupported submodules", () => {
    const conflicted = seedPair({ legacyId: 661, targetId: 1508, name: "conflicted" });
    git(conflicted.path, "checkout", "-b", "other");
    writeFileSync(join(conflicted.path, "README.md"), "other\n");
    git(conflicted.path, "commit", "-am", "other");
    git(conflicted.path, "checkout", "main");
    writeFileSync(join(conflicted.path, "README.md"), "main\n");
    git(conflicted.path, "commit", "-am", "main");
    conflicted.head = git(conflicted.path, "rev-parse", "HEAD");
    expect(() => git(conflicted.path, "merge", "other")).toThrow();
    expectCode(() => relocatePrimaryRepo(requestFor(conflicted)), "TARGET_DIRTY");

    const submodule = seedPair({ legacyId: 662, targetId: 1509, name: "submodule" });
    git(submodule.path, "update-index", "--add", "--cacheinfo", `160000,${submodule.head},vendor/submodule`);
    git(submodule.path, "commit", "-m", "add gitlink");
    submodule.head = git(submodule.path, "rev-parse", "HEAD");
    expectCode(() => relocatePrimaryRepo(requestFor(submodule)), "TARGET_DIRTY");
  });

  it("ignores repository-local replacement refs when comparing the exact HEAD tree", () => {
    const pair = seedPair();
    const originalHead = pair.head;
    writeFileSync(join(pair.path, "README.md"), "replacement tree\n");
    git(pair.path, "commit", "-am", "replacement tree");
    const replacementHead = git(pair.path, "rev-parse", "HEAD");
    git(pair.path, "replace", originalHead, replacementHead);
    git(pair.path, "update-ref", "refs/heads/main", originalHead);
    pair.head = originalHead;

    expect(git(pair.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(pair.path, "show", "HEAD:README.md")).toBe("replacement tree");
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_DIRTY");
  });

  it("validates the raw local origin before url.insteadOf rewriting", () => {
    const pair = seedPair();
    git(pair.path, "remote", "set-url", "origin", "https://rewrite.invalid/hasna/accounts.git");
    git(pair.path, "config", "url.https://github.com/.insteadOf", "https://rewrite.invalid/");
    expect(git(pair.path, "remote", "get-url", "origin")).toBe("https://github.com/hasna/accounts.git");
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "REMOTE_MISMATCH");
  });

  it("does not let global url.insteadOf configuration rewrite the raw origin identity", () => {
    const pair = seedPair();
    const globalConfig = join(root, "adversarial-global-gitconfig");
    writeFileSync(globalConfig, `[url "https://github.com/"]\n\tinsteadOf = https://rewrite.invalid/\n`);
    git(pair.path, "remote", "set-url", "origin", "https://rewrite.invalid/hasna/accounts.git");
    const previous = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
    try {
      const rewritten = execFileSync("git", ["-C", pair.path, "remote", "get-url", "origin"], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
      }).trim();
      expect(rewritten).toBe("https://github.com/hasna/accounts.git");
      expectCode(() => relocatePrimaryRepo(requestFor(pair)), "REMOTE_MISMATCH");
    } finally {
      if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = previous;
    }
  });

  it("rejects a third registered realpath alias", () => {
    const pair = seedPair();
    const alias = join(canonicalRoot, "third-alias");
    symlinkSync(pair.path, alias, "dir");
    insertRepo(1700, alias, "other", "https://github.com/hasna/other.git");
    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "THIRD_PATH_ALIAS");
  });

  it("blocks dynamically discovered unknown repo foreign-key tables", () => {
    const pair = seedPair();
    getDb().exec("CREATE TABLE future_repo_state (id INTEGER PRIMARY KEY, repo_id INTEGER REFERENCES repos(id))");
    const error = expectCode(() => relocatePrimaryRepo(requestFor(pair)), "UNKNOWN_REPO_FOREIGN_KEY");
    expect(error.details?.tables).toEqual(["future_repo_state"]);
  });

  it("rebinds catalog and path-only leases, reconciles graph edges, and reparents prior audits", () => {
    const pair = seedPair();
    const db = getDb();
    db.exec(`CREATE TABLE worktree_leases (
      lease_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL,
      repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    db.query("INSERT INTO worktree_leases (lease_id, repo_path, repo_catalog_id) VALUES ('legacy-lease', ?, ?)").run(pair.sourcePath, pair.legacyId);
    db.query("INSERT INTO worktree_leases (lease_id, repo_path, repo_catalog_id) VALUES ('target-lease', ?, ?)").run(pair.path, pair.targetId);
    db.query("INSERT INTO worktree_leases (lease_id, repo_path, repo_catalog_id, metadata) VALUES ('path-legacy', ?, NULL, 'legacy-path-only')").run(pair.sourcePath);
    db.query("INSERT INTO worktree_leases (lease_id, repo_path, repo_catalog_id, metadata) VALUES ('path-target', ?, NULL, 'target-path-only')").run(pair.path);
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '999', '{}')").run(String(pair.targetId));

    const seed = relocatePrimaryRepo(requestFor(pair));
    db.query(`INSERT INTO repo_relocation_audit (
      id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id, operation, actor,
      expected_current_path, target_path, expected_remote, expected_head, source_revision,
      target_revision, source_json, target_json, after_json, counts_json, collisions_json, created_at
    ) VALUES ('prior', 'prior-key', ?, ?, ?, ?, 'primary_relocation', 'prior:actor', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', '2026-07-14')`).run(
      seed.plan.request_hash, seed.plan.plan_hash, pair.targetId, 9999, pair.sourcePath, pair.path,
      `github.com/hasna/${pair.name}`, pair.head, `revision-${pair.legacyId}`,
      `revision-${pair.targetId}`, JSON.stringify(seed.before), JSON.stringify(seed.target), JSON.stringify(seed.after),
    );
    const { applied } = applyReviewed(pair);
    expect(applied.plan.counts.edges.move).toBe(1);
    expect(applied.plan.counts.worktree_leases).toEqual({ legacy: 2, target: 2, move: 4, dedupe: 0, block: 0 });
    expect(db.query("SELECT repo_catalog_id, repo_path, metadata FROM worktree_leases ORDER BY lease_id").all()).toEqual([
      { repo_catalog_id: pair.legacyId, repo_path: pair.path, metadata: "{}" },
      { repo_catalog_id: pair.legacyId, repo_path: pair.path, metadata: "legacy-path-only" },
      { repo_catalog_id: pair.legacyId, repo_path: pair.path, metadata: "target-path-only" },
      { repo_catalog_id: pair.legacyId, repo_path: pair.path, metadata: "{}" },
    ]);
    expect(db.query("SELECT source_id FROM edges").get()).toEqual({ source_id: String(pair.legacyId) });
    expect(db.query("SELECT repo_id FROM repo_relocation_audit WHERE id = 'prior'").get()).toEqual({ repo_id: pair.legacyId });
  });

  it("fails closed when an exact relocation-path lease belongs to a third registered repo", () => {
    const pair = seedPair();
    const db = getDb();
    const thirdPath = join(root, "third-registered-repo");
    insertRepo(1700, thirdPath, "third", "https://github.com/hasna/third.git");
    db.exec(`CREATE TABLE worktree_leases (
      lease_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL,
      repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    db.query(`INSERT INTO worktree_leases
      (lease_id, repo_path, repo_catalog_id, metadata)
      VALUES ('conflicting-lease', ?, 1700, 'must-stay')`).run(pair.sourcePath);
    const beforeRepos = db.query("SELECT * FROM repos ORDER BY id").all();
    const beforeLeases = db.query("SELECT * FROM worktree_leases ORDER BY lease_id").all();

    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "WORKTREE_LEASE_CONFLICT");

    expect(db.query("SELECT * FROM repos ORDER BY id").all()).toEqual(beforeRepos);
    expect(db.query("SELECT * FROM worktree_leases ORDER BY lease_id").all()).toEqual(beforeLeases);
    expect(db.query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
  });

  it("dedupes exact mapped graph edges and blocks divergent mapped edges", () => {
    const pair = seedPair();
    const db = getDb();
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '999', 1, '{}')").run(String(pair.legacyId));
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '999', 1, '{}')").run(String(pair.targetId));
    const result = applyReviewed(pair).applied;
    expect(result.plan.counts.edges.dedupe).toBe(1);
    expect(db.query("SELECT count(*) AS count FROM edges").get()).toEqual({ count: 1 });

    const other = seedPair({ legacyId: 662, targetId: 1509, name: "sandboxes" });
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '998', 1, '{}')").run(String(other.legacyId));
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '998', 2, '{}')").run(String(other.targetId));
    const blocked = relocatePrimaryRepo(requestFor(other));
    expect(blocked.plan.can_apply).toBe(false);
  });

  it("converges multiple target-bearing edges by their final post-map key", () => {
    const pair = seedPair();
    const db = getDb();
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'mirrors', 'repo', ?, 1, '{}')")
      .run(String(pair.targetId), String(pair.legacyId));
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'mirrors', 'repo', ?, 1, '{}')")
      .run(String(pair.legacyId), String(pair.targetId));
    const { dry, applied } = applyReviewed(pair);
    expect(dry.plan.counts.edges).toEqual({ legacy: 0, target: 2, move: 1, dedupe: 1, block: 0 });
    expect(applied.applied).toBe(true);
    expect(db.query("SELECT source_id, target_id, weight, metadata FROM edges").all()).toEqual([{
      source_id: String(pair.legacyId),
      target_id: String(pair.legacyId),
      weight: 1,
      metadata: "{}",
    }]);
  });

  it("blocks target-bearing edges that converge with divergent payloads without mutating", () => {
    const pair = seedPair();
    const db = getDb();
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'mirrors', 'repo', ?, 1, '{\"origin\":\"left\"}')")
      .run(String(pair.targetId), String(pair.legacyId));
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata) VALUES ('repo', ?, 'mirrors', 'repo', ?, 2, '{\"origin\":\"right\"}')")
      .run(String(pair.legacyId), String(pair.targetId));
    const beforeRepos = db.query("SELECT * FROM repos ORDER BY id").all();
    const beforeEdges = db.query("SELECT * FROM edges ORDER BY id").all();

    const dry = relocatePrimaryRepo(requestFor(pair));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.counts.edges).toEqual({ legacy: 0, target: 2, move: 1, dedupe: 0, block: 1 });
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "edges", decision: "block" }));
    expectCode(() => relocatePrimaryRepo({
      ...requestFor(pair),
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "DIVERGENT_COLLISION");

    expect(db.query("SELECT * FROM repos ORDER BY id").all()).toEqual(beforeRepos);
    expect(db.query("SELECT * FROM edges ORDER BY id").all()).toEqual(beforeEdges);
    expect(db.query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
  });

  it("rolls back every mutation when receipt persistence fails", () => {
    const pair = seedPair();
    insertChildFixtures(pair.legacyId, pair.targetId);
    const dry = relocatePrimaryRepo(requestFor(pair));
    getDb().exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON repo_relocation_audit BEGIN SELECT RAISE(ABORT, 'fail'); END");
    expectCode(() => relocatePrimaryRepo({ ...requestFor(pair), apply: true, expectedPlanHash: dry.plan.plan_hash }), "TRANSACTION_CONFLICT");
    expect(getDb().query("SELECT id, path FROM repos ORDER BY id").all()).toEqual([
      { id: pair.legacyId, path: pair.sourcePath },
      { id: pair.targetId, path: pair.path },
    ]);
    expect(getDb().query("SELECT count(*) AS count FROM commits WHERE repo_id = ?").get(pair.targetId)).toEqual({ count: 2 });
  });

  it("returns the persisted receipt on same-request retry and blocks same-key different requests", () => {
    const pair = seedPair();
    const request = requestFor(pair);
    const dry = relocatePrimaryRepo(request);
    const first = relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });
    const retry = relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });
    expect(retry.receipt?.id).toBe(first.receipt?.id);
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 1 });
    expectCode(() => relocatePrimaryRepo({
      ...request,
      actor: "different:actor",
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "IDEMPOTENCY_CONFLICT");
  });

  it("uses the correct live Infinity legacy-to-canonical ID mapping", () => {
    const fixtures = [
      [661, 1510, "codewith"],
      [662, 1511, "infinity"],
      [663, 1509, "sandboxes"],
      [664, 1508, "accounts"],
    ] as const;
    for (const [legacyId, targetId, name] of fixtures) {
      const pair = seedPair({ legacyId, targetId, name });
      const applied = applyReviewed(pair, { idempotencyKey: `live-map-${legacyId}-${targetId}` }).applied;
      expect(applied.repo_id).toBe(legacyId);
      expect(applied.target_repo_id).toBe(targetId);
      expect(getDb().query("SELECT id, path FROM repos WHERE id = ?").get(legacyId)).toEqual({ id: legacyId, path: pair.path });
    }
  });
});
