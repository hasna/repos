import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS,
  PrimaryRelocationError,
  relocatePrimaryRepo,
  sanitizeGitRemoteUrl,
  setPrimaryRelocationCanonicalRootForTests,
  type PrimaryRelocationRequest,
} from "./primary-relocation.js";

setDefaultTimeout(30_000);

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

function seedDivergentBranchCollision(
  pair: ReturnType<typeof seedPair>,
  namespace = "legacy-preserved",
) {
  const db = getDb();
  git(pair.path, "checkout", "-b", "legacy-source");
  writeFileSync(join(pair.path, "legacy-branch.txt"), "legacy branch\n");
  git(pair.path, "add", "legacy-branch.txt");
  git(pair.path, "commit", "-m", "legacy branch");
  const legacySha = git(pair.path, "rev-parse", "HEAD");
  const preservedName = `${namespace}/main`;
  git(pair.path, "update-ref", `refs/heads/${preservedName}`, legacySha);
  git(pair.path, "checkout", "main");
  db.query("INSERT INTO branches (repo_id, name, last_commit_sha) VALUES (?, 'main', ?)").run(pair.legacyId, legacySha);
  db.query("INSERT INTO branches (repo_id, name, last_commit_sha) VALUES (?, 'main', ?)").run(pair.targetId, pair.head);
  return { namespace, legacySha, preservedName, targetSha: pair.head };
}

function seedDivergentRemoteBranchCollisions(
  pair: ReturnType<typeof seedPair>,
  branchNames: string[],
  namespace = "legacy-preserved",
) {
  const db = getDb();
  git(pair.path, "checkout", "-b", "legacy-remote-source");
  writeFileSync(join(pair.path, "legacy-remote-branch.txt"), "legacy remote branch\n");
  git(pair.path, "add", "legacy-remote-branch.txt");
  git(pair.path, "commit", "-m", "legacy remote branch");
  const legacySha = git(pair.path, "rev-parse", "HEAD");
  git(pair.path, "checkout", "main");

  for (const branchName of branchNames) {
    git(pair.path, "update-ref", `refs/heads/${namespace}/${branchName}`, legacySha);
    db.query("INSERT INTO branches (repo_id, name, is_remote, last_commit_sha) VALUES (?, ?, 1, ?)")
      .run(pair.legacyId, branchName, legacySha.slice(0, 7));
    db.query("INSERT INTO branches (repo_id, name, is_remote, last_commit_sha) VALUES (?, ?, 1, ?)")
      .run(pair.targetId, branchName, pair.head.slice(0, 7));
  }
  return { namespace, legacySha, targetSha: pair.head };
}

function missingObjectPrefix(path: string): string {
  for (const prefix of ["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999"]) {
    if (!git(path, "rev-parse", `--disambiguate=${prefix}`)) return prefix;
  }
  throw new Error("could not find a missing object prefix");
}

function ambiguousObjectPrefix(path: string): string {
  const dir = join(root, "ambiguous-object-prefixes");
  mkdirSync(dir, { recursive: true });
  const algorithm = git(path, "rev-parse", "--show-object-format") === "sha256" ? "sha256" : "sha1";
  const objectId = (content: string) => {
    const bytes = Buffer.from(content);
    return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  };
  const seen = new Map<string, { sha: string; content: string }>();
  for (let i = 0; i < 4096; i++) {
    const content = `candidate ${i}\n`;
    const sha = objectId(content);
    const prefix = sha.slice(0, 4);
    const prior = seen.get(prefix);
    if (prior && prior.sha !== sha) {
      for (const [index, item] of [prior, { sha, content }].entries()) {
        const candidate = join(dir, `candidate-${index}.txt`);
        writeFileSync(candidate, item.content);
        expect(git(path, "hash-object", "-w", candidate)).toBe(item.sha);
      }
      return prefix;
    }
    seen.set(prefix, { sha, content });
  }
  throw new Error("could not create an ambiguous object prefix");
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
    expect(getDb().query("SELECT url, fetch_url FROM remotes WHERE name = 'upstream'").get()).toEqual({
      url: "github.com/hasna/upstream",
      fetch_url: null,
    });
    expect(getDb().query("PRAGMA foreign_key_check").all()).toEqual([]);
    const audit = getDb().query("SELECT * FROM repo_relocation_audit").get() as Record<string, unknown>;
    expect(audit.plan_hash).toBe(dry.plan.plan_hash);
    expect(JSON.stringify(audit)).not.toContain("legacy-token");
    expect(JSON.stringify(audit)).not.toContain("credential@");
  });

  it("persists only the normalized remote identity when registry and checkout inputs contain credentials", () => {
    const pair = seedPair("remote-persistence");
    const unsafe = `https://${["member", "phrase"].join(":")}@github.com/hasna/${pair.name}.git?query=marker`;
    getDb().query("UPDATE repos SET remote_url = ? WHERE id IN (?, ?)").run(unsafe, pair.legacyId, pair.targetId);
    git(pair.path, "remote", "set-url", "origin", unsafe);

    const { applied } = applyReviewed(pair);
    expect(getDb().query("SELECT remote_url FROM repos WHERE id = ?").get(pair.legacyId)).toEqual({
      remote_url: `github.com/hasna/${pair.name}`,
    });
    expect(JSON.stringify(applied)).not.toContain(unsafe);
    expect(JSON.stringify(applied)).not.toContain("phrase");
  });

  it("blocks rejected child remote identities without exposing or persisting their input", () => {
    const pair = seedPair("invalid-child-remote");
    const unsafe = "file:///tmp/private-repo";
    getDb().query("INSERT INTO remotes (repo_id, name, url) VALUES (?, 'local', ?)").run(pair.targetId, unsafe);

    const dry = relocatePrimaryRepo(requestFor(pair));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "remotes", decision: "block" }));
    expect(JSON.stringify(dry)).not.toContain(unsafe);
    expect(() => relocatePrimaryRepo({ ...requestFor(pair), apply: true, expectedPlanHash: dry.plan.plan_hash }))
      .toThrow(PrimaryRelocationError);
    expect(getDb().query("SELECT url FROM remotes WHERE repo_id = ? AND name = 'local'").get(pair.targetId))
      .toEqual({ url: unsafe });
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
      remote_url: "github.com/hasna/accounts",
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

  it("keeps divergent branch collisions fail-closed by default", () => {
    const pair = seedPair({ name: "branch-default" });
    seedDivergentBranchCollision(pair);

    const dry = relocatePrimaryRepo(requestFor(pair));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "branches", decision: "block" }));
    const error = expectCode(() => relocatePrimaryRepo({
      ...requestFor(pair),
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "DIVERGENT_COLLISION");
    expect(error.details?.collisions?.[0]).toMatchObject({ table: "branches", decision: "block" });
    expect(getDb().query("SELECT repo_id, name FROM branches ORDER BY repo_id, name").all()).toEqual([
      { repo_id: pair.legacyId, name: "main" },
      { repo_id: pair.targetId, name: "main" },
    ]);
  });

  it("requires exact target refs before preserving divergent legacy branches", () => {
    const pair = seedPair({ name: "branch-missing-evidence" });
    const db = getDb();
    db.query("INSERT INTO branches (repo_id, name, last_commit_sha) VALUES (?, 'main', ?)").run(pair.legacyId, "a".repeat(40));
    db.query("INSERT INTO branches (repo_id, name, last_commit_sha) VALUES (?, 'main', ?)").run(pair.targetId, pair.head);

    const dry = relocatePrimaryRepo(requestFor(pair, { preserveDivergentBranchesUnder: "legacy-preserved" }));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      preserved_name_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expectCode(() => relocatePrimaryRepo({
      ...requestFor(pair, { preserveDivergentBranchesUnder: "legacy-preserved" }),
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "DIVERGENT_COLLISION");
  });

  it("preserves divergent legacy branches under an explicit reviewed namespace", () => {
    const pair = seedPair({ name: "branch-preserve" });
    const evidence = seedDivergentBranchCollision(pair);
    const defaultDry = relocatePrimaryRepo(requestFor(pair));
    const request = requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
      idempotencyKey: "branch-preserve-cutover-v1",
    });
    const dry = relocatePrimaryRepo(request);

    expect(defaultDry.plan.can_apply).toBe(false);
    expect(dry.plan.can_apply).toBe(true);
    expect(dry.plan.plan_hash).not.toBe(defaultDry.plan.plan_hash);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "preserve",
      preserved_name_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      preserved_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));

    const applied = relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });
    const retry = relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });
    expect(retry.replayed).toBe(true);
    expect(retry.receipt?.id).toBe(applied.receipt?.id);
    expect(getDb().query("SELECT repo_id, name, last_commit_sha FROM branches ORDER BY name").all()).toEqual([
      { repo_id: pair.legacyId, name: evidence.preservedName, last_commit_sha: evidence.legacySha },
      { repo_id: pair.legacyId, name: "main", last_commit_sha: evidence.targetSha },
    ]);
    expect(getDb().query("SELECT id FROM repos WHERE id = ?").get(pair.targetId)).toBeNull();
  });

  it("blocks local and remote preservation decisions that plan the same local branch key", () => {
    const pair = seedPair({ name: "branch-preserve-planned-collision" });
    const db = getDb();
    const branchName = "origin/main";
    const namespace = "legacy-preserved";

    git(pair.path, "checkout", "-b", "legacy-planned-collision");
    writeFileSync(join(pair.path, "legacy-planned-collision.txt"), "legacy planned collision\n");
    git(pair.path, "add", "legacy-planned-collision.txt");
    git(pair.path, "commit", "-m", "legacy planned collision");
    const legacySha = git(pair.path, "rev-parse", "HEAD");
    git(pair.path, "checkout", "main");
    git(pair.path, "update-ref", `refs/heads/${namespace}/${branchName}`, legacySha);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, pair.head);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, pair.head);

    for (const isRemote of [0, 1]) {
      db.query("INSERT INTO branches (repo_id, name, is_remote, last_commit_sha) VALUES (?, ?, ?, ?)")
        .run(pair.legacyId, branchName, isRemote, legacySha);
      db.query("INSERT INTO branches (repo_id, name, is_remote, last_commit_sha) VALUES (?, ?, ?, ?)")
        .run(pair.targetId, branchName, isRemote, pair.head);
    }

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "preserve",
      preserved_name_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      preserved_name_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("accepts unambiguous abbreviated preservation commits and applies exact branch SHAs", () => {
    const pair = seedPair({ name: "branch-preserve-abbrev" });
    const evidence = seedDivergentBranchCollision(pair);
    const db = getDb();
    db.query("UPDATE branches SET last_commit_sha = ? WHERE repo_id = ? AND name = 'main'")
      .run(evidence.legacySha.slice(0, 7), pair.legacyId);
    db.query("UPDATE branches SET last_commit_sha = ? WHERE repo_id = ? AND name = 'main'")
      .run(evidence.targetSha.slice(0, 9), pair.targetId);
    const request = requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
      idempotencyKey: "branch-preserve-abbrev-v1",
    });

    const dry = relocatePrimaryRepo(request);
    expect(dry.plan.can_apply).toBe(true);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "preserve",
      preserved_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));

    relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });
    expect(db.query("SELECT repo_id, name, last_commit_sha FROM branches ORDER BY name").all()).toEqual([
      { repo_id: pair.legacyId, name: evidence.preservedName, last_commit_sha: evidence.legacySha },
      { repo_id: pair.legacyId, name: "main", last_commit_sha: evidence.targetSha },
    ]);
  });

  for (const fixture of [
    { repo: "accounts", branches: ["origin/build/accounts-v1"] },
    { repo: "sandboxes", branches: ["origin/build/managed-adapters-v1"] },
    {
      repo: "infinity",
      branches: [
        "origin/build/checkpoint-broker-v1",
        "origin/build/infinity-v1",
        "origin/build/portable-api-broker-v1",
      ],
    },
  ]) {
    it(`validates ${fixture.repo} remote branch rows against remote-tracking refs`, () => {
      const pair = seedPair({ name: `remote-${fixture.repo}` });
      const evidence = seedDivergentRemoteBranchCollisions(pair, fixture.branches);
      for (const branchName of fixture.branches) {
        git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.targetSha);
      }

      const dry = relocatePrimaryRepo(requestFor(pair, {
        preserveDivergentBranchesUnder: evidence.namespace,
      }));

      expect(dry.plan.can_apply).toBe(true);
      expect(dry.plan.collisions.filter(({ table, decision }) => (
        table === "branches" && decision === "preserve"
      ))).toHaveLength(fixture.branches.length);
    });
  }

  it("fails closed for a remote-marked row without a configured remote prefix", () => {
    const pair = seedPair({ name: "stale-remote-local-slash" });
    const branchName = "build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.targetSha);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.targetSha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("validates a local origin slash row against its local head", () => {
    const pair = seedPair({ name: "local-origin-slash" });
    const branchName = "origin/build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    getDb().query("UPDATE branches SET is_remote = 0 WHERE name = ? AND repo_id IN (?, ?)")
      .run(branchName, pair.legacyId, pair.targetId);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.targetSha);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.legacySha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(true);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "preserve",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("fails closed for a stale remote-marked row named after a configured remote", () => {
    const pair = seedPair({ name: "stale-symbolic-remote-head" });
    const branchName = "origin";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", "refs/heads/origin", evidence.targetSha);
    git(pair.path, "update-ref", "refs/remotes/origin/main", evidence.legacySha);
    git(pair.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("applies a preserved remote slash branch with local branch semantics", () => {
    const pair = seedPair({ name: "preserved-remote-local-semantics" });
    const branchName = "origin/build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.targetSha);
    getDb().query("UPDATE branches SET ahead = 7, behind = 11 WHERE repo_id = ? AND name = ?")
      .run(pair.legacyId, branchName);
    const request = requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
      idempotencyKey: "preserved-remote-local-semantics-v1",
    });
    const dry = relocatePrimaryRepo(request);

    expect(dry.plan.can_apply).toBe(true);
    relocatePrimaryRepo({ ...request, apply: true, expectedPlanHash: dry.plan.plan_hash });

    expect(getDb().query(
      "SELECT repo_id, name, is_remote, last_commit_sha, ahead, behind FROM branches WHERE name = ?",
    ).get(`${evidence.namespace}/${branchName}`)).toEqual({
      repo_id: pair.legacyId,
      name: `${evidence.namespace}/${branchName}`,
      is_remote: 0,
      last_commit_sha: evidence.legacySha,
      ahead: 0,
      behind: 0,
    });
  });

  for (const fixture of [
    { name: "missing", localCommit: null },
    { name: "different", localCommit: "target" },
  ] as const) {
    it(`requires preserved origin namespace evidence at the local head when it is ${fixture.name}`, () => {
      const pair = seedPair({ name: `preserved-origin-${fixture.name}` });
      const evidence = seedDivergentBranchCollision(pair, "origin");
      git(pair.path, "update-ref", "-d", "refs/heads/origin/main");
      if (fixture.localCommit === "target") {
        git(pair.path, "update-ref", "refs/heads/origin/main", evidence.targetSha);
      }
      git(pair.path, "update-ref", "refs/remotes/origin/main", evidence.legacySha);

      const dry = relocatePrimaryRepo(requestFor(pair, {
        preserveDivergentBranchesUnder: evidence.namespace,
      }));

      expect(dry.plan.can_apply).toBe(false);
      expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
        table: "branches",
        decision: "block",
        preserved_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
    });
  }

  it("fails closed when configured-remote target evidence conflicts with a same-name local head", () => {
    const pair = seedPair({ name: "remote-target-ambiguous" });
    const branchName = "origin/build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.targetSha);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.legacySha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("allows same-commit local and remote-tracking target refs", () => {
    const pair = seedPair({ name: "remote-target-same-commit" });
    const branchName = "origin/build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.targetSha);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.targetSha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(true);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "preserve",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("fails closed when a remote target branch ref is missing", () => {
    const pair = seedPair({ name: "remote-branch-missing" });
    const branchName = "origin/build/accounts-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.targetSha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("fails closed when a remote target branch ref resolves to another commit", () => {
    const pair = seedPair({ name: "remote-branch-mismatch" });
    const branchName = "origin/build/managed-adapters-v1";
    const evidence = seedDivergentRemoteBranchCollisions(pair, [branchName]);
    git(pair.path, "update-ref", `refs/heads/${branchName}`, evidence.targetSha);
    git(pair.path, "update-ref", `refs/remotes/${branchName}`, evidence.legacySha);

    const dry = relocatePrimaryRepo(requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
    }));

    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({
      table: "branches",
      decision: "block",
      target_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("fails closed when preserved branch metadata names a missing object", () => {
    const pair = seedPair({ name: "branch-preserve-missing-object" });
    const evidence = seedDivergentBranchCollision(pair);
    getDb().query("UPDATE branches SET last_commit_sha = ? WHERE repo_id = ? AND name = 'main'")
      .run(missingObjectPrefix(pair.path), pair.legacyId);

    const dry = relocatePrimaryRepo(requestFor(pair, { preserveDivergentBranchesUnder: evidence.namespace }));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "branches", decision: "block" }));
  });

  it("fails closed when preserved branch metadata resolves to a non-commit object", () => {
    const pair = seedPair({ name: "branch-preserve-non-commit-object" });
    const evidence = seedDivergentBranchCollision(pair);
    const blob = join(root, "non-commit-object.txt");
    writeFileSync(blob, "not a commit\n");
    getDb().query("UPDATE branches SET last_commit_sha = ? WHERE repo_id = ? AND name = 'main'")
      .run(git(pair.path, "hash-object", "-w", blob).slice(0, 9), pair.legacyId);

    const dry = relocatePrimaryRepo(requestFor(pair, { preserveDivergentBranchesUnder: evidence.namespace }));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "branches", decision: "block" }));
  });

  it("fails closed when preserved branch metadata is an ambiguous object abbreviation", () => {
    const pair = seedPair({ name: "branch-preserve-ambiguous-object" });
    const evidence = seedDivergentBranchCollision(pair);
    getDb().query("UPDATE branches SET last_commit_sha = ? WHERE repo_id = ? AND name = 'main'")
      .run(ambiguousObjectPrefix(pair.path), pair.legacyId);

    const dry = relocatePrimaryRepo(requestFor(pair, { preserveDivergentBranchesUnder: evidence.namespace }));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "branches", decision: "block" }));
  });

  it("does not let branch preservation mask non-branch divergence", () => {
    const pair = seedPair({ name: "branch-preserve-nonbranch" });
    seedDivergentBranchCollision(pair);
    const db = getDb();
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'same', 'A', 'a@invalid', '2026', 'legacy')").run(pair.legacyId);
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'same', 'A', 'a@invalid', '2026', 'target')").run(pair.targetId);

    const dry = relocatePrimaryRepo(requestFor(pair, { preserveDivergentBranchesUnder: "legacy-preserved" }));
    expect(dry.plan.can_apply).toBe(false);
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "branches", decision: "preserve" }));
    expect(dry.plan.collisions).toContainEqual(expect.objectContaining({ table: "commits", decision: "block" }));
  });

  it("binds preservation evidence into the reviewed plan hash and revalidates apply", () => {
    const pair = seedPair({ name: "branch-preserve-revalidate" });
    const evidence = seedDivergentBranchCollision(pair);
    const request = requestFor(pair, {
      preserveDivergentBranchesUnder: evidence.namespace,
      idempotencyKey: "branch-preserve-revalidate-v1",
    });
    const dry = relocatePrimaryRepo(request);
    expect(dry.plan.can_apply).toBe(true);

    git(pair.path, "checkout", "-b", "preservation-drift");
    writeFileSync(join(pair.path, "preservation-drift.txt"), "drift\n");
    git(pair.path, "add", "preservation-drift.txt");
    git(pair.path, "commit", "-m", "preservation drift");
    git(pair.path, "update-ref", `refs/heads/${evidence.preservedName}`, git(pair.path, "rev-parse", "HEAD"));
    git(pair.path, "checkout", "main");

    expectCode(() => relocatePrimaryRepo({
      ...request,
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "PLAN_HASH_MISMATCH");
    expect(getDb().query("SELECT repo_id, name FROM branches ORDER BY repo_id, name").all()).toEqual([
      { repo_id: pair.legacyId, name: "main" },
      { repo_id: pair.targetId, name: "main" },
    ]);
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

  it("rejects shallow metadata and promisor pack markers without relying on config", () => {
    const shallow = seedPair({ name: "shallow-marker" });
    writeFileSync(join(shallow.path, ".git", "shallow"), `${shallow.head}\n`);
    expectCode(() => relocatePrimaryRepo(requestFor(shallow)), "TARGET_UNTRUSTED_GIT_AUTHORITY");

    const promisor = seedPair({ legacyId: 662, targetId: 1509, name: "promisor-marker" });
    writeFileSync(join(promisor.path, ".git", "objects", "pack", "fixture.promisor"), "");
    expectCode(() => relocatePrimaryRepo(requestFor(promisor)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
  });

  it("guards full object-graph fsck with a repo-scale bounded timeout", () => {
    expect(FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS).toBeLessThanOrEqual(300_000);

    const source = readFileSync(new URL("./primary-relocation.ts", import.meta.url), "utf8");
    const fsckCall = source.match(/runGit\(path,\s*\[[\s\S]*?"fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", "--no-progress",\s*\]\s*,\s*([A-Z0-9_]+)\s*\)/);
    expect(fsckCall?.[1]).toBe("FULL_OBJECT_GRAPH_GIT_TIMEOUT_MS");
  });

  it("rejects missing tracked blobs and missing reachable commit and tree history", () => {
    const missingBlob = seedPair({ name: "missing-blob" });
    const blob = git(missingBlob.path, "rev-parse", "HEAD:README.md");
    rmSync(join(missingBlob.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    expectCode(() => relocatePrimaryRepo(requestFor(missingBlob)), "TARGET_NOT_GIT_CHECKOUT");

    const missingCommit = seedPair({ legacyId: 662, targetId: 1509, name: "missing-parent" });
    writeFileSync(join(missingCommit.path, "second.txt"), "second\n");
    git(missingCommit.path, "add", "second.txt");
    git(missingCommit.path, "commit", "-m", "second");
    missingCommit.head = git(missingCommit.path, "rev-parse", "HEAD");
    const parent = git(missingCommit.path, "rev-parse", "HEAD^");
    rmSync(join(missingCommit.path, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
    expectCode(() => relocatePrimaryRepo(requestFor(missingCommit)), "TARGET_NOT_GIT_CHECKOUT");

    const missingTree = seedPair({ legacyId: 663, targetId: 1510, name: "missing-tree" });
    writeFileSync(join(missingTree.path, "second.txt"), "second\n");
    git(missingTree.path, "add", "second.txt");
    git(missingTree.path, "commit", "-m", "second");
    missingTree.head = git(missingTree.path, "rev-parse", "HEAD");
    const parentTree = git(missingTree.path, "rev-parse", "HEAD^{tree}");
    rmSync(join(missingTree.path, ".git", "objects", parentTree.slice(0, 2), parentTree.slice(2)));
    expectCode(() => relocatePrimaryRepo(requestFor(missingTree)), "TARGET_NOT_GIT_CHECKOUT");
  });

  it("rejects corrupt loose and packed objects", () => {
    const loose = seedPair({ name: "corrupt-loose" });
    const blob = git(loose.path, "rev-parse", "HEAD:README.md");
    const loosePath = join(loose.path, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(loosePath, 0o644);
    writeFileSync(loosePath, "corrupt");
    expectCode(() => relocatePrimaryRepo(requestFor(loose)), "TARGET_NOT_GIT_CHECKOUT");

    const packed = seedPair({ legacyId: 662, targetId: 1509, name: "corrupt-pack" });
    git(packed.path, "gc", "--prune=now");
    const packDir = join(packed.path, ".git", "objects", "pack");
    const pack = join(packDir, readdirSync(packDir).find((name) => name.endsWith(".pack"))!);
    const bytes = readFileSync(pack);
    bytes[Math.min(64, bytes.length - 1)]! ^= 0xff;
    chmodSync(pack, 0o644);
    writeFileSync(pack, bytes);
    expectCode(() => relocatePrimaryRepo(requestFor(packed)), "TARGET_NOT_GIT_CHECKOUT");
  });

  it("rejects repository-local fsck severity overrides that suppress malformed reachable objects", () => {
    const pair = seedPair({ name: "fsck-policy" });
    const tree = git(pair.path, "rev-parse", "HEAD^{tree}");
    const malformedCommit = execFileSync(
      "git",
      ["-C", pair.path, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
      {
        encoding: "utf8",
        input: `tree ${tree}\nauthor Missing Email 1700000000 +0000\ncommitter Missing Email 1700000000 +0000\n\nmalformed\n`,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    git(pair.path, "update-ref", "refs/heads/malformed", malformedCommit);
    git(pair.path, "config", "fsck.missingEmail", "ignore");

    expectCode(() => relocatePrimaryRepo(requestFor(pair)), "TARGET_UNTRUSTED_GIT_AUTHORITY");
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

  it("rejects case-distinct untracked collisions even when local core.ignoreCase is true", () => {
    const dryRun = seedPair({ legacyId: 661, targetId: 1508, name: "case-dry-run" });
    git(dryRun.path, "config", "core.ignoreCase", "true");
    writeFileSync(join(dryRun.path, "readme.md"), "untracked collision\n");
    expect(git(dryRun.path, "ls-files", "--others", "--exclude-standard")).toBe("");
    expectCode(() => relocatePrimaryRepo(requestFor(dryRun)), "TARGET_DIRTY");

    const apply = seedPair({ legacyId: 662, targetId: 1509, name: "case-apply" });
    git(apply.path, "config", "core.ignoreCase", "true");
    const request = requestFor(apply);
    const reviewed = relocatePrimaryRepo(request);
    writeFileSync(join(apply.path, "readme.md"), "untracked after review\n");
    expectCode(() => relocatePrimaryRepo({
      ...request,
      apply: true,
      expectedPlanHash: reviewed.plan.plan_hash,
    }), "TARGET_DIRTY");
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

  it("rebinds catalog and path-only leases, reconciles graph edges, and preserves prior audits", () => {
    const pair = seedPair();
    const db = getDb();
    // Migration 14 now creates the shipped lease table on open. These cases
    // deliberately exercise the *reduced* shape carried by stations whose table
    // predates that migration, so the fixture replaces it.
    db.exec("DROP TABLE IF EXISTS worktree_leases");
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
    expect(applied.plan.counts.repo_relocation_audit).toEqual({ legacy: 0, target: 1, move: 0, dedupe: 0, block: 0 });
    expect(db.query("SELECT repo_id FROM repo_relocation_audit WHERE id = 'prior'").get()).toEqual({ repo_id: pair.targetId });
  });

  it("fails closed when an exact relocation-path lease belongs to a third registered repo", () => {
    const pair = seedPair();
    const db = getDb();
    const thirdPath = join(root, "third-registered-repo");
    insertRepo(1700, thirdPath, "third", "https://github.com/hasna/third.git");
    // Migration 14 now creates the shipped lease table on open. These cases
    // deliberately exercise the *reduced* shape carried by stations whose table
    // predates that migration, so the fixture replaces it.
    db.exec("DROP TABLE IF EXISTS worktree_leases");
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

  it("rolls back when an audit trigger substitutes the just-inserted receipt", () => {
    const pair = seedPair();
    const request = requestFor(pair);
    const dry = relocatePrimaryRepo(request);
    getDb().exec(`CREATE TRIGGER substitute_receipt AFTER INSERT ON repo_relocation_audit
      BEGIN
        UPDATE repo_relocation_audit SET actor = 'trigger:substitution' WHERE id = NEW.id;
      END`);

    expectCode(() => relocatePrimaryRepo({
      ...request,
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "TRANSACTION_CONFLICT");
    expect(getDb().query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
    expect(getDb().query("SELECT id, path FROM repos ORDER BY id").all()).toEqual([
      { id: pair.legacyId, path: pair.sourcePath },
      { id: pair.targetId, path: pair.path },
    ]);
  });

  it("rolls back same-cardinality post-receipt drift across planned relocation state", () => {
    const pair = seedPair();
    const db = getDb();
    insertChildFixtures(pair.legacyId, pair.targetId);
    // Migration 14 now creates the shipped lease table on open. These cases
    // deliberately exercise the *reduced* shape carried by stations whose table
    // predates that migration, so the fixture replaces it.
    db.exec("DROP TABLE IF EXISTS worktree_leases");
    db.exec(`CREATE TABLE worktree_leases (
      lease_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL,
      repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    db.query("INSERT INTO worktree_leases (lease_id, repo_path, repo_catalog_id) VALUES ('target-lease', ?, ?)")
      .run(pair.path, pair.targetId);
    db.query("INSERT INTO edges (source_type, source_id, relation, target_type, target_id, metadata) VALUES ('repo', ?, 'depends_on', 'repo', '999', '{}')")
      .run(String(pair.targetId));
    const request = requestFor(pair);
    const dry = relocatePrimaryRepo(request);
    const beforeCommit = db.query("SELECT id, message FROM commits ORDER BY id").all();
    db.exec(`CREATE TRIGGER substitute_relocation_state AFTER INSERT ON repo_relocation_audit
      BEGIN
        UPDATE repos SET name = 'canonical-substitution' WHERE id = NEW.repo_id;
        UPDATE commits SET message = 'same-count-substitution'
          WHERE id = (SELECT min(id) FROM commits WHERE repo_id = NEW.repo_id);
        UPDATE edges SET metadata = '{"trigger":true}'
          WHERE id = (SELECT min(id) FROM edges);
        UPDATE worktree_leases SET metadata = '{"trigger":true}'
          WHERE lease_id = 'target-lease';
      END`);

    expectCode(() => relocatePrimaryRepo({
      ...request,
      apply: true,
      expectedPlanHash: dry.plan.plan_hash,
    }), "TRANSACTION_CONFLICT");
    expect(db.query("SELECT id, message FROM commits ORDER BY id").all()).toEqual(beforeCommit);
    expect(db.query("SELECT metadata FROM edges").get()).toEqual({ metadata: "{}" });
    expect(db.query("SELECT metadata FROM worktree_leases").get()).toEqual({ metadata: "{}" });
    expect(db.query("SELECT count(*) AS count FROM repo_relocation_audit").get()).toEqual({ count: 0 });
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

  it("keeps historical receipts immutable across chained absorptions and exact replay", () => {
    const firstPair = seedPair({ legacyId: 2, targetId: 3, name: "chain" });
    const firstRequest = requestFor(firstPair, { idempotencyKey: "chain-3-into-2" });
    const firstDry = relocatePrimaryRepo(firstRequest);
    const first = relocatePrimaryRepo({
      ...firstRequest,
      apply: true,
      expectedPlanHash: firstDry.plan.plan_hash,
    });
    const persistedBefore = getDb().query(
      "SELECT * FROM repo_relocation_audit WHERE id = ?",
    ).get(first.receipt!.id);

    insertRepo(1, join(root, "source-state-is-never-read", "chain-root"), "chain");
    const secondPair = {
      legacyId: 1,
      targetId: 2,
      name: "chain",
      sourcePath: join(root, "source-state-is-never-read", "chain-root"),
      path: firstPair.path,
      head: firstPair.head,
    };
    const secondTargetRevision = String((getDb().query("SELECT updated_at FROM repos WHERE id = 2").get() as { updated_at: string }).updated_at);
    const secondRequest = requestFor(secondPair, {
      expectedTargetRevision: secondTargetRevision,
      idempotencyKey: "chain-2-into-1",
    });
    const secondDry = relocatePrimaryRepo(secondRequest);
    relocatePrimaryRepo({ ...secondRequest, apply: true, expectedPlanHash: secondDry.plan.plan_hash });

    const replay = relocatePrimaryRepo({
      ...firstRequest,
      apply: true,
      expectedPlanHash: firstDry.plan.plan_hash,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.repo_id).toBe(2);
    expect(replay.before.id).toBe(2);
    expect(getDb().query("SELECT * FROM repo_relocation_audit WHERE id = ?").get(first.receipt!.id))
      .toEqual(persistedBefore);
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
