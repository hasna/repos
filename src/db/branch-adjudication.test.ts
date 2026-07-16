import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./database";
import {
  BranchAdjudicationError,
  adjudicateBranches,
  type BranchAdjudicationRequest,
} from "./branch-adjudication";

let root = "";
let repoPath = "";
let head = "";
let legacyHead = "";

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function seedGitRepo() {
  repoPath = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: ["ignore", "pipe", "pipe"] });
  git("config", "user.email", "repos-test@invalid.example");
  git("config", "user.name", "Repos Test");
  writeFileSync(join(repoPath, "README.md"), "main\n");
  git("add", "README.md");
  git("commit", "-m", "main");
  head = git("rev-parse", "HEAD");
  git("checkout", "-b", "legacy");
  writeFileSync(join(repoPath, "legacy.txt"), "legacy\n");
  git("add", "legacy.txt");
  git("commit", "-m", "legacy");
  legacyHead = git("rev-parse", "HEAD");
  git("update-ref", "refs/heads/legacy-preserved/build/test", legacyHead);
  git("checkout", "main");
  git("update-ref", "refs/heads/build/test", head);
}

function seedDb() {
  const db = getDb(":memory:");
  db.query(`INSERT INTO repos (
    id, path, name, org, remote_url, default_branch, description,
    last_scanned, commit_count, branch_count, tag_count, updated_at
  ) VALUES
    (1, ?, 'legacy', 'hasna', 'github.com/hasna/legacy', 'main', 'fixture', '2026-07-16', 0, 0, 0, 'legacy-rev'),
    (2, ?, 'target', 'hasna', 'github.com/hasna/target', 'main', 'fixture', '2026-07-16', 0, 0, 0, 'target-rev')`)
    .run(join(root, "missing-legacy"), repoPath);
  db.query("INSERT INTO branches (id, repo_id, name, is_remote, last_commit_sha, ahead, behind) VALUES (101, 1, 'build/test', 1, ?, 3, 4)")
    .run(legacyHead.slice(0, 9));
  db.query("INSERT INTO branches (id, repo_id, name, is_remote, last_commit_sha, ahead, behind) VALUES (102, 2, 'build/test', 1, ?, 5, 6)")
    .run(head.slice(0, 9));
}

function request(changes: Partial<BranchAdjudicationRequest> = {}): BranchAdjudicationRequest {
  return {
    actor: "test:branch-adjudication",
    idempotencyKey: "test-branch-adjudication",
    rows: [
      {
        id: 101,
        repoId: 1,
        name: "build/test",
        action: "reclassify-local",
        expectedIsRemote: 1,
        expectedLastCommitSha: legacyHead.slice(0, 9),
        expectedRepoRevision: "legacy-rev",
        evidenceRepoPath: repoPath,
        evidenceRef: "refs/heads/legacy-preserved/build/test",
      },
      {
        id: 102,
        repoId: 2,
        name: "build/test",
        action: "reclassify-local",
        expectedIsRemote: 1,
        expectedLastCommitSha: head.slice(0, 9),
        expectedRepoRevision: "target-rev",
        evidenceRepoPath: repoPath,
        evidenceRef: "refs/heads/build/test",
      },
    ],
    ...changes,
  };
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BranchAdjudicationError);
    expect((error as BranchAdjudicationError).code).toBe(code);
  }
}

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  root = mkdtempSync(join(tmpdir(), "repos-branch-adjudication-"));
  seedGitRepo();
  seedDb();
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
});

describe("branch adjudication", () => {
  it("plans exact branch row reclassification without writing", () => {
    const dry = adjudicateBranches(request());
    expect(dry.applied).toBe(false);
    expect(dry.plan.can_apply).toBe(true);
    expect(dry.plan.rows).toHaveLength(2);
    expect(dry.plan.rows[0]!.before.is_remote).toBe(1);
    expect(dry.plan.rows[0]!.after.is_remote).toBe(0);
    const rows = getDb(":memory:").query("SELECT id, is_remote, ahead, behind FROM branches ORDER BY id").all();
    expect(rows).toEqual([
      { id: 101, is_remote: 1, ahead: 3, behind: 4 },
      { id: 102, is_remote: 1, ahead: 5, behind: 6 },
    ]);
  });

  it("fails dry-run when a duplicate local branch row already exists", () => {
    getDb(":memory:").query("INSERT INTO branches (repo_id, name, is_remote, last_commit_sha) VALUES (1, 'build/test', 0, ?)")
      .run(legacyHead.slice(0, 9));
    expectCode(() => adjudicateBranches(request()), "DUPLICATE_LOCAL_ROW");
  });

  it("fails dry-run when evidence ref does not match stored sha", () => {
    const bad = request({ rows: [{ ...request().rows[0]!, evidenceRef: "refs/heads/build/test" }] });
    expectCode(() => adjudicateBranches(bad), "EVIDENCE_REF_MISMATCH");
  });

  it("rejects revision expressions instead of treating them as refs", () => {
    const bad = request({ rows: [{ ...request().rows[0]!, evidenceRef: "refs/heads/legacy-preserved/build/test~0" }] });
    expectCode(() => adjudicateBranches(bad), "EVIDENCE_REF_MISMATCH");
  });

  it("rejects stored commit prefixes that do not disambiguate to the evidence ref", () => {
    const bad = request({ rows: [{ ...request().rows[0]!, expectedLastCommitSha: "dead" }] });
    expectCode(() => adjudicateBranches(bad), "ROW_MISMATCH");
  });

  it("requires the reviewed plan hash for apply", () => {
    expectCode(() => adjudicateBranches(request({ apply: true })), "PLAN_HASH_REQUIRED");
  });

  it("applies only exact guarded rows and writes an audit receipt", () => {
    const dry = adjudicateBranches(request());
    const applied = adjudicateBranches(request({ apply: true, expectedPlanHash: dry.plan.plan_hash }));
    expect(applied.applied).toBe(true);
    expect(applied.replayed).toBe(false);
    expect(applied.receipt?.row_count).toBe(2);
    const rows = getDb(":memory:").query("SELECT id, is_remote, ahead, behind FROM branches ORDER BY id").all();
    expect(rows).toEqual([
      { id: 101, is_remote: 0, ahead: 0, behind: 0 },
      { id: 102, is_remote: 0, ahead: 0, behind: 0 },
    ]);
    const audits = getDb(":memory:").query("SELECT idempotency_key, plan_hash, row_count FROM branch_adjudication_audit").all();
    expect(audits).toEqual([{ idempotency_key: "test-branch-adjudication", plan_hash: dry.plan.plan_hash, row_count: 2 }]);
  });

  it("replays an idempotent apply and rejects conflicting reuse", () => {
    const dry = adjudicateBranches(request());
    adjudicateBranches(request({ apply: true, expectedPlanHash: dry.plan.plan_hash }));
    const replay = adjudicateBranches(request({ apply: true, expectedPlanHash: dry.plan.plan_hash }));
    expect(replay.replayed).toBe(true);
    expectCode(
      () => adjudicateBranches(request({
        idempotencyKey: "test-branch-adjudication",
        rows: [{ ...request().rows[0]! }],
        apply: true,
        expectedPlanHash: dry.plan.plan_hash,
      })),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("fails apply when the reviewed plan hash is stale", () => {
    const dry = adjudicateBranches(request());
    getDb(":memory:").query("UPDATE branches SET ahead = 99 WHERE id = 101").run();
    expectCode(() => adjudicateBranches(request({ apply: true, expectedPlanHash: dry.plan.plan_hash })), "PLAN_HASH_MISMATCH");
  });
});
