import { getDb } from "../db/database.js";
import { getCliVersion } from "../cli/version.js";
import { getConfig } from "./config.js";

type ActiveDbEnv = "HASNA_REPOS_DB_PATH" | "REPOS_DB_PATH" | null;
type ContractStatus = "ok" | "warn";

export interface ReposStatusContract {
  service: "repos";
  schemaVersion: "1.0";
  package: {
    name: "@hasna/repos";
    version: string;
  };
  env: {
    database: {
      primary: "HASNA_REPOS_DB_PATH";
      fallback: "REPOS_DB_PATH";
      active: ActiveDbEnv;
    };
    configPathConfigured: boolean;
    hookQueuePathConfigured: boolean;
    autoBootstrapDisabled: boolean;
  };
  workspace: {
    rootCount: number;
    aliasCount: number;
  };
  counts: {
    repos: {
      total: number;
      scanned: number;
      unscanned: number;
      withRemote: number;
      withoutRemote: number;
      withCredentialLikeRemote: number;
      orgs: number;
    };
    commits: number;
    branches: {
      total: number;
      local: number;
      remote: number;
    };
    tags: number;
    pullRequests: {
      total: number;
      open: number;
      closed: number;
      merged: number;
    };
    agents: number;
  };
  health: {
    status: ContractStatus;
    databaseReachable: boolean;
    hasRepos: boolean;
    hasUnscannedRepos: boolean;
    hasCredentialLikeRemoteUrls: boolean;
    staleRepos: number;
    hasStaleRepos: boolean;
  };
  safety: {
    includesRepoNames: false;
    includesRepoPaths: false;
    includesRemoteUrls: false;
    includesBranchNames: false;
    includesCommitMessages: false;
    includesPrivatePaths: false;
    statusOutputIsMetadataOnly: true;
  };
}

function activeDatabaseEnv(): ActiveDbEnv {
  if (process.env["HASNA_REPOS_DB_PATH"]) return "HASNA_REPOS_DB_PATH";
  if (process.env["REPOS_DB_PATH"]) return "REPOS_DB_PATH";
  return null;
}

function scalar(sql: string): number {
  const row = getDb().query<{ count: number }, []>(sql).get();
  return Number(row?.count ?? 0);
}

function baseStatus(databaseReachable: boolean, packageVersion = getCliVersion()): ReposStatusContract {
  return {
    service: "repos",
    schemaVersion: "1.0",
    package: {
      name: "@hasna/repos",
      version: packageVersion,
    },
    env: {
      database: {
        primary: "HASNA_REPOS_DB_PATH",
        fallback: "REPOS_DB_PATH",
        active: activeDatabaseEnv(),
      },
      configPathConfigured: Boolean(process.env["HASNA_REPOS_CONFIG_PATH"]),
      hookQueuePathConfigured: Boolean(process.env["HASNA_REPOS_HOOK_QUEUE_PATH"]),
      autoBootstrapDisabled: process.env["HASNA_REPOS_AUTO_BOOTSTRAP"] === "0",
    },
    workspace: {
      rootCount: 0,
      aliasCount: 0,
    },
    counts: {
      repos: {
        total: 0,
        scanned: 0,
        unscanned: 0,
        withRemote: 0,
        withoutRemote: 0,
        withCredentialLikeRemote: 0,
        orgs: 0,
      },
      commits: 0,
      branches: {
        total: 0,
        local: 0,
        remote: 0,
      },
      tags: 0,
      pullRequests: {
        total: 0,
        open: 0,
        closed: 0,
        merged: 0,
      },
      agents: 0,
    },
    health: {
      status: databaseReachable ? "ok" : "warn",
      databaseReachable,
      hasRepos: false,
      hasUnscannedRepos: false,
      hasCredentialLikeRemoteUrls: false,
      staleRepos: 0,
      hasStaleRepos: false,
    },
    safety: {
      includesRepoNames: false,
      includesRepoPaths: false,
      includesRemoteUrls: false,
      includesBranchNames: false,
      includesCommitMessages: false,
      includesPrivatePaths: false,
      statusOutputIsMetadataOnly: true,
    },
  };
}

function configMetadata(): ReposStatusContract["workspace"] {
  try {
    const config = getConfig();
    return {
      rootCount: config.workspaceRoots?.length ?? 0,
      aliasCount: Object.keys(config.aliases ?? {}).length,
    };
  } catch {
    return { rootCount: 0, aliasCount: 0 };
  }
}

export function getReposStatus(packageVersion = getCliVersion()): ReposStatusContract {
  const workspace = configMetadata();

  try {
    const totalRepos = scalar("SELECT COUNT(*) AS count FROM repos");
    const unscanned = scalar("SELECT COUNT(*) AS count FROM repos WHERE last_scanned IS NULL");
    const withRemote = scalar("SELECT COUNT(*) AS count FROM repos WHERE remote_url IS NOT NULL AND remote_url != ''");
    const credentialLikeRemote = scalar(`
      SELECT COUNT(*) AS count
      FROM repos
      WHERE remote_url LIKE '%://%@%'
         OR lower(remote_url) LIKE '%token%'
         OR lower(remote_url) LIKE '%password%'
    `);
    const branchTotal = scalar("SELECT COUNT(*) AS count FROM branches");
    const remoteBranches = scalar("SELECT COUNT(*) AS count FROM branches WHERE is_remote = 1");
    const staleRepos = scalar(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT r.id, MAX(c.date) AS last_commit
        FROM repos r
        LEFT JOIN commits c ON c.repo_id = r.id
        GROUP BY r.id
        HAVING last_commit < datetime('now', '-30 days') OR last_commit IS NULL
      )
    `);

    return {
      ...baseStatus(true, packageVersion),
      workspace,
      counts: {
        repos: {
          total: totalRepos,
          scanned: totalRepos - unscanned,
          unscanned,
          withRemote,
          withoutRemote: totalRepos - withRemote,
          withCredentialLikeRemote: credentialLikeRemote,
          orgs: scalar("SELECT COUNT(DISTINCT org) AS count FROM repos WHERE org IS NOT NULL AND org != ''"),
        },
        commits: scalar("SELECT COUNT(*) AS count FROM commits"),
        branches: {
          total: branchTotal,
          local: branchTotal - remoteBranches,
          remote: remoteBranches,
        },
        tags: scalar("SELECT COUNT(*) AS count FROM tags"),
        pullRequests: {
          total: scalar("SELECT COUNT(*) AS count FROM pull_requests"),
          open: scalar("SELECT COUNT(*) AS count FROM pull_requests WHERE state = 'open'"),
          closed: scalar("SELECT COUNT(*) AS count FROM pull_requests WHERE state = 'closed'"),
          merged: scalar("SELECT COUNT(*) AS count FROM pull_requests WHERE state = 'merged'"),
        },
        agents: scalar("SELECT COUNT(*) AS count FROM agents"),
      },
      health: {
        status: credentialLikeRemote > 0 ? "warn" : "ok",
        databaseReachable: true,
        hasRepos: totalRepos > 0,
        hasUnscannedRepos: unscanned > 0,
        hasCredentialLikeRemoteUrls: credentialLikeRemote > 0,
        staleRepos,
        hasStaleRepos: staleRepos > 0,
      },
    };
  } catch {
    return {
      ...baseStatus(false, packageVersion),
      workspace,
    };
  }
}
