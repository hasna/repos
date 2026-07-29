import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import {
  WorktreeError,
  addWorktree,
  adoptWorktrees,
  assertWorktreeName,
  computeWorktreePath,
  listWorktrees,
  releaseWorktree,
  removeWorktree,
  setWorktreeRootForTests,
  worktreeRootDir,
} from "./worktrees.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  setWorktreeRootForTests(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

/**
 * Git invoked with the developer's own configuration neutralised.
 *
 * The fixtures have to behave identically on a station whose global gitconfig
 * sets `init.defaultBranch`, a commit template, hooks or a credential helper.
 * A test that quietly inherits those is testing the station, not the code.
 */
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

/**
 * An origin plus a clone of it, a registry row for the clone, and a worktree
 * root — the minimum shape every verb operates on.
 */
function seed(opts: { repoName?: string; withOrigin?: boolean } = {}) {
  const repoName = opts.repoName ?? "open-fixture";
  tempDir = mkdtempSync(join(tmpdir(), "repos-worktree-"));
  const root = join(tempDir, "worktrees");
  mkdirSync(root, { recursive: true });
  setWorktreeRootForTests(root);

  const originPath = join(tempDir, "origin.git");
  const seedPath = join(tempDir, "seed");
  mkdirSync(seedPath, { recursive: true });
  git(tempDir, ["init", "--bare", "--initial-branch=main", originPath]);
  git(seedPath, ["init", "--initial-branch=main"]);
  const firstSha = commit(seedPath, "README.md", "seed\n");
  git(seedPath, ["remote", "add", "origin", originPath]);
  git(seedPath, ["push", "-u", "origin", "main"]);

  const clonePath = join(tempDir, "clone");
  if (opts.withOrigin === false) {
    git(tempDir, ["clone", originPath, clonePath]);
    git(clonePath, ["remote", "remove", "origin"]);
  } else {
    git(tempDir, ["clone", originPath, clonePath]);
  }

  const dbPath = join(tempDir, "repos.db");
  const db = getDb(dbPath);
  db.prepare(
    "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, ?, 'hasna', ?, 'main', ?)",
  ).run(clonePath, repoName, `github.com/hasna/${repoName}`, "2026-07-01 00:00:00");

  return { root, originPath, seedPath, clonePath, dbPath, db, repoName, firstSha };
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

describe("worktree name and path computation", () => {
  test("a name is a single path segment, so no name can address another directory", () => {
    // The whole containment argument rests on this. If a name may contain a
    // separator or a dot-dot component then `<root>/<repo>/<name>` is not a
    // path under the root, it is a path expression the caller controls.
    for (const bad of [
      "..",
      ".",
      "",
      "a/b",
      "../escape",
      "a\\b",
      "-leading-dash",
      "with space",
      "trailing.",
      "nul\0byte",
      "x".repeat(129),
      "sub/../../etc",
    ]) {
      expect(codeOf(() => assertWorktreeName(bad))).toBe("INVALID_WORKTREE_NAME");
    }
    for (const good of ["a321ba13", "a321ba13-worktree-verbs", "pr36_fix", "OPE57.00011"]) {
      expect(assertWorktreeName(good)).toBe(good);
    }
  });

  test("the path is computed from the root, never supplied", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-worktree-path-"));
    setWorktreeRootForTests(join(tempDir, "worktrees"));
    expect(computeWorktreePath("open-repos", "a321ba13")).toBe(
      join(tempDir, "worktrees", "open-repos", "a321ba13"),
    );
  });

  test("the root is derived from the account database, not from $HOME", () => {
    // $HOME is process environment state any caller can set. If the root moved
    // with it, every containment check in this module would be bypassable by
    // one exported variable — the cheapest possible escape.
    const before = worktreeRootDir();
    const original = process.env["HOME"];
    process.env["HOME"] = "/tmp/not-the-real-home";
    try {
      expect(worktreeRootDir()).toBe(before);
    } finally {
      if (original === undefined) delete process.env["HOME"];
      else process.env["HOME"] = original;
    }
  });
});

describe("addWorktree", () => {
  test("places the worktree at the computed canonical path and records a lease", () => {
    const { root, clonePath, repoName } = seed();
    const result = addWorktree({ repo: repoName, task: "a321ba13" });

    expect(result.path).toBe(join(root, repoName, "a321ba13"));
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    expect(result.lease.status).toBe("claimed");
    expect(result.lease.task_id).toBe("a321ba13");
    expect(result.lease.worktree_path).toBe(result.path);
    expect(result.created).toBe(true);

    const listed = git(clonePath, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(realpathSync(result.path));
  });

  test("refuses a crafted name that would escape the root, and writes nothing", () => {
    // The adversarial-review finding this pins: without single-segment
    // validation, `--name ../../etc` resolves outside the root before any
    // containment check downstream ever runs.
    const { root, repoName } = seed();
    expect(codeOf(() => addWorktree({ repo: repoName, name: "../../escape" })))
      .toBe("INVALID_WORKTREE_NAME");
    expect(codeOf(() => addWorktree({ repo: repoName, task: "../escape" })))
      .toBe("INVALID_WORKTREE_NAME");
    expect(readdirSync(root)).toEqual([]);
  });

  test("refuses a broken parent checkout instead of wedging on it", () => {
    // The live instance: registry row 92's `.git` holds only `hooks/` and
    // `worktrees/`, and `git rev-parse` there exits 128. Every verb that
    // assumes a healthy parent turns that into a confusing git error.
    const { clonePath, repoName } = seed();
    rmSync(join(clonePath, ".git"), { recursive: true, force: true });
    mkdirSync(join(clonePath, ".git", "hooks"), { recursive: true });
    mkdirSync(join(clonePath, ".git", "worktrees"), { recursive: true });

    expect(codeOf(() => addWorktree({ repo: repoName, task: "a321ba13" })))
      .toBe("PARENT_CHECKOUT_BROKEN");
  });

  test("refuses an occupied path and leaves its contents untouched", () => {
    // THE REGRESSION THIS PINS. iapp-factory's addWorktree began by force-removing
    // whatever sat at the target path — `git worktree remove --force`, `prune`,
    // then `rmSync(recursive, force)`. A destructive teardown is not a
    // precondition for a create, and this asserts the file survives.
    const { root, repoName } = seed();
    const occupied = join(root, repoName, "a321ba13");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "PRECIOUS.txt"), "not yours to delete\n");

    expect(codeOf(() => addWorktree({ repo: repoName, task: "a321ba13" })))
      .toBe("WORKTREE_PATH_OCCUPIED");
    expect(readFileSync(join(occupied, "PRECIOUS.txt"), "utf8")).toBe("not yours to delete\n");
  });

  test("re-adding the same task returns the existing lease rather than recreating it", () => {
    const { repoName } = seed();
    const first = addWorktree({ repo: repoName, task: "a321ba13" });
    writeFileSync(join(first.path, "WORK-IN-PROGRESS.txt"), "half-finished\n");

    const second = addWorktree({ repo: repoName, task: "a321ba13" });
    expect(second.lease.lease_id).toBe(first.lease.lease_id);
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    expect(readFileSync(join(first.path, "WORK-IN-PROGRESS.txt"), "utf8")).toBe("half-finished\n");
  });

  test("pins the base from origin, not from a stale local HEAD", () => {
    // A worktree branched off a local HEAD that is three days behind origin
    // produces a PR full of other people's reverts. The fetch is the point.
    const { seedPath, clonePath, repoName } = seed();
    const advanced = commit(seedPath, "SECOND.md", "advanced\n");
    git(seedPath, ["push", "origin", "main"]);
    const staleLocal = git(clonePath, ["rev-parse", "HEAD"]);
    expect(staleLocal).not.toBe(advanced);

    const result = addWorktree({ repo: repoName, task: "a321ba13" });
    expect(result.base.sha).toBe(advanced);
    expect(result.base.source).toBe("origin");
    expect(result.lease.base_sha).toBe(advanced);
  });

  test("fails closed when the base cannot be fetched from origin", () => {
    // Silently branching off whatever is local is the degradation this refuses.
    const { clonePath, repoName } = seed();
    git(clonePath, ["remote", "set-url", "origin", join(tempDir, "no-such-origin.git")]);
    expect(codeOf(() => addWorktree({ repo: repoName, task: "a321ba13" })))
      .toBe("BASE_REF_UNRESOLVABLE");
  });

  test("resolves the base locally, and says so, when the repo has no remote", () => {
    // Not a fallback: a repo with no origin has no upstream that could be
    // fresher. The distinction is recorded rather than hidden.
    const { repoName } = seed({ withOrigin: false });
    const result = addWorktree({ repo: repoName, task: "a321ba13" });
    expect(result.base.source).toBe("local");
  });

  test("requires exactly one of --task and --name", () => {
    const { repoName } = seed();
    expect(codeOf(() => addWorktree({ repo: repoName }))).toBe("INVALID_REQUEST");
    expect(codeOf(() => addWorktree({ repo: repoName, task: "a", name: "b" }))).toBe("INVALID_REQUEST");
  });

  test("reports an unknown repo rather than inventing a path for it", () => {
    const {} = seed();
    expect(codeOf(() => addWorktree({ repo: "open-not-registered", task: "a321ba13" })))
      .toBe("REPO_NOT_FOUND");
  });

  test("keeps the measured ambiguity hard-fail", () => {
    const { db, repoName } = seed();
    db.prepare(
      "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, ?, 'hasna', ?, 'main', ?)",
    ).run(join(tempDir, "second-clone"), repoName, `github.com/hasna/${repoName}`, "2026-07-01 00:00:00");
    expect(codeOf(() => addWorktree({ repo: repoName, task: "a321ba13" }))).toBe("AMBIGUOUS_REPO");
  });
});

describe("removeWorktree", () => {
  test("cannot be handed a filesystem path at all", () => {
    // The factory hazard becomes unrepresentable rather than guarded: there is
    // no argument shape in which a victim path can be passed.
    const { root, repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "a321ba13" });
    for (const ref of [
      created.path,
      "/etc",
      "../../etc",
      "~/.hasna",
      join(root, repoName, "a321ba13"),
      "repo/name/extra",
      "./a321ba13",
    ]) {
      expect(codeOf(() => removeWorktree({ ref }))).toBe("INVALID_REQUEST");
    }
    expect(existsSync(created.path)).toBe(true);
  });

  test("removes by lease id and by repo/name", () => {
    const { repoName } = seed();
    const byLease = addWorktree({ repo: repoName, task: "lease-ref" });
    expect(removeWorktree({ ref: byLease.lease.lease_id }).removed).toBe(true);
    expect(existsSync(byLease.path)).toBe(false);

    const byPair = addWorktree({ repo: repoName, task: "pair-ref" });
    expect(removeWorktree({ ref: `${repoName}/pair-ref` }).removed).toBe(true);
    expect(existsSync(byPair.path)).toBe(false);
  });

  test("refuses a dirty worktree unless changes are explicitly discarded", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "dirty" });
    writeFileSync(join(created.path, "README.md"), "uncommitted edit\n");

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id }))).toBe("WORKTREE_DIRTY");
    expect(existsSync(created.path)).toBe(true);

    const forced = removeWorktree({ ref: created.lease.lease_id, discardChanges: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(created.path)).toBe(false);
    expect(forced.evidence_path).toBeTruthy();
    expect(readFileSync(join(forced.evidence_path!, "dirty-status.txt"), "utf8")).toContain("README.md");
    expect(readFileSync(join(forced.evidence_path!, "tracked-changes.patch"), "utf8"))
      .toContain("uncommitted edit");
  });

  test("refuses a worktree carrying commits that exist nowhere else", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "unpushed" });
    commit(created.path, "NEW-WORK.md", "only here\n");

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id }))).toBe("WORKTREE_UNPUSHED");

    const forced = removeWorktree({ ref: created.lease.lease_id, discardChanges: true });
    expect(existsSync(join(forced.evidence_path!, "branch.bundle"))).toBe(true);
  });

  test("refuses when the lease path has been replaced by a symlink out of the root", () => {
    // Containment is checked after symlink resolution, because a directory that
    // was inside the root when the lease was written may not be now.
    const { root, repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "symlinked" });
    const outside = join(tempDir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "KEEP.txt"), "not in the root\n");
    rmSync(created.path, { recursive: true, force: true });
    symlinkSync(outside, created.path);

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id, discardChanges: true })))
      .toBe("PATH_OUTSIDE_ROOT");
    expect(readFileSync(join(outside, "KEEP.txt"), "utf8")).toBe("not in the root\n");
    expect(root).toBeTruthy();
  });

  test("refuses to act on the parent checkout", () => {
    const { clonePath, repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "parent" });
    // Point the lease at the parent checkout, the way a corrupted or
    // hand-edited row would.
    getDb().prepare("UPDATE worktree_leases SET worktree_path = ? WHERE lease_id = ?")
      .run(clonePath, created.lease.lease_id);

    expect(codeOf(() => removeWorktree({ ref: created.lease.lease_id, discardChanges: true })))
      .toBe("PATH_OUTSIDE_ROOT");
    expect(existsSync(join(clonePath, "README.md"))).toBe(true);
  });
});

describe("listWorktrees", () => {
  test("reconciles leases against disk and names the measured corruption classes", () => {
    const { root, repoName } = seed();
    const live = addWorktree({ repo: repoName, task: "live-one" });

    // A flat task-named directory directly under the root — the largest class
    // in the 444-entry corpus measured on this station.
    const flat = join(root, "accounts-pr16-resolve");
    mkdirSync(flat, { recursive: true });
    git(tempDir, ["init", "--initial-branch=main", flat]);

    // A machine-segment directory, explicitly forbidden by the convention.
    const stationDir = join(root, "station01", "open-hooks", "wt_1");
    mkdirSync(stationDir, { recursive: true });
    git(tempDir, ["init", "--initial-branch=main", stationDir]);

    // A lease whose directory is gone.
    const orphan = addWorktree({ repo: repoName, task: "orphan-lease" });
    rmSync(orphan.path, { recursive: true, force: true });

    const report = listWorktrees();
    const byPath = new Map(report.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get(live.path)?.issues).toEqual([]);
    expect(byPath.get(flat)?.issues).toContain("flat-layout");
    expect(byPath.get(flat)?.issues).toContain("no-lease");
    expect(byPath.get(stationDir)?.issues).toContain("nested-layout");
    expect(byPath.get(orphan.path)?.issues).toContain("missing-directory");
    expect(report.summary.issue_count).toBeGreaterThanOrEqual(3);
  });

  test("flags leases claimed by another machine and leases past the staleness horizon", () => {
    // The machine ids are stated explicitly rather than taken from the station.
    // This host's hostname is literally `station01`, so a fixture that hard-coded
    // a "foreign" machine name matched the real one and the mismatch check could
    // not have fired — the test would have passed for the wrong reason.
    const { repoName } = seed();
    const mine = addWorktree({ repo: repoName, task: "mine", machineId: "fixture-machine-a" });
    getDb().prepare("UPDATE worktree_leases SET claimed_at = '2026-07-09T00:00:00Z' WHERE lease_id = ?")
      .run(mine.lease.lease_id);

    const report = listWorktrees({
      staleDays: 1,
      now: new Date("2026-07-28T00:00:00Z"),
      machineId: "fixture-machine-b",
    });
    const entry = report.entries.find((row) => row.lease_id === mine.lease.lease_id);
    expect(entry?.issues).toContain("machine-mismatch");
    expect(entry?.issues).toContain("stale");
  });
});

describe("adoptWorktrees", () => {
  test("backfills a lease for a stray worktree without touching it", () => {
    const { root, clonePath, repoName } = seed();
    const stray = join(root, repoName, "hand-made");
    git(clonePath, ["worktree", "add", "-b", "hand-made", stray]);
    writeFileSync(join(stray, "STRAY.txt"), "pre-existing work\n");

    const result = adoptWorktrees({ path: stray, apply: true });
    expect(result.adopted).toHaveLength(1);
    expect(result.adopted[0]!.mode).toBe("adopted");
    expect(readFileSync(join(stray, "STRAY.txt"), "utf8")).toBe("pre-existing work\n");
  });

  test("dry run is the default and writes no lease", () => {
    const { root, clonePath, repoName } = seed();
    const stray = join(root, repoName, "hand-made");
    git(clonePath, ["worktree", "add", "-b", "hand-made", stray]);

    const result = adoptWorktrees({ path: stray });
    expect(result.applied).toBe(false);
    expect(result.adopted).toHaveLength(1);
    expect(getDb().query("SELECT count(*) AS n FROM worktree_leases").get()).toEqual({ n: 0 });
  });

  test("refuses a path outside the root and a path that is not a worktree", () => {
    const { root, repoName } = seed();
    expect(codeOf(() => adoptWorktrees({ path: join(tempDir, "elsewhere"), apply: true })))
      .toBe("PATH_OUTSIDE_ROOT");
    const notAWorktree = join(root, repoName, "just-a-dir");
    mkdirSync(notAWorktree, { recursive: true });
    expect(codeOf(() => adoptWorktrees({ path: notAWorktree, apply: true }))).toBe("NOT_A_WORKTREE");
  });

  test("bulk mode reports every stray under the root", () => {
    const { root, clonePath, repoName } = seed();
    for (const name of ["stray-a", "stray-b"]) {
      git(clonePath, ["worktree", "add", "-b", name, join(root, repoName, name)]);
    }
    const result = adoptWorktrees({ all: true });
    expect(result.adopted.map((row) => row.worktree_name).sort()).toEqual(["stray-a", "stray-b"]);
    expect(result.applied).toBe(false);
  });
});

describe("releaseWorktree", () => {
  test("a clean lease under delete-if-clean is torn down and marked released", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "release-clean" });
    const result = releaseWorktree({ leaseId: created.lease.lease_id });
    expect(result.lease.status).toBe("released");
    expect(result.removed).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });

  test("--keep releases the lease and leaves the directory in place", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "release-keep" });
    const result = releaseWorktree({ leaseId: created.lease.lease_id, keep: true });
    expect(result.lease.status).toBe("released");
    expect(result.removed).toBe(false);
    expect(existsSync(created.path)).toBe(true);
  });

  test("a dirty lease is not torn down by release", () => {
    const { repoName } = seed();
    const created = addWorktree({ repo: repoName, task: "release-dirty" });
    writeFileSync(join(created.path, "README.md"), "uncommitted\n");
    const result = releaseWorktree({ leaseId: created.lease.lease_id });
    expect(result.removed).toBe(false);
    expect(result.refusal).toBe("WORKTREE_DIRTY");
    expect(existsSync(created.path)).toBe(true);
  });
});
