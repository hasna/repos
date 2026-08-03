/**
 * The unlanded-branch refusal, and the dry run a scheduled loop needs.
 *
 * `removeWorktree` already refused a dirty tree and commits that exist on no
 * remote. Neither of those is the hazard the owner directive of 2026-07-30
 * actually names: *"a worktree whose PR is almost landable — that is finished
 * work one step from shipping, and deleting it throws the work away."*
 *
 * That worktree is pushed, so `git rev-list --count HEAD --not --remotes`
 * returns 0 and the old code removed it without a word. These tests pin the
 * missing property, and each refusal carries a positive control so "refuses"
 * cannot quietly become "refuses everything" — a guard that always fires is
 * indistinguishable from a guard that is broken, and gets forced past.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import {
  WorktreeError,
  addWorktree,
  adoptWorktrees,
  removeWorktree,
  setWorktreeRootForTests,
} from "./worktrees.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  setWorktreeRootForTests(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Repos Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Repos Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function commit(repoPath: string, file: string, body: string): string {
  writeFileSync(join(repoPath, file), body);
  git(repoPath, ["add", file]);
  git(repoPath, ["commit", "-m", `add ${file}`]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

function seed(repoName = "open-fixture") {
  tempDir = mkdtempSync(join(tmpdir(), "repos-worktree-landing-"));
  const root = join(tempDir, "worktrees");
  mkdirSync(root, { recursive: true });
  setWorktreeRootForTests(root);

  const originPath = join(tempDir, "origin.git");
  const seedPath = join(tempDir, "seed");
  mkdirSync(seedPath, { recursive: true });
  git(tempDir, ["init", "--bare", "--initial-branch=main", originPath]);
  git(seedPath, ["init", "--initial-branch=main"]);
  commit(seedPath, "README.md", "seed\n");
  git(seedPath, ["remote", "add", "origin", originPath]);
  git(seedPath, ["push", "-u", "origin", "main"]);

  const clonePath = join(tempDir, "clone");
  git(tempDir, ["clone", originPath, clonePath]);

  const dbPath = join(tempDir, "repos.db");
  const db = getDb(dbPath);
  db.prepare(
    "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, ?, 'hasna', ?, 'main', ?)",
  ).run(clonePath, repoName, `github.com/hasna/${repoName}`, "2026-07-01 00:00:00");
  const repoId = Number(
    (db.query("SELECT id FROM repos WHERE path = ?").get(clonePath) as { id: number }).id,
  );

  return { root, originPath, seedPath, clonePath, dbPath, db, repoName, repoId };
}

/** The one shape that matters: a worktree whose branch is pushed to origin. */
function pushedWorktree(repoName: string, task: string) {
  const created = addWorktree({ repo: repoName, task });
  commit(created.path, `${task}.md`, `work for ${task}\n`);
  git(created.path, ["push", "-u", "origin", "HEAD"]);
  return created;
}

/**
 * A worktree the way this station's ~444-entry corpus was actually made: by
 * hand with `git worktree add`, carrying no lease, sitting under the worktree
 * root for `adopt --all` to find.
 *
 * `addWorktree` cannot stand in for this and no `addWorktree` fixture can ever
 * exercise the adopted path, because `addWorktree` writes the lease itself —
 * with a base ref it was given. The whole defect lives in the base ref that
 * `adoptWorktrees` synthesises for a worktree that arrived without one.
 */
function unleasedWorktree(clonePath: string, root: string, repoName: string, name: string): string {
  const path = join(root, repoName, name);
  mkdirSync(join(root, repoName), { recursive: true });
  git(clonePath, ["worktree", "add", "-b", name, path, "origin/main"]);
  commit(path, `${name}.md`, `work for ${name}\n`);
  git(path, ["push", "-u", "origin", "HEAD"]);
  return path;
}

function recordPullRequest(
  repoId: number,
  fields: { number: number; head_branch: string; head_sha?: string | null; state: string; merged_at?: string | null },
): void {
  getDb().prepare(
    `INSERT INTO pull_requests
       (repo_id, number, title, state, author, created_at, updated_at, merged_at, url, base_branch, head_branch, head_sha)
     VALUES (?, ?, ?, ?, 'hermes', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', ?, ?, 'main', ?, ?)`,
  ).run(
    repoId,
    fields.number,
    `PR ${fields.number}`,
    fields.state,
    fields.merged_at ?? null,
    `https://github.com/hasna/fixture/pull/${fields.number}`,
    fields.head_branch,
    fields.head_sha ?? null,
  );
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof WorktreeError) return error.code;
    return `UNEXPECTED:${(error as Error).message}`;
  }
  return "NO_ERROR";
}

function errorOf(run: () => unknown): WorktreeError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorktreeError) return error;
    throw error;
  }
  throw new Error("expected WorktreeError");
}

describe("removeWorktree — the unlanded branch", () => {
  test("refuses a worktree whose pull request is still open", () => {
    // The directive's named hazard, reproduced exactly: pushed, so the unpushed
    // guard reads 0, and one command away from being deleted.
    const { repoName, repoId } = seed();
    const created = pushedWorktree(repoName, "open-pr");
    recordPullRequest(repoId, { number: 41, head_branch: "open-pr", state: "open" });

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id }))).toBe("WORKTREE_UNLANDED");
    expect(existsSync(created.path)).toBe(true);
    // And --discard-changes must NOT be the escape hatch for it: discarding an
    // uncommitted edit and destroying an open PR's worktree are different
    // decisions, and the hazard gets its own opt-in.
    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id, discardChanges: true })))
      .toBe("WORKTREE_UNLANDED");
    expect(existsSync(created.path)).toBe(true);
  });

  test("removes the same worktree once the index records the pull request as merged", () => {
    // The positive control for the test above. Same fixture, same push, one
    // column different — so the refusal is attributable to the PR state and not
    // to the guard refusing everything.
    const { repoName, repoId } = seed();
    const created = pushedWorktree(repoName, "merged-pr");
    recordPullRequest(repoId, {
      number: 42,
      head_branch: "merged-pr",
      head_sha: git(created.path, ["rev-parse", "HEAD"]),
      state: "merged",
      merged_at: "2026-07-30T01:00:00Z",
    });

    const result = removeWorktree({ ref: created.lease.lease_id });
    expect(result.removed).toBe(true);
    expect(result.landing.landed).toBe(true);
    expect(result.landing.reason).toBe("pull-request-merged");
    expect(existsSync(created.path)).toBe(false);
  });

  test("refuses a newer pushed commit when the cached merged pull request names an older head", () => {
    const { repoName, repoId, seedPath, clonePath } = seed();
    const created = pushedWorktree(repoName, "reused-after-merge");
    const mergedHead = git(created.path, ["rev-parse", "HEAD"]);

    git(seedPath, ["fetch", "origin"]);
    git(seedPath, ["merge", "--squash", "origin/reused-after-merge"]);
    git(seedPath, ["commit", "-m", "feat: the original landing (#42)"]);
    git(seedPath, ["push", "origin", "main"]);
    git(clonePath, ["fetch", "origin"]);
    recordPullRequest(repoId, {
      number: 42,
      head_branch: "reused-after-merge",
      head_sha: mergedHead,
      state: "merged",
      merged_at: "2026-07-30T01:00:00Z",
    });

    commit(created.path, "AFTER-MERGE.md", "new work that is not in main\n");
    git(created.path, ["push", "origin", "HEAD"]);

    const dry = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(dry.landing.pull_request?.state).toBe("merged");
    expect(dry.landing.landed).toBe(false);
    expect(dry.landing.reason).toBe("not-in-base");
    expect(dry.refusal).toBe("WORKTREE_UNLANDED");
    expect(dry.would_remove).toBe(false);
    const error = errorOf(() => removeWorktree({ ref: created.lease.lease_id }));
    expect(error.message).toBe("the branch would change its base, so its work is not proven landed");
    expect(existsSync(created.path)).toBe(true);
  });

  test("refuses a pushed branch the base does not contain, with no pull request on record", () => {
    // The repos index carries no PR rows for most repos on this station, so the
    // fallback is what will actually run. It has to fail closed.
    const { repoName } = seed();
    const created = pushedWorktree(repoName, "no-pr-record");

    const error = errorOf(() => removeWorktree({ ref: created.lease.lease_id }));
    expect(error.code).toBe("WORKTREE_UNLANDED");
    expect(error.message).toBe("the branch would change its base, so its work is not proven landed");
    expect(error.details.hint).toContain("archive the branch before removing the worktree");
    expect(existsSync(created.path)).toBe(true);
  });

  test("reports an unresolved base as unknown rather than claiming the work did not land", () => {
    const { repoName, clonePath } = seed();
    const created = pushedWorktree(repoName, "missing-base");
    git(clonePath, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const error = errorOf(() => removeWorktree({ ref: created.lease.lease_id }));
    expect(error.code).toBe("WORKTREE_UNLANDED");
    expect(error.details.landing?.reason).toBe("base-unresolvable");
    expect(error.message).toBe(
      "the worktree's base could not be resolved, so whether its work landed is unknown",
    );
    expect(error.details.hint).toContain("archive the branch before removing the worktree");
    expect(existsSync(created.path)).toBe(true);
  });

  test("accepts a squash-merged branch after the forge deletes its remote branch", () => {
    // Without this control the fallback is useless. hasna merges by squash, so a
    // landed branch tip is never an ancestor of origin/main; an ancestry-only
    // check would refuse every correctly-finished worktree, every agent would
    // pass the force flag by reflex, and the guard would stop being read.
    const { repoName, seedPath, clonePath } = seed();
    const created = pushedWorktree(repoName, "squashed");

    git(seedPath, ["fetch", "origin"]);
    git(seedPath, ["merge", "--squash", "origin/squashed"]);
    git(seedPath, ["commit", "-m", "feat: the squashed landing (#43)"]);
    git(seedPath, ["push", "origin", "main"]);
    git(seedPath, ["push", "origin", "--delete", "squashed"]);
    git(clonePath, ["fetch", "--prune", "origin"]);

    const dry = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(dry.landing.base_ref).toBe("refs/remotes/origin/main");
    expect(dry.landing.reason).toBe("content-in-base");
    expect(dry.refusal).toBeNull();
    expect(dry.would_remove).toBe(true);

    const result = removeWorktree({ ref: created.lease.lease_id });
    expect(result.removed).toBe(true);
    expect(result.landing.reason).toBe("content-in-base");
  });

  test("uses the indexed default branch for a squash-merged worktree with no lease", () => {
    // A worktree made with plain `git worktree add` has no recorded base. The
    // repository row still knows the default branch, so a missing origin/HEAD
    // must not turn an otherwise resolvable origin/main into "unknown".
    const { repoName, clonePath, seedPath, root } = seed();
    const path = unleasedWorktree(clonePath, root, repoName, "stray-squashed");

    git(seedPath, ["fetch", "origin"]);
    git(seedPath, ["merge", "--squash", "origin/stray-squashed"]);
    git(seedPath, ["commit", "-m", "feat: the stray landing (#44)"]);
    git(seedPath, ["push", "origin", "main"]);
    git(seedPath, ["push", "origin", "--delete", "stray-squashed"]);
    git(clonePath, ["fetch", "--prune", "origin"]);
    git(clonePath, ["update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD"]);

    expect(git(path, ["rev-parse", "--verify", "origin/main"])).toBeTruthy();
    const result = removeWorktree({ ref: `${repoName}/stray-squashed` });
    expect(result.removed).toBe(true);
    expect(result.lease_id).toBeNull();
    expect(result.landing.base_ref).toBe("refs/remotes/origin/main");
    expect(result.landing.reason).toBe("content-in-base");
  });

  test("genuinely unlanded commits that exist on no remote are still refused as unpushed", () => {
    // Ordering matters for the operator: "these commits exist nowhere else" is
    // the more severe and more actionable diagnosis, and --discard-changes
    // already governs it. Reporting it as UNLANDED would send the operator to
    // the wrong flag and the wrong remedy.
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "never-pushed" });
    commit(created.path, "LOCAL.md", "only here\n");

    const dry = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(dry.landing.landed).toBe(false);
    expect(dry.landing.reason).toBe("unpushed");
    expect(dry.would_remove).toBe(false);
    expect(dry.refusal).toBe("WORKTREE_UNPUSHED");
    const error = errorOf(() => removeWorktree({ ref: created.lease.lease_id }));
    expect(error.code).toBe("WORKTREE_UNPUSHED");
    expect(error.message).toBe(
      "the worktree carries 1 commit(s) whose content is not proven in its base and whose commit objects exist on no remote",
    );
    expect(error.details.hint).toContain("archive the branch before removing the worktree");
    const forced = removeWorktree({ ref: created.lease.lease_id, discardChanges: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(join(forced.evidence_path!, "branch.bundle"))).toBe(true);
  });

  test("--allow-unlanded proceeds, and archives the branch and the pull request it overrode", () => {
    // Delete-with-archive is the directive's first requirement. An override that
    // leaves no record is exactly the hand-deletion this verb exists to replace.
    const { repoName, repoId, clonePath } = seed();
    const created = pushedWorktree(repoName, "override-me");
    recordPullRequest(repoId, { number: 44, head_branch: "override-me", state: "open" });

    const result = removeWorktree({ ref: created.lease.lease_id, allowUnlanded: true });
    expect(result.removed).toBe(true);
    expect(result.evidence_path).toBeTruthy();
    expect(existsSync(created.path)).toBe(false);

    const landing = JSON.parse(readFileSync(join(result.evidence_path!, "landing.json"), "utf8")) as {
      landed: boolean;
      reason: string;
      pull_request: { number: number; state: string } | null;
    };
    expect(landing.landed).toBe(false);
    expect(landing.pull_request?.number).toBe(44);
    // Contents, not existence: a bundle of the wrong ref satisfies existsSync.
    const bundle = join(result.evidence_path!, "branch.bundle");
    expect(existsSync(bundle)).toBe(true);
    expect(git(clonePath, ["bundle", "list-heads", bundle])).toContain("override-me");
  });

  test("the lease survives a refusal, so nothing is half-torn-down", () => {
    const { repoName, repoId } = seed();
    const created = pushedWorktree(repoName, "lease-intact");
    recordPullRequest(repoId, { number: 45, head_branch: "lease-intact", state: "open" });

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id }))).toBe("WORKTREE_UNLANDED");
    const lease = getDb().query("SELECT status, released_at FROM worktree_leases WHERE lease_id = ?")
      .get(created.lease.lease_id) as { status: string; released_at: string | null };
    expect(lease.status).toBe("claimed");
    expect(lease.released_at).toBeNull();
  });
});

describe("removeWorktree — the dry run a scheduled loop needs", () => {
  test("a dry run reports the refusal instead of throwing, and touches nothing", () => {
    // A loop enumerating 525 worktrees cannot drive control flow through
    // exceptions per entry, and must never mutate while enumerating. It asks
    // what would happen and gets an answer.
    const { repoName, repoId } = seed();
    const created = pushedWorktree(repoName, "loop-refusal");
    recordPullRequest(repoId, { number: 46, head_branch: "loop-refusal", state: "open" });

    const result = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.would_remove).toBe(false);
    expect(result.refusal).toBe("WORKTREE_UNLANDED");
    expect(result.evidence_path).toBeNull();
    expect(existsSync(created.path)).toBe(true);

    const lease = getDb().query("SELECT status FROM worktree_leases WHERE lease_id = ?")
      .get(created.lease.lease_id) as { status: string };
    expect(lease.status).toBe("claimed");
  });

  test("a dry run on a removable worktree says so, and still removes nothing", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "loop-clean" });

    const result = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(result.would_remove).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.removed).toBe(false);
    expect(existsSync(created.path)).toBe(true);

    // And the same call without the flag does what the dry run predicted.
    expect(removeWorktree({ ref: created.lease.lease_id }).removed).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });

  test("a dry run reports a dirty tree too, so one loop pass classifies every hazard", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "loop-dirty" });
    writeFileSync(join(created.path, "README.md"), "uncommitted edit\n");

    const result = removeWorktree({ ref: created.lease.lease_id, dryRun: true });
    expect(result.would_remove).toBe(false);
    expect(result.refusal).toBe("WORKTREE_DIRTY");
    expect(existsSync(created.path)).toBe(true);
  });

  test("a dry run still refuses to be handed a path", () => {
    // The dry run is not a softer parser. Argument-shape refusals are errors in
    // every mode, because a loop that can name a path is a loop that can be
    // pointed at one.
    const { repoName } = seed();
    addWorktree({ repo: repoName, task: "loop-path" });
    expect(codeOf(() => removeWorktree({ ref: "/etc", dryRun: true }))).toBe("INVALID_REQUEST");
  });
});

/**
 * The adopted corpus — the population this guard exists to protect.
 *
 * Every test above builds its fixture with `addWorktree`, which is handed a
 * base ref. That is structurally incapable of reaching the bug reproduced here:
 * `adopt --all --apply` SYNTHESISES a base ref, and it was synthesising the
 * worktree's own branch. The landed check then asked whether a branch contains
 * itself, which is true by construction, so every adopted worktree read as
 * landed and went down the delete-without-archive path — on the ~444 entries
 * the refusal was written for.
 */
describe("adopt — the base ref an adopted worktree is judged against", () => {
  test("adopt records the repository's default branch, never the worktree's own branch", () => {
    const { repoName, clonePath, root, db } = seed();
    const path = unleasedWorktree(clonePath, root, repoName, "adopted-open");

    const adoption = adoptWorktrees({ all: true, apply: true, db });
    const record = adoption.adopted.find((entry) => entry.path === path)!;
    expect(record.lease_id).toBeTruthy();

    const lease = db.query("SELECT branch, base_ref FROM worktree_leases WHERE lease_id = ?")
      .get(record.lease_id!) as { branch: string; base_ref: string };
    expect(lease.branch).toBe("adopted-open");
    // The whole defect in one assertion: this used to read "adopted-open".
    expect(lease.base_ref).toBe("main");

    // And the guard consequently sees the adopted worktree for what it is.
    const dry = removeWorktree({ ref: record.lease_id!, dryRun: true });
    expect(dry.landing.landed).toBe(false);
    expect(dry.landing.reason).toBe("not-in-base");
    expect(dry.would_remove).toBe(false);
    expect(dry.refusal).toBe("WORKTREE_UNLANDED");
    expect(existsSync(path)).toBe(true);
  });

  test("a lease whose base ref IS its own branch fails closed instead of self-approving", () => {
    // Fixing `adopt` does not rewrite the rows it already wrote. Every lease
    // adopted before this change carries base_ref = branch, so the landed check
    // itself has to refuse the self-referential question rather than answer
    // "yes, the branch contains itself" and delete the work.
    const { repoName, clonePath, root, db } = seed();
    const path = unleasedWorktree(clonePath, root, repoName, "legacy-row");
    const record = adoptWorktrees({ all: true, apply: true, db }).adopted
      .find((entry) => entry.path === path)!;
    db.query("UPDATE worktree_leases SET base_ref = branch WHERE lease_id = ?").run(record.lease_id!);

    const dry = removeWorktree({ ref: record.lease_id!, dryRun: true });
    expect(dry.landing.landed).toBe(false);
    expect(dry.landing.reason).toBe("base-is-branch");
    expect(dry.would_remove).toBe(false);
    expect(dry.refusal).toBe("WORKTREE_UNLANDED");
    expect(existsSync(path)).toBe(true);

    // Failing closed has to reach the ARCHIVE path, not merely a slower delete:
    // the reproduced defect was `removed=true evidence=null`.
    const forced = removeWorktree({ ref: record.lease_id!, allowUnlanded: true });
    expect(forced.removed).toBe(true);
    expect(forced.evidence_path).toBeTruthy();
    expect(existsSync(join(forced.evidence_path!, "branch.bundle"))).toBe(true);
    expect(git(clonePath, ["bundle", "list-heads", join(forced.evidence_path!, "branch.bundle")]))
      .toContain("legacy-row");
  });

  test("an adopted worktree whose work reached the default branch is still removable", () => {
    // The positive control. Without it "adopted worktrees are refused" could be
    // satisfied by a guard that refuses every adopted worktree, which is the
    // failure mode that teaches operators to pass --allow-unlanded by reflex.
    const { repoName, clonePath, seedPath, root, db } = seed();
    const path = unleasedWorktree(clonePath, root, repoName, "adopted-landed");
    const record = adoptWorktrees({ all: true, apply: true, db }).adopted
      .find((entry) => entry.path === path)!;

    git(seedPath, ["fetch", "origin"]);
    git(seedPath, ["merge", "--squash", "origin/adopted-landed"]);
    git(seedPath, ["commit", "-m", "feat: the adopted landing (#47)"]);
    git(seedPath, ["push", "origin", "main"]);
    git(clonePath, ["fetch", "origin"]);

    const result = removeWorktree({ ref: record.lease_id! });
    expect(result.removed).toBe(true);
    // The reason is load-bearing: "ancestor-of-base" here would mean the branch
    // was measured against itself again and passed for the old wrong reason.
    expect(result.landing.reason).toBe("content-in-base");
    expect(existsSync(path)).toBe(false);
  });
});
