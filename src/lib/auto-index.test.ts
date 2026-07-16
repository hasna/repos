import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { listRepos } from "../db/repos";
import {
  cleanupRemoteIdentities,
  ensureWorkspaceBootstrap,
  syncRepoCatalog,
  type ReposRemoteSyncClient,
} from "./auto-index";
import { HOOK_MARKER_START } from "./repo-hooks";

const TEST_DIR = join(tmpdir(), `repos-auto-index-${process.pid}`);
const legacyRdsEnvNames = ["HOST", "PORT", "USERNAME", "USER", "PASSWORD", "DATABASE", "DB"].map((name) =>
  ["HASNA", "RDS", name].join("_"),
);

class FakeRemoteSyncClient implements ReposRemoteSyncClient {
  records = new Map<string, { table_name: string; record_id: string; payload: Record<string, unknown>; updated_at: string }>();
  repos = new Map<string, Record<string, unknown>>();

  seed(tableName: string, recordId: string, payload: Record<string, unknown>, updatedAt: string): void {
    this.records.set(`${tableName}:${recordId}`, {
      table_name: tableName,
      record_id: recordId,
      payload,
      updated_at: updatedAt,
    });
  }

  seedRepo(path: string, payload: Record<string, unknown>): void {
    this.repos.set(path, payload);
  }

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (
      normalized.startsWith("CREATE SCHEMA")
      || normalized.startsWith("SET LOCAL search_path")
      || normalized.startsWith("CREATE TABLE")
      || normalized.startsWith("ALTER TABLE")
      || normalized.startsWith("CREATE INDEX")
      || normalized === "BEGIN"
      || normalized === "COMMIT"
      || normalized === "ROLLBACK"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO repos (")) {
      const columns = [
        "path",
        "name",
        "org",
        "remote_url",
        "default_branch",
        "description",
        "last_scanned",
        "commit_count",
        "branch_count",
        "tag_count",
        "created_at",
        "updated_at",
        "source_machine_id",
      ];
      const payload = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      const path = String(payload.path);
      const existing = this.repos.get(path);
      const existingUpdatedAt = existing ? Date.parse(String(existing.updated_at)) : -1;
      const nextUpdatedAt = Date.parse(String(payload.updated_at));
      const existingSource = String(existing?.source_machine_id ?? "");
      const nextSource = String(payload.source_machine_id ?? "");
      if (existing && (existingUpdatedAt > nextUpdatedAt || (existingUpdatedAt === nextUpdatedAt && existingSource >= nextSource))) {
        return { rows: [], rowCount: 0 };
      }
      this.seedRepo(path, payload);
      return { rows: [], rowCount: 1 };
    }
    if (normalized === "SELECT path, remote_url FROM repos WHERE remote_url IS NOT NULL") {
      const rows = [...this.repos.values()]
        .filter((repo) => repo.remote_url !== null && repo.remote_url !== undefined)
        .map((repo) => ({ path: repo.path, remote_url: repo.remote_url }));
      return { rows, rowCount: rows.length };
    }
    if (normalized === "UPDATE repos SET remote_url = $1 WHERE path = $2 AND remote_url IS NOT DISTINCT FROM $3") {
      const path = String(params[1]);
      const existing = this.repos.get(path);
      const matches = existing && existing.remote_url === params[2];
      if (matches) this.repos.set(path, { ...existing, remote_url: params[0] ?? null });
      return { rows: [], rowCount: matches ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO repos_sync_records")) {
      const tableName = String(params[0]);
      const recordId = String(params[1]);
      const payload = JSON.parse(String(params[2])) as Record<string, unknown>;
      const updatedAt = String(params[3]);
      const sourceMachineId = String(params[4] ?? "");
      const key = `${tableName}:${recordId}`;
      const existing = this.records.get(key);
      if (
        existing
        && (
          Date.parse(existing.updated_at) > Date.parse(updatedAt)
          || (Date.parse(existing.updated_at) === Date.parse(updatedAt) && String(existing.payload.source_machine_id ?? "") >= sourceMachineId)
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      this.seed(tableName, recordId, { ...payload, source_machine_id: sourceMachineId }, updatedAt);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT path, name, org, remote_url")) {
      return { rows: [...this.repos.values()], rowCount: this.repos.size };
    }
    if (normalized.startsWith("SELECT table_name, record_id, payload, updated_at, source_machine_id FROM repos_sync_records")) {
      const tableName = String(params[0]);
      return {
        rows: [...this.records.values()].filter((record) => record.table_name === tableName),
        rowCount: 0,
      };
    }
    throw new Error(`unexpected query: ${normalized}`);
  }
}

class FakeRemoteCleanupClient implements ReposRemoteSyncClient {
  readonly queries: string[] = [];
  readonly audits = new Map<string, Record<string, unknown>>();
  readonly repos = new Map<number, Record<string, unknown>>();
  readonly remotes = new Map<number, Record<string, unknown>>();
  searchVectorsValid = false;
  afterAuditInsert?: () => void;

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (
      normalized.startsWith("BEGIN")
      || normalized === "COMMIT"
      || normalized === "ROLLBACK"
      || normalized.startsWith("SELECT pg_advisory_lock")
      || normalized.startsWith("SELECT pg_advisory_unlock")
      || normalized.startsWith("SELECT pg_advisory_xact_lock")
      || normalized === "LOCK TABLE repos, remotes IN SHARE ROW EXCLUSIVE MODE"
      || normalized.startsWith("CREATE SCHEMA IF NOT EXISTS")
      || normalized.startsWith("SET LOCAL search_path TO")
      || normalized.startsWith("CREATE TABLE IF NOT EXISTS repos_remote_identity_cleanup_audit")
      || normalized.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_remote_identity_cleanup_idempotency")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT version, mode, actor, plan_hash, counts_json FROM repos_remote_identity_cleanup_audit")) {
      const row = this.audits.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT table_name, column_name FROM information_schema.columns")) {
      return {
        rows: [
          ...["id", "name", "org", "description", "remote_url", "search_vector"].map((column_name) => ({ table_name: "repos", column_name })),
          ...["id", "url", "fetch_url"].map((column_name) => ({ table_name: "remotes", column_name })),
        ],
        rowCount: 9,
      };
    }
    if (normalized.startsWith("SELECT id, name, org, description, remote_url,")) {
      return { rows: [...this.repos.values()].sort((a, b) => Number(a.id) - Number(b.id)), rowCount: this.repos.size };
    }
    if (normalized.startsWith("SELECT to_tsvector('english',")) {
      return { rows: [{ target_search_vector: `canonical:${String(params[3] ?? "")}` }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT id, remote_url FROM repos ORDER BY id")) {
      return { rows: [...this.repos.values()].sort((a, b) => Number(a.id) - Number(b.id)), rowCount: this.repos.size };
    }
    if (normalized.startsWith("SELECT id, url, fetch_url FROM remotes ORDER BY id")) {
      return { rows: [...this.remotes.values()].sort((a, b) => Number(a.id) - Number(b.id)), rowCount: this.remotes.size };
    }
    if (normalized.startsWith("UPDATE repos SET remote_url = $1 WHERE id = $2")) {
      const id = Number(params[1]);
      const row = this.repos.get(id);
      const changed = Boolean(row && row.remote_url === params[2]);
      if (changed) this.repos.set(id, { ...row, remote_url: params[0] });
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE remotes SET url = $1, fetch_url = $2 WHERE id = $3")) {
      const id = Number(params[2]);
      const row = this.remotes.get(id);
      const changed = Boolean(row && row.url === params[3] && row.fetch_url === params[4]);
      if (changed) this.remotes.set(id, { ...row, url: params[0], fetch_url: params[1] });
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (normalized.startsWith("DELETE FROM remotes WHERE id = $1")) {
      const changed = this.remotes.delete(Number(params[0]));
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE repos SET search_vector = $1::tsvector")) {
      const row = this.repos.get(Number(params[1]));
      const changed = Boolean(row && (row.search_vector ?? null) === (params[2] ?? null));
      if (changed) {
        row!.search_vector = params[0];
        this.searchVectorsValid = true;
      }
      return { rows: [], rowCount: changed ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT COUNT(*)::int AS count FROM repos WHERE search_vector IS DISTINCT FROM")) {
      return { rows: [{ count: this.searchVectorsValid ? 0 : this.repos.size }], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO repos_remote_identity_cleanup_audit")) {
      this.audits.set(String(params[0]), {
        version: params[1],
        mode: params[2],
        actor: params[3],
        plan_hash: params[4],
        counts_json: params[5],
      });
      this.afterAuditInsert?.();
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected cleanup query: ${normalized}`);
  }
}

function createTestRepo(name: string, commits = 1): string {
  const repoPath = join(TEST_DIR, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });

  for (let i = 0; i < commits; i++) {
    writeFileSync(join(repoPath, `file-${i}.txt`), `content ${i}`);
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync(`git commit -m "commit ${i}"`, { cwd: repoPath, stdio: "pipe" });
  }

  return repoPath;
}

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  process.env["HASNA_REPOS_HOOK_QUEUE_PATH"] = join(TEST_DIR, "hook-events.tsv");
  delete process.env["HASNA_REPOS_STORAGE_MODE"];
  delete process.env["HASNA_REPOS_DATABASE_URL"];
  delete process.env["HASNA_REPOS_DATABASE_SCHEMA"];
  for (const name of legacyRdsEnvNames) delete process.env[name];
  delete process.env["REPOS_STORAGE_MODE"];
  delete process.env["REPOS_DATABASE_URL"];
  delete process.env["REPOS_DATABASE_SCHEMA"];
  getDb(":memory:");
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env["HASNA_REPOS_DB_PATH"];
  delete process.env["HASNA_REPOS_HOOK_QUEUE_PATH"];
  delete process.env["HASNA_REPOS_STORAGE_MODE"];
  delete process.env["HASNA_REPOS_DATABASE_URL"];
  delete process.env["HASNA_REPOS_DATABASE_SCHEMA"];
  for (const name of legacyRdsEnvNames) delete process.env[name];
  delete process.env["REPOS_STORAGE_MODE"];
  delete process.env["REPOS_DATABASE_URL"];
  delete process.env["REPOS_DATABASE_SCHEMA"];
});

describe("auto-index", () => {
  it("bootstraps a workspace and installs post-commit hooks", async () => {
    const repoPath = createTestRepo("bootstrap-repo", 2);

    const result = await ensureWorkspaceBootstrap([TEST_DIR], { syncRemote: false });
    const hookPath = join(repoPath, ".git", "hooks", "post-commit");

    expect(result.bootstrapped).toBe(true);
    expect(result.scan?.repos_found).toBe(1);
    expect(result.hooks.installed).toBe(1);
    expect(listRepos().length).toBe(1);
    expect(readFileSync(hookPath, "utf-8")).toContain(HOOK_MARKER_START);

    const second = await ensureWorkspaceBootstrap([TEST_DIR], { syncRemote: false });
    expect(second.bootstrapped).toBe(false);
    expect(second.hooks.unchanged).toBe(0);
  });

  it("pushes the local catalog to an app-owned remote sync store", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    const repoPath = createTestRepo("sync-push-repo", 1);
    await ensureWorkspaceBootstrap([TEST_DIR], { syncRemote: false });
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    getDb().query("UPDATE repos SET remote_url = ? WHERE path = ?").run(unsafe, repoPath);
    process.env["HASNA_REPOS_DATABASE_URL"] = "postgres://repos@example.invalid/repos";
    const remote = new FakeRemoteSyncClient();

    const result = await syncRepoCatalog("push", undefined, { remoteClient: remote, databaseSchema: "repos_test" });

    expect(result.enabled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.rowsSynced).toBeGreaterThanOrEqual(1);
    expect(remote.repos.get(repoPath)).toMatchObject({
      path: repoPath,
      name: "sync-push-repo",
      remote_url: "git.example.test/team/tool",
    });
    expect(JSON.stringify(remote.repos.get(repoPath))).not.toContain(unsafe);
  });

  it("honors an explicit databaseUrl option without separate storage mode", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    const repoPath = createTestRepo("sync-option-url-repo", 1);
    await ensureWorkspaceBootstrap([TEST_DIR], { syncRemote: false });
    const remote = new FakeRemoteSyncClient();

    const result = await syncRepoCatalog("push", undefined, {
      databaseUrl: "postgres://repos@example.invalid/repos",
      remoteClient: remote,
    });

    expect(result.enabled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.rowsSynced).toBeGreaterThanOrEqual(1);
    expect(remote.repos.get(repoPath)).toMatchObject({
      path: repoPath,
      name: "sync-option-url-repo",
    });
  });

  it("pulls remote catalog records into the local database", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    getDb();
    process.env["HASNA_REPOS_STORAGE_MODE"] = "remote";
    const remote = new FakeRemoteSyncClient();
    const repoPath = join(TEST_DIR, "remote-repo");
    remote.seedRepo(repoPath, {
      path: repoPath,
      name: "remote-repo",
      org: "hasna",
      remote_url: `ssh://${["member", "phrase"].join(":")}@github.com/hasna/remote-repo.git?query=marker`,
      default_branch: "main",
      description: null,
      last_scanned: null,
      commit_count: 1,
      branch_count: 1,
      tag_count: 0,
      created_at: "2026-06-28T00:00:00.000Z",
      updated_at: "2026-06-28T00:01:00.000Z",
      source_machine_id: "remote-machine",
    });

    const result = await syncRepoCatalog("pull", undefined, { remoteClient: remote });

    expect(result).toMatchObject({ direction: "pull", enabled: true, rowsSynced: 1, errors: [] });
    expect(listRepos({ limit: 10 }).find((repo) => repo.path === repoPath)).toMatchObject({
      name: "remote-repo",
      org: "hasna",
      remote_url: "github.com/hasna/remote-repo",
    });
  });

  it("sanitizes app-owned remote rows on read without mutating the remote store", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    getDb();
    process.env["HASNA_REPOS_STORAGE_MODE"] = "remote";
    const remote = new FakeRemoteSyncClient();
    const repoPath = join(TEST_DIR, "remote-cleanup");
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    remote.seedRepo(repoPath, {
      path: repoPath,
      name: "remote-cleanup",
      org: "team",
      remote_url: unsafe,
      default_branch: "main",
      description: null,
      last_scanned: null,
      commit_count: 0,
      branch_count: 0,
      tag_count: 0,
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:01:00.000Z",
      source_machine_id: "remote-machine",
    });

    const result = await syncRepoCatalog("pull", undefined, { remoteClient: remote });

    expect(result.errors).toEqual([]);
    expect(remote.repos.get(repoPath)?.remote_url).toBe(unsafe);
    expect(listRepos({ query: "remote-cleanup" })[0]?.remote_url).toBe("git.example.test/team/tool");
  });

  it("does not run remote identity cleanup during ordinary synchronization", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    getDb();
    const remote = new FakeRemoteSyncClient();
    const result = await syncRepoCatalog("pull", undefined, {
      remoteClient: remote,
      databaseUrl: "postgres://repos@example.invalid/repos",
    });
    expect(result.errors).toEqual([]);
    expect(remote.repos.size).toBe(0);
  });

  it("plans and applies a versioned audited PostgreSQL remote cleanup idempotently", async () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?token=marker`;
    const remote = new FakeRemoteCleanupClient();
    remote.repos.set(1, { id: 1, remote_url: unsafe });
    remote.remotes.set(1, { id: 1, url: unsafe, fetch_url: unsafe });
    remote.remotes.set(2, { id: 2, url: "file:///tmp/tool", fetch_url: null });

    const dryRun = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "dry-run-1",
      remoteClient: remote,
    });
    expect(dryRun).toMatchObject({
      schema: "open-repos.remote-identity-cleanup.v1",
      version: 1,
      applied: false,
      replayed: false,
      counts: { repos_update: 1, remotes_update: 1, remotes_delete: 1, search_vectors_repaired: 1 },
    });
    expect(remote.repos.get(1)?.remote_url).toBe(unsafe);
    expect(remote.remotes.size).toBe(2);

    remote.repos.get(1)!.remote_url = "https://other:credential@git.example.test/team/tool?changed=1";
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "apply-stale",
      expectedPlanHash: dryRun.plan_hash,
      apply: true,
      remoteClient: remote,
    })).rejects.toThrow("remote identity cleanup plan mismatch");
    remote.repos.get(1)!.remote_url = unsafe;

    const applyQueryStart = remote.queries.length;
    const applied = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "apply-1",
      expectedPlanHash: dryRun.plan_hash,
      apply: true,
      remoteClient: remote,
    });
    expect(applied.applied).toBe(true);
    expect(applied.counts).toEqual(dryRun.counts);
    expect(remote.repos.get(1)?.remote_url).toBe("git.example.test/team/tool");
    expect(remote.remotes.get(1)).toMatchObject({
      url: "git.example.test/team/tool",
      fetch_url: "git.example.test/team/tool",
    });
    expect(remote.remotes.has(2)).toBe(false);
    expect(remote.searchVectorsValid).toBe(true);
    const applyQueries = remote.queries.slice(applyQueryStart);
    const indexOf = (prefix: string) => applyQueries.findIndex((query) => query.startsWith(prefix));
    expect(indexOf("SELECT pg_advisory_lock")).toBe(0);
    expect(indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE")).toBeGreaterThan(indexOf("SELECT pg_advisory_lock"));
    expect(indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE")).toBeLessThan(indexOf("CREATE TABLE IF NOT EXISTS"));
    expect(indexOf("CREATE TABLE IF NOT EXISTS")).toBeLessThan(indexOf("SELECT version, mode, actor"));
    expect(indexOf("SELECT pg_advisory_xact_lock")).toBeLessThan(indexOf("SELECT version, mode, actor"));
    expect(indexOf("LOCK TABLE repos, remotes")).toBeLessThan(indexOf("SELECT id, name, org, description"));
    expect(indexOf("SELECT id, name, org, description")).toBeLessThan(indexOf("UPDATE repos SET remote_url"));
    expect(applyQueries.filter((query) => query.startsWith("SELECT id, name, org, description, remote_url,"))).toHaveLength(3);
    expect(indexOf("SELECT id, name, org, description, remote_url,")).toBeLessThan(
      indexOf("INSERT INTO repos_remote_identity_cleanup_audit"),
    );
    expect(applyQueries.at(-2)).toBe("COMMIT");
    expect(applyQueries.at(-1)).toStartWith("SELECT pg_advisory_unlock");

    const replay = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "apply-1",
      expectedPlanHash: dryRun.plan_hash,
      apply: true,
      remoteClient: remote,
    });
    expect(replay).toEqual({ ...applied, replayed: true });
    expect(remote.audits.size).toBe(2);
  });

  it("binds every scanned canonical row and exact counts into the cleanup plan hash", async () => {
    const canonicalRepo = {
      id: 7,
      name: "canonical",
      org: "hasna",
      description: null,
      remote_url: "github.com/hasna/canonical",
      search_vector: "canonical:github.com/hasna/canonical",
    };
    const canonicalRemote = {
      id: 9,
      url: "github.com/hasna/canonical",
      fetch_url: "github.com/hasna/canonical",
    };

    const added = new FakeRemoteCleanupClient();
    const emptyPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "all-rows-empty",
      remoteClient: added,
    });
    added.repos.set(7, { ...canonicalRepo });
    added.remotes.set(9, { ...canonicalRemote });
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "all-rows-added",
      apply: true,
      expectedPlanHash: emptyPlan.plan_hash,
      remoteClient: added,
    })).rejects.toThrow("remote identity cleanup plan mismatch");

    const removed = new FakeRemoteCleanupClient();
    removed.repos.set(7, { ...canonicalRepo });
    removed.remotes.set(9, { ...canonicalRemote });
    const populatedPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "all-rows-populated",
      remoteClient: removed,
    });
    removed.repos.clear();
    removed.remotes.clear();
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "all-rows-removed",
      apply: true,
      expectedPlanHash: populatedPlan.plan_hash,
      remoteClient: removed,
    })).rejects.toThrow("remote identity cleanup plan mismatch");
  });

  it("reverifies canonical values and exact row counts after the audit insert", async () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const contaminated = new FakeRemoteCleanupClient();
    contaminated.repos.set(1, {
      id: 1,
      name: "tool",
      org: "team",
      description: null,
      remote_url: unsafe,
      search_vector: null,
    });
    const contaminatedPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "post-audit-contaminate-plan",
      remoteClient: contaminated,
    });
    contaminated.afterAuditInsert = () => {
      contaminated.repos.get(1)!.remote_url = unsafe;
    };
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "post-audit-contaminate-apply",
      apply: true,
      expectedPlanHash: contaminatedPlan.plan_hash,
      remoteClient: contaminated,
    })).rejects.toThrow("remote identity cleanup verification failed");
    expect(contaminated.queries.at(-2)).toBe("ROLLBACK");

    const removed = new FakeRemoteCleanupClient();
    removed.repos.set(2, {
      id: 2,
      name: "tool",
      org: "team",
      description: null,
      remote_url: unsafe,
      search_vector: null,
    });
    const removedPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "post-audit-count-plan",
      remoteClient: removed,
    });
    removed.afterAuditInsert = () => {
      removed.repos.delete(2);
    };
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "post-audit-count-apply",
      apply: true,
      expectedPlanHash: removedPlan.plan_hash,
      remoteClient: removed,
    })).rejects.toThrow("remote identity cleanup count verification failed");
    expect(removed.queries.at(-2)).toBe("ROLLBACK");
  });

  it("rejects exact-value substitution and same-count row replacement before commit", async () => {
    const substituted = new FakeRemoteCleanupClient();
    substituted.repos.set(7, {
      id: 7,
      name: "canonical",
      org: "hasna",
      description: "unchanged",
      remote_url: "github.com/hasna/canonical",
      search_vector: "canonical:github.com/hasna/canonical",
    });
    const substitutedPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "exact-value-plan",
      remoteClient: substituted,
    });
    substituted.afterAuditInsert = () => {
      // This remains a fully canonical row with unchanged cardinality. Only an
      // exact ID-keyed post-state check can reject the trigger substitution.
      substituted.repos.get(7)!.description = "trigger-substitution";
    };
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "exact-value-apply",
      apply: true,
      expectedPlanHash: substitutedPlan.plan_hash,
      remoteClient: substituted,
    })).rejects.toThrow("remote identity cleanup verification failed");
    expect(substituted.queries.at(-2)).toBe("ROLLBACK");

    const replaced = new FakeRemoteCleanupClient();
    replaced.remotes.set(9, {
      id: 9,
      url: "github.com/hasna/canonical",
      fetch_url: "github.com/hasna/canonical",
    });
    const replacedPlan = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "same-count-plan",
      remoteClient: replaced,
    });
    replaced.afterAuditInsert = () => {
      replaced.remotes.delete(9);
      replaced.remotes.set(10, {
        id: 10,
        url: "github.com/hasna/canonical",
        fetch_url: "github.com/hasna/canonical",
      });
    };
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "same-count-apply",
      apply: true,
      expectedPlanHash: replacedPlan.plan_hash,
      remoteClient: replaced,
    })).rejects.toThrow("remote identity cleanup verification failed");
    expect(replaced.queries.at(-2)).toBe("ROLLBACK");
  });

  it("uses the configured schema fallback and replays same-key dry runs deterministically", async () => {
    process.env["HASNA_REPOS_DATABASE_SCHEMA"] = "repos_review";
    const remote = new FakeRemoteCleanupClient();
    const first = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "same-dry-key",
      remoteClient: remote,
    });
    const replay = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "same-dry-key",
      remoteClient: remote,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(remote.queries).toContain('CREATE SCHEMA IF NOT EXISTS "repos_review"');
    expect(remote.queries).toContain('SET LOCAL search_path TO "repos_review"');
    expect(remote.queries.filter((query) => query.startsWith("INSERT INTO repos_remote_identity_cleanup_audit"))).toHaveLength(1);
  });

  it("returns generic synchronization and cleanup errors without raw remote material", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    getDb();
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const failing: ReposRemoteSyncClient = {
      async query() {
        throw new Error(`remote identity cleanup server failure for ${unsafe}`);
      },
    };
    const sync = await syncRepoCatalog("pull", undefined, {
      remoteClient: failing,
      databaseUrl: "postgres://actor:phrase@example.invalid/repos",
    });
    expect(sync.errors).toEqual(["remote repository catalog synchronization failed"]);
    expect(JSON.stringify(sync)).not.toContain("phrase");

    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "cleanup-failure",
      remoteClient: failing,
    })).rejects.toThrow("remote identity cleanup failed");
  });

  it("closes owned client construction and teardown failures while leaving injected clients caller-owned", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "owned-client.db");
    const marker = ["driver", "phrase"].join(":");
    const constructed = await syncRepoCatalog("pull", undefined, {
      databaseUrl: "postgres://repos@example.invalid/repos",
      remoteClientFactory() {
        throw new Error(marker);
      },
    });
    expect(constructed.errors).toEqual(["remote repository catalog synchronization failed"]);
    expect(JSON.stringify(constructed)).not.toContain(marker);

    const owned = Object.assign(new FakeRemoteSyncClient(), {
      async end() {
        throw new Error(marker);
      },
    });
    const repoPath = join(TEST_DIR, "teardown-remote");
    owned.seedRepo(repoPath, {
      path: repoPath,
      name: "teardown-remote",
      org: "hasna",
      remote_url: "github.com/hasna/teardown-remote",
      default_branch: "main",
      description: null,
      last_scanned: null,
      commit_count: 1,
      branch_count: 1,
      tag_count: 0,
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:01:00.000Z",
      source_machine_id: "remote-machine",
    });
    const teardown = await syncRepoCatalog("pull", undefined, {
      databaseUrl: "postgres://repos@example.invalid/repos",
      remoteClientFactory: () => owned,
    });
    expect(teardown).toMatchObject({
      direction: "pull",
      enabled: true,
      rowsSynced: 1,
      errors: [],
      teardownStatus: "failed",
    });
    expect(JSON.stringify(teardown)).not.toContain(marker);

    let injectedEndCalls = 0;
    const injected = Object.assign(new FakeRemoteSyncClient(), {
      async end() {
        injectedEndCalls++;
      },
    });
    const injectedResult = await syncRepoCatalog("pull", undefined, {
      databaseUrl: "postgres://repos@example.invalid/repos",
      remoteClient: injected,
    });
    expect(injectedResult.errors).toEqual([]);
    expect(injectedEndCalls).toBe(0);
  });

  it("starts a transaction before schema setup and rolls back setup failures", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "schema-setup.db");
    const marker = ["schema", "phrase"].join(":");
    const queries: string[] = [];
    const remote: ReposRemoteSyncClient = {
      async query(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push(normalized);
        if (normalized === "BEGIN" || normalized.startsWith("CREATE SCHEMA") || normalized === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SET LOCAL search_path")) throw new Error(marker);
        throw new Error(`unexpected query after setup failure: ${normalized}`);
      },
    };

    const result = await syncRepoCatalog("pull", undefined, {
      databaseUrl: "postgres://repos@example.invalid/repos",
      databaseSchema: "repos_review",
      remoteClient: remote,
    });
    expect(result.errors).toEqual(["remote repository catalog synchronization failed"]);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(queries).toEqual([
      "BEGIN",
      'CREATE SCHEMA IF NOT EXISTS "repos_review"',
      'SET LOCAL search_path TO "repos_review"',
      "ROLLBACK",
    ]);
  });

  it("rolls back and unlocks when the apply fence fails without exposing driver output", async () => {
    const queries: string[] = [];
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const remote: ReposRemoteSyncClient = {
      async query(sql: string, params: unknown[] = []) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push(normalized);
        if (
          normalized.startsWith("SELECT pg_advisory_lock")
          || normalized.startsWith("SELECT pg_advisory_unlock")
          || normalized.startsWith("SELECT pg_advisory_xact_lock")
          || normalized.startsWith("BEGIN")
          || normalized === "ROLLBACK"
          || normalized.startsWith("CREATE TABLE")
          || normalized.startsWith("CREATE UNIQUE INDEX")
        ) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT version, mode, actor")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT table_name, column_name")) {
          return {
            rows: [
              ...["id", "name", "org", "description", "remote_url", "search_vector"].map((column_name) => ({ table_name: "repos", column_name })),
              ...["id", "url", "fetch_url"].map((column_name) => ({ table_name: "remotes", column_name })),
            ],
            rowCount: 9,
          };
        }
        if (normalized.startsWith("LOCK TABLE")) throw new Error(`remote identity cleanup server failure ${unsafe}`);
        throw new Error(`unexpected test query ${String(params.length)}`);
      },
    };
    await expect(cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "fence-failure",
      apply: true,
      expectedPlanHash: "a".repeat(64),
      remoteClient: remote,
    })).rejects.toThrow("remote identity cleanup failed");
    expect(queries).toContain("ROLLBACK");
    expect(queries.at(-1)).toStartWith("SELECT pg_advisory_unlock");
    expect(JSON.stringify(queries)).not.toContain("phrase");
  });

  it("rejects SQLite memory URI aliases before remote synchronization", async () => {
    closeDb();
    process.env["HASNA_REPOS_DB_PATH"] = "file::memory:?cache=shared";
    await expect(syncRepoCatalog("pull", undefined, {
      storageMode: "hybrid",
      databaseUrl: "postgres://repos@example.invalid/repos",
      remoteClient: new FakeRemoteSyncClient(),
    })).rejects.toThrow("SQLite memory URI paths are unsupported; use exact :memory:");
  });

  it("stays local for legacy shared RDS envs without repo-owned database config", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    createTestRepo("legacy-rds-repo", 1);
    await ensureWorkspaceBootstrap([TEST_DIR], { syncRemote: false });
    process.env[legacyRdsEnvNames[0]!] = "rds.example.invalid";
    process.env[legacyRdsEnvNames[1]!] = "5432";
    process.env[legacyRdsEnvNames[2]!] = "repos_user";
    process.env[legacyRdsEnvNames[4]!] = "repos-password";

    const result = await syncRepoCatalog("push", undefined, { remoteClient: new FakeRemoteSyncClient() });

    expect(result.enabled).toBe(false);
    expect(result.skippedReason).toBe("local_mode");
    expect(result.errors).toEqual([]);
  });
});
