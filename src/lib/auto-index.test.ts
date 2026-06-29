import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { listRepos } from "../db/repos";
import { ensureWorkspaceBootstrap, syncRepoCatalog, type ReposRemoteSyncClient } from "./auto-index";
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
    process.env["HASNA_REPOS_DATABASE_URL"] = "postgres://repos@example.invalid/repos";
    const remote = new FakeRemoteSyncClient();

    const result = await syncRepoCatalog("push", undefined, { remoteClient: remote, databaseSchema: "repos_test" });

    expect(result.enabled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.rowsSynced).toBeGreaterThanOrEqual(1);
    expect(remote.repos.get(repoPath)).toMatchObject({
      path: repoPath,
      name: "sync-push-repo",
    });
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
      remote_url: "https://github.com/hasna/remote-repo.git",
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
    });
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
