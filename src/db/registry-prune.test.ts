import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./database.js";
import {
  RegistryPruneError,
  classifyRegistryPath,
  planRegistryPrune,
  pruneRegistryRows,
  REGISTRY_PRUNE_SCHEMA,
} from "./registry-prune.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

/** A registry with `present` rows whose paths exist and `absent` rows whose do not. */
function seed(opts: { present?: string[]; absent?: string[] } = {}) {
  tempDir = mkdtempSync(join(tmpdir(), "repos-prune-"));
  const dbPath = join(tempDir, "repos.db");
  const db = getDb(dbPath);
  const insert = db.prepare(
    "INSERT INTO repos (path, name, org, remote_url, default_branch, updated_at) VALUES (?, ?, 'hasna', ?, 'main', ?)",
  );
  const paths: Record<string, string> = {};
  for (const name of opts.present ?? []) {
    const path = join(tempDir, "live", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "KEEP.txt"), "do not delete me\n");
    insert.run(path, name, `github.com/hasna/${name}`, "2026-07-01 00:00:00");
    paths[name] = path;
  }
  for (const name of opts.absent ?? []) {
    const path = join(tempDir, "gone", name);
    insert.run(path, name, `github.com/hasna/${name}`, "2026-07-01 00:00:00");
    paths[name] = path;
  }
  return { db, dbPath, paths };
}

function confirmations(dbPath: string, planHash: string, key = "prune-key-1") {
  return {
    apply: true,
    expectedDatabasePath: dbPath,
    expectedPlanHash: planHash,
    actor: "test-operator",
    idempotencyKey: key,
  };
}

describe("planRegistryPrune", () => {
  test("does not plan a row whose path exists but cannot be read", () => {
    // THE FAILURE THIS PINS. `existsSync` returns false for EACCES, so a live
    // checkout under a mode-000 parent, a stale network handle or an unreachable
    // mount reads as "gone". This module's justification for existing is that a
    // missing path means there is nothing on disk to lose — which is false for a
    // path we merely cannot see, and such a directory may hold the only surviving
    // copy of a deleted repository. statSync distinguishes EACCES from ENOENT, so
    // this is decidable rather than a judgement call.
    const { db, dbPath, paths } = seed({ absent: ["open-unreadable", "open-gone"] });
    const plan = planRegistryPrune({
      db,
      databasePath: dbPath,
      pathState: (path) => (path === paths["open-unreadable"] ? "undetermined" : "missing"),
    });
    expect(plan.rows.map((row) => row.name)).toEqual(["open-gone"]);
    expect(plan.undetermined.map((row) => row.name)).toEqual(["open-unreadable"]);
    expect(plan.undetermined_count).toBe(1);
  });

  test("classifies an unreadable directory as undetermined, not missing", () => {
    // Exercises the real predicate rather than an injected one: the directory
    // exists, and only its parent's mode hides it.
    tempDir = mkdtempSync(join(tmpdir(), "repos-prune-eacces-"));
    const locked = join(tempDir, "locked");
    const inside = join(locked, "livedata");
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "IMPORTANT.txt"), "only surviving copy\n");
    chmodSync(locked, 0o000);
    try {
      expect(classifyRegistryPath(inside)).toBe("undetermined");
      expect(classifyRegistryPath(join(tempDir, "never-existed"))).toBe("missing");
      expect(classifyRegistryPath(tempDir)).toBe("present");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("derives the compared database from the open connection, not a global resolver", () => {
    // getDbPath() is a pure env/cwd/$HOME resolver with no link to the open
    // connection: getDb(fixture) then getDbPath() still returns the production
    // path. A caller passing { db } without databasePath therefore had
    // expectedDatabasePath validated against a database that was not the one being
    // written to — precisely the "right rows, wrong database" failure this guard
    // exists to catch.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const plan = planRegistryPrune({ db });
    expect(plan.database).toBe(dbPath);
  });

  test("selects only rows whose path does not exist", () => {
    const { db, dbPath } = seed({ present: ["open-live"], absent: ["open-gone", "open-also-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    expect(plan.row_count).toBe(2);
    expect(plan.rows.map((row) => row.name).sort()).toEqual(["open-also-gone", "open-gone"]);
    expect(plan.schema).toBe(REGISTRY_PRUNE_SCHEMA);
  });

  test("reports the child rows a delete would cascade away", () => {
    // An operator approving a delete needs to know it also removes 5000 commits.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const repoId = (db.query("SELECT id FROM repos WHERE name = 'open-gone'").get() as { id: number }).id;
    const insertCommit = db.prepare(
      "INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, ?, 'a', 'a@a', '2026-01-01', 'm')",
    );
    for (let i = 0; i < 4; i++) insertCommit.run(repoId, `sha-${i}`);
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    expect(plan.rows[0]!.cascade_counts).toMatchObject({ commits: 4 });
    expect(plan.cascade_totals).toMatchObject({ commits: 4 });
  });

  test("the plan hash changes when the selected set changes", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const before = planRegistryPrune({ db, databasePath: dbPath }).plan_hash;
    db.query("INSERT INTO repos (path, name, default_branch) VALUES (?, 'open-second', 'main')")
      .run(join(tempDir, "gone", "open-second"));
    const after = planRegistryPrune({ db, databasePath: dbPath }).plan_hash;
    expect(after).not.toBe(before);
  });

  test("refuses when an unreviewed table references repos(id)", () => {
    // The set of things attached to a repo row grows. A delete that silently keeps
    // up with it is a delete nobody is reviewing.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    db.exec("CREATE TABLE surprise (id INTEGER PRIMARY KEY, repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE)");
    let error: RegistryPruneError | null = null;
    try { planRegistryPrune({ db, databasePath: dbPath }); } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("UNKNOWN_REPO_FOREIGN_KEY");
    expect(error?.details?.tables).toEqual(["surprise"]);
  });

  test("keeps relocation receipts for a row it prunes", () => {
    // repo_relocation_audit records a repo_id but carries no foreign key to repos,
    // so a receipt outlives the row it describes. That is the point of a receipt,
    // and a prune must not quietly take it with the row.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const repoId = (db.query("SELECT id FROM repos WHERE name = 'open-gone'").get() as { id: number }).id;
    db.query(
      `INSERT INTO repo_relocation_audit
         (id, idempotency_key, request_hash, plan_hash, repo_id, target_repo_id, operation, actor,
          expected_current_path, target_path, expected_remote, expected_head, source_revision,
          target_revision, source_json, target_json, after_json, counts_json, collisions_json, created_at)
       VALUES ('aud-1', 'key-1', 'hash-1', 'plan-1', ?, ?, 'primary_relocation', 'someone',
          '/old', '/new', 'github.com/hasna/x', 'abc123', 'r1', 'r2', '{}', '{}', '{}', '{}', '[]', '2026-07-01T00:00:00Z')`,
    ).run(repoId, repoId);

    const plan = planRegistryPrune({ db, databasePath: dbPath });
    expect(plan.row_count).toBe(1);
    pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    const survivor = db.query("SELECT repo_id, actor FROM repo_relocation_audit WHERE id = 'aud-1'").get() as
      { repo_id: number; actor: string } | null;
    expect(survivor).not.toBeNull();
    expect(survivor!.repo_id).toBe(repoId);
  });
});

describe("pruneRegistryRows refuses by default", () => {
  test("a bare call writes nothing", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const result = pruneRegistryRows({}, { db, databasePath: dbPath });
    expect(result.applied).toBe(false);
    expect(result.receipt).toBeNull();
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("--apply alone is refused, naming every missing confirmation", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    let error: RegistryPruneError | null = null;
    try { pruneRegistryRows({ apply: true }, { db, databasePath: dbPath }); } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(error?.details?.missing_confirmations).toEqual([
      "expectedDatabasePath", "expectedPlanHash", "actor", "idempotencyKey",
    ]);
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("refuses when the resolved database is not the one that was confirmed", () => {
    // THE 139-ARTIFACT FAILURE, in one assertion: the operator believed they were
    // pointed at a scratch database and the default resolved to production. Naming
    // the database is what turns that into an abort.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    let error: RegistryPruneError | null = null;
    try {
      pruneRegistryRows(
        { ...confirmations("/home/someone/.hasna/repos/repos.db", plan.plan_hash) },
        { db, databasePath: dbPath },
      );
    } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("DATABASE_MISMATCH");
    expect(error?.details?.actual_database).toBe(dbPath);
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("refuses a stale plan hash", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    db.query("INSERT INTO repos (path, name, default_branch) VALUES (?, 'open-appeared', 'main')")
      .run(join(tempDir, "gone", "open-appeared"));
    let error: RegistryPruneError | null = null;
    try {
      pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("PLAN_HASH_MISMATCH");
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(2);
  });

  test("rejects a malformed plan hash, actor, or idempotency key", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    for (const override of [
      { expectedPlanHash: "not-a-hash" },
      { actor: "bad actor with spaces" },
      { idempotencyKey: "bad key with spaces" },
    ]) {
      let error: RegistryPruneError | null = null;
      try {
        pruneRegistryRows(
          { ...confirmations(dbPath, "a".repeat(64)), ...override },
          { db, databasePath: dbPath },
        );
      } catch (caught) { error = caught as RegistryPruneError; }
      expect(error?.code).toBe("INVALID_REQUEST");
    }
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });
});

describe("pruneRegistryRows applies", () => {
  test("removes only the stale rows and cascades their children", () => {
    const { db, dbPath } = seed({ present: ["open-live"], absent: ["open-gone"] });
    const repoId = (db.query("SELECT id FROM repos WHERE name = 'open-gone'").get() as { id: number }).id;
    db.query("INSERT INTO commits (repo_id, sha, author_name, author_email, date, message) VALUES (?, 'sha-1', 'a', 'a@a', '2026-01-01', 'm')").run(repoId);
    const plan = planRegistryPrune({ db, databasePath: dbPath });

    const result = pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    expect(result.applied).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.receipt?.row_count).toBe(1);

    const remaining = db.query("SELECT name FROM repos").all() as Array<{ name: string }>;
    expect(remaining.map((row) => row.name)).toEqual(["open-live"]);
    expect((db.query("SELECT COUNT(*) AS c FROM commits WHERE repo_id = ?").get(repoId) as { c: number }).c).toBe(0);
  });

  test("NEVER touches the filesystem", () => {
    // Some worktree directories on this machine are the only surviving copy of a
    // deleted repository. This verb removes registry rows and nothing else, and
    // that has to be an asserted property rather than an intention.
    const { db, dbPath, paths } = seed({ present: ["open-live"], absent: ["open-gone"] });
    const keepFile = join(paths["open-live"]!, "KEEP.txt");
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    expect(existsSync(paths["open-live"]!)).toBe(true);
    expect(existsSync(keepFile)).toBe(true);
    expect(readFileSync(keepFile, "utf8")).toBe("do not delete me\n");
  });

  test("writes an attributable receipt holding the removed rows verbatim", () => {
    // After the row is gone, the receipt is the only way to answer "who removed
    // #526, when, and what was in it".
    const { db, dbPath } = seed({ absent: ["open-browserplan"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    const result = pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    const audit = db.query("SELECT * FROM registry_prune_audit WHERE id = ?").get(result.receipt!.id) as
      { actor: string; plan_hash: string; row_count: number; rows_json: string };
    expect(audit.actor).toBe("test-operator");
    expect(audit.plan_hash).toBe(plan.plan_hash);
    expect(audit.row_count).toBe(1);
    const stored = JSON.parse(audit.rows_json) as Array<{ name: string; remote_url: string }>;
    expect(stored[0]!.name).toBe("open-browserplan");
    expect(stored[0]!.remote_url).toBe("github.com/hasna/open-browserplan");
  });

  test("replays the receipt on retry instead of pruning a second set", () => {
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    const first = pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    const second = pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    expect(second.replayed).toBe(true);
    expect(second.receipt?.id).toBe(first.receipt!.id);
    expect((db.query("SELECT COUNT(*) AS c FROM registry_prune_audit").get() as { c: number }).c).toBe(1);
  });

  test("refuses to reuse an idempotency key for a different plan", () => {
    const { db, dbPath } = seed({ absent: ["open-gone", "open-second"] });
    const first = planRegistryPrune({ db, databasePath: dbPath, limit: 1 });
    pruneRegistryRows({ ...confirmations(dbPath, first.plan_hash), limit: 1 }, { db, databasePath: dbPath });
    const next = planRegistryPrune({ db, databasePath: dbPath, limit: 1 });
    let error: RegistryPruneError | null = null;
    try {
      pruneRegistryRows({ ...confirmations(dbPath, next.plan_hash), limit: 1 }, { db, databasePath: dbPath });
    } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("a path that reappeared after the dry run aborts as a changed plan", () => {
    // Someone re-cloned. That row is no longer stale, and pruning it would erase a
    // record of a checkout that now exists. Re-planning inside the apply notices
    // this on its own, so it surfaces as a plan change.
    const { db, dbPath, paths } = seed({ absent: ["open-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    mkdirSync(paths["open-gone"]!, { recursive: true });
    let error: RegistryPruneError | null = null;
    try {
      pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("PLAN_HASH_MISMATCH");
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("re-checks paths inside the transaction, closing the window after planning", () => {
    // There is still a gap between planning and BEGIN IMMEDIATE. A path created in
    // that window would otherwise be pruned on a plan hash that was correct when it
    // was computed, so the check is repeated where nothing else can intervene.
    // Exercised with a stub that reports absent while planning and present after.
    const { db, dbPath } = seed({ absent: ["open-gone"] });
    let planned = false;
    const pathExists = () => {
      if (!planned) { planned = true; return false; }
      return true;
    };
    const plan = planRegistryPrune({ db, databasePath: dbPath, pathExists: () => false });
    let error: RegistryPruneError | null = null;
    try {
      pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath, pathExists });
    } catch (caught) { error = caught as RegistryPruneError; }
    expect(error?.code).toBe("PATH_REAPPEARED");
    expect(error?.details?.rows?.[0]?.name).toBe("open-gone");
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("--limit caps how many rows one operation removes", () => {
    const { db, dbPath } = seed({ absent: ["a-gone", "b-gone", "c-gone"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath, limit: 2 });
    expect(plan.row_count).toBe(2);
    pruneRegistryRows({ ...confirmations(dbPath, plan.plan_hash), limit: 2 }, { db, databasePath: dbPath });
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });

  test("an empty plan is a no-op with no receipt", () => {
    const { db, dbPath } = seed({ present: ["open-live"] });
    const plan = planRegistryPrune({ db, databasePath: dbPath });
    expect(plan.row_count).toBe(0);
    const result = pruneRegistryRows(confirmations(dbPath, plan.plan_hash), { db, databasePath: dbPath });
    expect(result.receipt).toBeNull();
    expect((db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c).toBe(1);
  });
});
