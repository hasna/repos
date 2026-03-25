import { Database } from "bun:sqlite";
import { SqliteAdapter } from "@hasna/cloud";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findNearestGitLocalDb(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".git-local", "git-local.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getDbPath(): string {
  if (process.env["HASNA_GIT_DB_PATH"]) {
    return process.env["HASNA_GIT_DB_PATH"];
  }
  if (process.env["GIT_LOCAL_DB_PATH"]) {
    return process.env["GIT_LOCAL_DB_PATH"];
  }

  const cwd = process.cwd();
  const nearest = findNearestGitLocalDb(cwd);
  if (nearest) return nearest;

  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const newPath = join(home, ".hasna", "git", "git-local.db");
  const legacyPath = join(home, ".git-local", "git-local.db");

  if (existsSync(legacyPath) && !existsSync(newPath)) {
    return legacyPath;
  }

  return newPath;
}

let _db: Database | null = null;
let _dbPath: string | null = null;

export function getDb(customPath?: string): Database {
  const path = customPath || getDbPath();

  if (_db && _dbPath === path) return _db;

  if (path !== ":memory:" && !path.startsWith("file::memory:")) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  _db = new Database(path);
  _dbPath = path;

  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA busy_timeout = 5000");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");

  runMigrations(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.query("SELECT version FROM migrations").all().map((r: any) => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) {
      db.exec(migration.sql);
      db.query("INSERT INTO migrations (version) VALUES (?)").run(migration.version);
    }
  }
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        org TEXT,
        remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        description TEXT,
        last_scanned TEXT,
        commit_count INTEGER NOT NULL DEFAULT 0,
        branch_count INTEGER NOT NULL DEFAULT 0,
        tag_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_repos_name ON repos(name);
      CREATE INDEX idx_repos_org ON repos(org);

      CREATE TABLE commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        date TEXT NOT NULL,
        message TEXT NOT NULL,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, sha)
      );

      CREATE INDEX idx_commits_repo ON commits(repo_id);
      CREATE INDEX idx_commits_date ON commits(date);
      CREATE INDEX idx_commits_author ON commits(author_email);

      CREATE TABLE branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_remote INTEGER NOT NULL DEFAULT 0,
        last_commit_sha TEXT,
        last_commit_date TEXT,
        ahead INTEGER NOT NULL DEFAULT 0,
        behind INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX idx_branches_repo ON branches(repo_id);

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sha TEXT NOT NULL,
        date TEXT,
        message TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX idx_tags_repo ON tags(repo_id);

      CREATE TABLE remotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        fetch_url TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE TABLE pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        merged_at TEXT,
        closed_at TEXT,
        url TEXT,
        base_branch TEXT,
        head_branch TEXT,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, number)
      );

      CREATE INDEX idx_prs_repo ON pull_requests(repo_id);
      CREATE INDEX idx_prs_state ON pull_requests(state);
      CREATE INDEX idx_prs_author ON pull_requests(author);

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        session_id TEXT,
        capabilities TEXT DEFAULT '[]',
        working_dir TEXT,
        focus_project_id TEXT,
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_repos USING fts5(
        name, org, description, remote_url,
        content='repos', content_rowid='id'
      );

      CREATE TRIGGER repos_ai AFTER INSERT ON repos BEGIN
        INSERT INTO fts_repos(rowid, name, org, description, remote_url)
        VALUES (new.id, new.name, new.org, new.description, new.remote_url);
      END;

      CREATE TRIGGER repos_ad AFTER DELETE ON repos BEGIN
        INSERT INTO fts_repos(fts_repos, rowid, name, org, description, remote_url)
        VALUES ('delete', old.id, old.name, old.org, old.description, old.remote_url);
      END;

      CREATE TRIGGER repos_au AFTER UPDATE ON repos BEGIN
        INSERT INTO fts_repos(fts_repos, rowid, name, org, description, remote_url)
        VALUES ('delete', old.id, old.name, old.org, old.description, old.remote_url);
        INSERT INTO fts_repos(rowid, name, org, description, remote_url)
        VALUES (new.id, new.name, new.org, new.description, new.remote_url);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(
        message, author_name, author_email,
        content='commits', content_rowid='id'
      );

      CREATE TRIGGER commits_ai AFTER INSERT ON commits BEGIN
        INSERT INTO fts_commits(rowid, message, author_name, author_email)
        VALUES (new.id, new.message, new.author_name, new.author_email);
      END;

      CREATE TRIGGER commits_ad AFTER DELETE ON commits BEGIN
        INSERT INTO fts_commits(fts_commits, rowid, message, author_name, author_email)
        VALUES ('delete', old.id, old.message, old.author_name, old.author_email);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_prs USING fts5(
        title, author,
        content='pull_requests', content_rowid='id'
      );

      CREATE TRIGGER prs_ai AFTER INSERT ON pull_requests BEGIN
        INSERT INTO fts_prs(rowid, title, author)
        VALUES (new.id, new.title, new.author);
      END;

      CREATE TRIGGER prs_ad AFTER DELETE ON pull_requests BEGIN
        INSERT INTO fts_prs(fts_prs, rowid, title, author)
        VALUES ('delete', old.id, old.title, old.author);
      END;
    `,
  },
];
