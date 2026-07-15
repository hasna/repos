import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function insertRepo(id: number, path: string, name: string, remote = `https://github.com/hasna/${name}.git`) {
  getDb().query(`INSERT INTO repos (
    id, path, name, org, remote_url, default_branch, description,
    last_scanned, commit_count, branch_count, tag_count, updated_at
  ) VALUES (?, ?, ?, 'hasna', ?, 'main', 'fixture', '2026-07-14T00:00:00Z', 0, 0, 0, ?)`)
    .run(id, path, name, remote, `revision-${id}`);
}

function seedPair(options: { legacyId?: number; targetId?: number; name?: string; sourcePath?: string } = {}) {
  const legacyId = options.legacyId ?? 661;
  const targetId = options.targetId ?? 1508;
  const name = options.name ?? "accounts";
  const target = checkout(`${name}-canonical`, `https://github.com/hasna/${name}.git`);
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

  it("rebinds optional leases, reconciles graph edges, and reparents prior audits", () => {
    const pair = seedPair();
    const db = getDb();
    db.exec(`CREATE TABLE worktree_leases (
      lease_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL,
      repo_catalog_id INTEGER REFERENCES repos(id) ON DELETE SET NULL
    )`);
    db.query("INSERT INTO worktree_leases VALUES ('legacy-lease', ?, ?)").run(pair.sourcePath, pair.legacyId);
    db.query("INSERT INTO worktree_leases VALUES ('target-lease', ?, ?)").run(pair.path, pair.targetId);
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
    expect(db.query("SELECT repo_catalog_id, repo_path FROM worktree_leases ORDER BY lease_id").all()).toEqual([
      { repo_catalog_id: pair.legacyId, repo_path: pair.path },
      { repo_catalog_id: pair.legacyId, repo_path: pair.path },
    ]);
    expect(db.query("SELECT source_id FROM edges").get()).toEqual({ source_id: String(pair.legacyId) });
    expect(db.query("SELECT repo_id FROM repo_relocation_audit WHERE id = 'prior'").get()).toEqual({ repo_id: pair.legacyId });
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
      [661, 1508, "accounts"],
      [662, 1509, "sandboxes"],
      [663, 1511, "infinity"],
      [664, 1510, "codewith"],
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
