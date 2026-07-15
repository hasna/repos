import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const TEST_DIR = join(import.meta.dir, "../../.test-auto-index");
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
      || normalized.startsWith("SET search_path")
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

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (
      normalized === "BEGIN"
      || normalized === "COMMIT"
      || normalized === "ROLLBACK"
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
    if (normalized.startsWith("UPDATE repos SET search_vector = to_tsvector")) {
      const changed = this.searchVectorsValid ? 0 : this.repos.size;
      this.searchVectorsValid = true;
      return { rows: [], rowCount: changed };
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
  for (const name of legacyRdsEnvNames) delete process.env[name];
  delete process.env["REPOS_STORAGE_MODE"];
  delete process.env["REPOS_DATABASE_URL"];
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
  for (const name of legacyRdsEnvNames) delete process.env[name];
  delete process.env["REPOS_STORAGE_MODE"];
  delete process.env["REPOS_DATABASE_URL"];
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
      counts: { repos_update: 1, remotes_update: 1, remotes_delete: 1 },
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

    const applied = await cleanupRemoteIdentities({
      actor: "review-remediator",
      idempotencyKey: "apply-1",
      expectedPlanHash: dryRun.plan_hash,
      apply: true,
      remoteClient: remote,
    });
    expect(applied.applied).toBe(true);
    expect(remote.repos.get(1)?.remote_url).toBe("git.example.test/team/tool");
    expect(remote.remotes.get(1)).toMatchObject({
      url: "git.example.test/team/tool",
      fetch_url: "git.example.test/team/tool",
    });
    expect(remote.remotes.has(2)).toBe(false);
    expect(remote.searchVectorsValid).toBe(true);

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

  it("returns generic synchronization and cleanup errors without raw remote material", async () => {
    process.env["HASNA_REPOS_DB_PATH"] = join(TEST_DIR, "repos.db");
    closeDb();
    getDb();
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const failing: ReposRemoteSyncClient = {
      async query() {
        throw new Error(`remote failure for ${unsafe}`);
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
