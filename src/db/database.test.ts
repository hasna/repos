import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getDb, closeDb } from "./database";

describe("database", () => {
  beforeAll(() => {
    process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  });

  afterAll(() => {
    closeDb();
    delete process.env["HASNA_REPOS_DB_PATH"];
  });

  it("should initialize with WAL mode (or memory for in-memory)", () => {
    const db = getDb(":memory:");
    const result = db.query("PRAGMA journal_mode").get() as any;
    // In-memory DBs use "memory" journal mode; file-backed DBs use "wal"
    expect(["wal", "memory"]).toContain(result.journal_mode);
  });

  it("should create repos table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get();
    expect(tables).toBeTruthy();
  });

  it("should create commits table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'").get();
    expect(tables).toBeTruthy();
  });

  it("should create branches table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='branches'").get();
    expect(tables).toBeTruthy();
  });

  it("should create tags table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'").get();
    expect(tables).toBeTruthy();
  });

  it("should create remotes table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='remotes'").get();
    expect(tables).toBeTruthy();
  });

  it("should create pull_requests table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pull_requests'").get();
    expect(tables).toBeTruthy();
  });

  it("should create agents table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
    expect(tables).toBeTruthy();
  });

  it("should create automation_state table", () => {
    const db = getDb(":memory:");
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_state'").get();
    expect(tables).toBeTruthy();
  });

  it("should create the durable repo relocation audit table", () => {
    const db = getDb(":memory:");
    const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_relocation_audit'").get();
    expect(table).toBeTruthy();
  });

  it("should create FTS5 tables", () => {
    const db = getDb(":memory:");
    const ftsRepos = db.query("SELECT name FROM sqlite_master WHERE name='fts_repos'").get();
    const ftsCommits = db.query("SELECT name FROM sqlite_master WHERE name='fts_commits'").get();
    const ftsPrs = db.query("SELECT name FROM sqlite_master WHERE name='fts_prs'").get();
    expect(ftsRepos).toBeTruthy();
    expect(ftsCommits).toBeTruthy();
    expect(ftsPrs).toBeTruthy();
  });

  it("should track migrations", () => {
    const db = getDb(":memory:");
    const migrations = db.query("SELECT version FROM migrations ORDER BY version").all() as { version: number }[];
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    expect(migrations[0]!.version).toBe(1);
    expect(migrations[1]!.version).toBe(2);
    expect(migrations[2]!.version).toBe(3);
    expect(migrations[3]!.version).toBe(4);
    expect(migrations[4]!.version).toBe(5);
  });

  it("should have foreign keys enabled", () => {
    const db = getDb(":memory:");
    const result = db.query("PRAGMA foreign_keys").get() as any;
    expect(result.foreign_keys).toBe(1);
  });
});
