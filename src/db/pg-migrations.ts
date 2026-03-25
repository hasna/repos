// PostgreSQL migrations for @hasna/git cloud deployment
// These mirror the SQLite schema but use PostgreSQL syntax

export const PG_MIGRATIONS = [
  {
    version: 1,
    description: "Initial schema",
    up: `
      CREATE TABLE IF NOT EXISTS repos (
        id SERIAL PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        org TEXT,
        remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        description TEXT,
        last_scanned TIMESTAMPTZ,
        commit_count INTEGER NOT NULL DEFAULT 0,
        branch_count INTEGER NOT NULL DEFAULT 0,
        tag_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
      CREATE INDEX IF NOT EXISTS idx_repos_org ON repos(org);

      CREATE TABLE IF NOT EXISTS commits (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        date TIMESTAMPTZ NOT NULL,
        message TEXT NOT NULL,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, sha)
      );

      CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo_id);
      CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);
      CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author_email);

      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_remote BOOLEAN NOT NULL DEFAULT FALSE,
        last_commit_sha TEXT,
        last_commit_date TIMESTAMPTZ,
        ahead INTEGER NOT NULL DEFAULT 0,
        behind INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_branches_repo ON branches(repo_id);

      CREATE TABLE IF NOT EXISTS tags (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sha TEXT NOT NULL,
        date TIMESTAMPTZ,
        message TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_tags_repo ON tags(repo_id);

      CREATE TABLE IF NOT EXISTS remotes (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        fetch_url TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        author TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ,
        merged_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        url TEXT,
        base_branch TEXT,
        head_branch TEXT,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo_id, number)
      );

      CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo_id);
      CREATE INDEX IF NOT EXISTS idx_prs_state ON pull_requests(state);
      CREATE INDEX IF NOT EXISTS idx_prs_author ON pull_requests(author);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        session_id TEXT,
        capabilities JSONB DEFAULT '[]',
        working_dir TEXT,
        focus_project_id TEXT,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migrations_log (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
    down: `
      DROP TABLE IF EXISTS agents CASCADE;
      DROP TABLE IF EXISTS pull_requests CASCADE;
      DROP TABLE IF EXISTS remotes CASCADE;
      DROP TABLE IF EXISTS tags CASCADE;
      DROP TABLE IF EXISTS branches CASCADE;
      DROP TABLE IF EXISTS commits CASCADE;
      DROP TABLE IF EXISTS repos CASCADE;
      DROP TABLE IF EXISTS migrations_log CASCADE;
    `,
  },
  {
    version: 2,
    description: "Full-text search indexes (PostgreSQL tsvector)",
    up: `
      ALTER TABLE repos ADD COLUMN IF NOT EXISTS search_vector tsvector;

      CREATE OR REPLACE FUNCTION repos_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', coalesce(NEW.name, '') || ' ' || coalesce(NEW.org, '') || ' ' || coalesce(NEW.description, '') || ' ' || coalesce(NEW.remote_url, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS repos_search_trigger ON repos;
      CREATE TRIGGER repos_search_trigger BEFORE INSERT OR UPDATE ON repos
        FOR EACH ROW EXECUTE FUNCTION repos_search_update();

      CREATE INDEX IF NOT EXISTS idx_repos_search ON repos USING gin(search_vector);

      ALTER TABLE commits ADD COLUMN IF NOT EXISTS search_vector tsvector;

      CREATE OR REPLACE FUNCTION commits_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', coalesce(NEW.message, '') || ' ' || coalesce(NEW.author_name, '') || ' ' || coalesce(NEW.author_email, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS commits_search_trigger ON commits;
      CREATE TRIGGER commits_search_trigger BEFORE INSERT OR UPDATE ON commits
        FOR EACH ROW EXECUTE FUNCTION commits_search_update();

      CREATE INDEX IF NOT EXISTS idx_commits_search ON commits USING gin(search_vector);

      ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS search_vector tsvector;

      CREATE OR REPLACE FUNCTION prs_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.author, ''));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS prs_search_trigger ON pull_requests;
      CREATE TRIGGER prs_search_trigger BEFORE INSERT OR UPDATE ON pull_requests
        FOR EACH ROW EXECUTE FUNCTION prs_search_update();

      CREATE INDEX IF NOT EXISTS idx_prs_search ON pull_requests USING gin(search_vector);
    `,
    down: `
      DROP TRIGGER IF EXISTS repos_search_trigger ON repos;
      DROP FUNCTION IF EXISTS repos_search_update;
      ALTER TABLE repos DROP COLUMN IF EXISTS search_vector;

      DROP TRIGGER IF EXISTS commits_search_trigger ON commits;
      DROP FUNCTION IF EXISTS commits_search_update;
      ALTER TABLE commits DROP COLUMN IF EXISTS search_vector;

      DROP TRIGGER IF EXISTS prs_search_trigger ON pull_requests;
      DROP FUNCTION IF EXISTS prs_search_update;
      ALTER TABLE pull_requests DROP COLUMN IF EXISTS search_vector;
    `,
  },
];
