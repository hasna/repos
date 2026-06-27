import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listRepos,
  getRepo,
  searchRepos,
  listCommits,
  searchCommits,
  listBranches,
  listTags,
  listPullRequests,
  searchPullRequests,
  searchAll,
  getRepoStats,
  getGlobalStats,
  listRemotes,
} from "../db/repos.js";
import { ensureWorkspaceBootstrap, startAutoIndexWorker } from "../lib/auto-index.js";
import { syncGithubPRs, syncAllGithubPRs, fetchRepoMetadata } from "../lib/github.js";
import { buildGraph, queryNode, queryRelated, findPath, getDeps, getGraphStats } from "../lib/graph.js";
import {
  getDocsDrift,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  triagePullRequests,
  withTodos,
} from "../lib/repo-ops.js";
import { getDb } from "../db/database.js";

export const MCP_NAME = "repos";
export const VERSION = "0.1.7";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: VERSION,
  });

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function todosArgs(args: {
  cwd?: string;
  todo_task_id?: string;
  todo_apply?: boolean;
  todo_agent?: string;
  todo_project?: string;
}) {
  return {
    taskId: args.todo_task_id,
    apply: Boolean(args.todo_apply),
    agent: args.todo_agent,
    project: args.todo_project,
    cwd: args.cwd,
  };
}

// ── Repos ──

server.tool("list_repos", "List all tracked repositories", {
  limit: z.number().optional().describe("Max results (default 50)"),
  offset: z.number().optional().describe("Skip N results"),
  org: z.string().optional().describe("Filter by GitHub org"),
  query: z.string().optional().describe("Filter by name/description"),
}, async (args) => {
  const repos = listRepos(args);
  return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
});

server.tool("get_repo", "Get a repo by ID, path, or name", {
  id: z.string().describe("Repo ID, path, or name"),
}, async ({ id }) => {
  const repo = getRepo(isNaN(Number(id)) ? id : Number(id));
  if (!repo) return { content: [{ type: "text", text: "Repo not found" }] };
  const stats = getRepoStats(repo.id);
  return { content: [{ type: "text", text: JSON.stringify({ ...repo, ...stats }, null, 2) }] };
});

server.tool("search_repos", "Search repos by name, description, or URL", {
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ query, limit }) => {
  const repos = searchRepos(query, limit);
  return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
});

// ── Commits ──

server.tool("list_commits", "List commits with optional filters", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  author: z.string().optional().describe("Filter by author name/email"),
  since: z.string().optional().describe("Commits after this date (ISO 8601)"),
  until: z.string().optional().describe("Commits before this date (ISO 8601)"),
  limit: z.number().optional().describe("Max results (default 50)"),
  offset: z.number().optional().describe("Skip N results"),
}, async (args) => {
  const commits = listCommits(args);
  return { content: [{ type: "text", text: JSON.stringify(commits, null, 2) }] };
});

server.tool("search_commits", "Full-text search on commit messages", {
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ query, limit }) => {
  const commits = searchCommits(query, limit);
  return { content: [{ type: "text", text: JSON.stringify(commits, null, 2) }] };
});

// ── Branches ──

server.tool("list_branches", "List branches with optional filters", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  is_remote: z.boolean().optional().describe("Filter remote/local branches"),
  limit: z.number().optional().describe("Max results (default 100)"),
}, async (args) => {
  const branches = listBranches(args);
  return { content: [{ type: "text", text: JSON.stringify(branches, null, 2) }] };
});

// ── Tags ──

server.tool("list_tags", "List git tags", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  limit: z.number().optional().describe("Max results (default 100)"),
}, async (args) => {
  const tags = listTags(args);
  return { content: [{ type: "text", text: JSON.stringify(tags, null, 2) }] };
});

// ── Pull Requests ──

server.tool("list_prs", "List pull requests", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  state: z.string().optional().describe("Filter by state: open, closed, merged"),
  author: z.string().optional().describe("Filter by author"),
  limit: z.number().optional().describe("Max results (default 50)"),
}, async (args) => {
  const prs = listPullRequests(args);
  return { content: [{ type: "text", text: JSON.stringify(prs, null, 2) }] };
});

server.tool("search_prs", "Full-text search on PR titles", {
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ query, limit }) => {
  const prs = searchPullRequests(query, limit);
  return { content: [{ type: "text", text: JSON.stringify(prs, null, 2) }] };
});

// ── Remotes ──

server.tool("list_remotes", "List remotes for a repo", {
  repo_id: z.number().describe("Repo ID"),
}, async ({ repo_id }) => {
  const remotes = listRemotes(repo_id);
  return { content: [{ type: "text", text: JSON.stringify(remotes, null, 2) }] };
});

// ── Unified Search ──

server.tool("search", "Search across all entities (repos, commits, PRs)", {
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ query, limit }) => {
  const results = searchAll(query, limit);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

// ── Scanner ──

server.tool("scan_repos", "Scan directories to discover and index git repos", {
  roots: z.array(z.string()).optional().describe("Root directories to scan (default: ~/workspace)"),
  full: z.boolean().optional().describe("Full re-scan (default: incremental)"),
}, async ({ roots, full }) => {
  const result = await ensureWorkspaceBootstrap(roots, { force: true, full });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...result.scan,
        hooks: {
          installed: result.hooks.installed,
          updated: result.hooks.updated,
          unchanged: result.hooks.unchanged,
          skipped: result.hooks.skipped,
        },
      }, null, 2),
    }],
  };
});

// ── Stats ──

server.tool("get_stats", "Get global stats across all repos", {}, async () => {
  const stats = getGlobalStats();
  return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
});

server.tool("get_repo_stats", "Get detailed stats for a specific repo", {
  repo_id: z.number().describe("Repo ID"),
}, async ({ repo_id }) => {
  const stats = getRepoStats(repo_id);
  return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
});

// ── Agent Ops ──

const todosShape = {
  todo_task_id: z.string().optional().describe("todos task id to comment on"),
  todo_apply: z.boolean().optional().describe("Actually write the todos comment; default is dry-run preview"),
  todo_agent: z.string().optional().describe("todos agent name for todo_apply"),
  todo_project: z.string().optional().describe("todos project path for todo_apply"),
};

server.tool("package_health", "Check package.json, scripts, bins, and lockfiles with compact JSON", {
  cwd: z.string().optional().describe("Package root (default current process cwd)"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(getPackageHealth({ cwd: args.cwd, limit: args.limit }), todosArgs(args))));

server.tool("package_drift", "Check package.json versus bun.lock drift with compact JSON", {
  cwd: z.string().optional().describe("Package root (default current process cwd)"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(getPackageDrift({ cwd: args.cwd, limit: args.limit }), todosArgs(args))));

server.tool("package_resolve_bin", "Resolve a package bin from package.json, node_modules/.bin, or PATH", {
  cwd: z.string().optional().describe("Package root (default current process cwd)"),
  name: z.string().optional().describe("Bin name to resolve; omit to list package-local bins"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(resolvePackageBin({ cwd: args.cwd, name: args.name, limit: args.limit }), todosArgs(args))));

server.tool("ports_scan", "Scan listening TCP ports and annotate ports referenced by package scripts", {
  cwd: z.string().optional().describe("Package root for script port hints"),
  port: z.number().optional().describe("Only return one port"),
  limit: z.number().optional().describe("Max returned listeners"),
  ...todosShape,
}, async (args) => jsonText(withTodos(scanPorts({ cwd: args.cwd, port: args.port, limit: args.limit }), todosArgs(args))));

server.tool("triage_branches", "Triage current git branch, dirty state, stale branches, and merged branches", {
  cwd: z.string().optional().describe("Git repo root"),
  stale_days: z.number().optional().describe("Stale local branch threshold"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(triageBranches({ cwd: args.cwd, staleDays: args.stale_days, limit: args.limit }), todosArgs(args))));

server.tool("triage_prs", "Triage GitHub pull requests via gh", {
  cwd: z.string().optional().describe("Git repo root"),
  state: z.string().optional().describe("PR state passed to gh"),
  stale_days: z.number().optional().describe("Stale PR threshold"),
  limit: z.number().optional().describe("Max returned PRs"),
  ...todosShape,
}, async (args) => jsonText(withTodos(triagePullRequests({ cwd: args.cwd, state: args.state, staleDays: args.stale_days, limit: args.limit }), todosArgs(args))));

server.tool("docs_drift", "Check README coverage for package name, bins, and agent ops commands", {
  cwd: z.string().optional().describe("Package root"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(getDocsDrift({ cwd: args.cwd, limit: args.limit }), todosArgs(args))));

server.tool("release_health", "Combine package, drift, docs, and branch checks for release readiness", {
  cwd: z.string().optional().describe("Package root"),
  include_git: z.boolean().optional().describe("Include git branch checks; default true"),
  stale_days: z.number().optional().describe("Stale local branch threshold"),
  limit: z.number().optional().describe("Max returned items"),
  ...todosShape,
}, async (args) => jsonText(withTodos(getReleaseHealth({
  cwd: args.cwd,
  includeGit: args.include_git,
  staleDays: args.stale_days,
  limit: args.limit,
}), todosArgs(args))));

// ── GitHub Sync ──

server.tool("sync_github_prs", "Sync PRs from GitHub for a specific repo", {
  repo: z.string().describe("Repo name, path, or ID"),
  limit: z.number().optional().describe("Max PRs to fetch (default 100)"),
  state: z.string().optional().describe("PR state: all, open, closed (default all)"),
}, async ({ repo, limit, state }) => {
  try {
    const result = syncGithubPRs(repo, { limit, state });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
  }
});

server.tool("sync_all_github_prs", "Sync PRs from GitHub for all repos (or by org)", {
  org: z.string().optional().describe("Filter by GitHub org"),
  limit: z.number().optional().describe("Max PRs per repo (default 50)"),
}, async ({ org, limit }) => {
  const result = syncAllGithubPRs({ org, limit });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("fetch_repo_metadata", "Fetch GitHub metadata (stars, topics, language)", {
  repo: z.string().describe("Repo name or ID"),
}, async ({ repo }) => {
  const meta = fetchRepoMetadata(repo);
  if (!meta) return { content: [{ type: "text", text: "Cannot fetch metadata" }] };
  return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }] };
});

// ── Knowledge Graph ──

server.tool("graph_build", "Build knowledge graph from repo data", {}, async () => {
  const result = buildGraph();
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("graph_query", "Query a node and its connections", {
  type: z.string().describe("Node type: repo, author, org, language"),
  id: z.string().describe("Node ID"),
}, async ({ type, id }) => {
  const node = queryNode(type, id);
  if (!node) return { content: [{ type: "text", text: "Node not found" }] };
  return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
});

server.tool("graph_related", "Find repos related to a given repo", {
  repo: z.string().describe("Repo name or ID"),
  limit: z.number().optional().describe("Max results (default 10)"),
}, async ({ repo, limit }) => {
  const results = queryRelated(repo, limit);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.tool("graph_path", "Find shortest path between two nodes", {
  from_type: z.string().describe("Source node type"),
  from_id: z.string().describe("Source node ID"),
  to_type: z.string().describe("Target node type"),
  to_id: z.string().describe("Target node ID"),
}, async ({ from_type, from_id, to_type, to_id }) => {
  const path = findPath(from_type, from_id, to_type, to_id);
  if (!path) return { content: [{ type: "text", text: "No path found" }] };
  return { content: [{ type: "text", text: JSON.stringify(path, null, 2) }] };
});

server.tool("graph_deps", "Show dependency tree for a repo", {
  repo: z.string().describe("Repo name or ID"),
  depth: z.number().optional().describe("Max depth (default 3)"),
}, async ({ repo, depth }) => {
  const deps = getDeps(repo, depth);
  return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
});

server.tool("graph_stats", "Get knowledge graph statistics", {}, async () => {
  const stats = getGraphStats();
  return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
});

// ── Agent Support ──

server.tool("register_agent", "Register an agent", {
  name: z.string().describe("Agent name"),
  description: z.string().optional(),
  session_id: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  working_dir: z.string().optional(),
}, async (args) => {
  const db = getDb();
  const id = crypto.randomUUID().slice(0, 8);
  db.query(`INSERT OR REPLACE INTO agents (id, name, description, session_id, capabilities, working_dir, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    id, args.name, args.description || null, args.session_id || null,
    JSON.stringify(args.capabilities || []), args.working_dir || null
  );
  return { content: [{ type: "text", text: JSON.stringify({ id, name: args.name, registered: true }) }] };
});

server.tool("heartbeat", "Send agent heartbeat", {
  name: z.string().optional(),
  status: z.string().optional(),
}, async (args) => {
  const db = getDb();
  if (args.name) {
    db.query("UPDATE agents SET last_seen = datetime('now') WHERE name = ?").run(args.name);
  }
  return { content: [{ type: "text", text: JSON.stringify({ heartbeat: true }) }] };
});

server.tool("list_agents", "List registered agents", {}, async () => {
  const db = getDb();
  const agents = db.query("SELECT * FROM agents ORDER BY last_seen DESC").all();
  return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
});

  return server;
}

export async function prepareMcpLifecycle(): Promise<{ stop: () => void }> {
  if (process.env.REPOS_DISABLE_AUTO_INDEX === "1") {
    return { stop: () => {} };
  }
  try {
    const worker = await startAutoIndexWorker(undefined, {
      onProgress: (msg) => console.error(`[auto-index] ${msg}`),
    });
    const stop = () => worker.stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return { stop };
  } catch (err) {
    // Auto-index is best-effort — broken symlinks in the workspace must not
    // take down the MCP server. Log and continue.
    console.error(`[auto-index] disabled due to error: ${err instanceof Error ? err.message : String(err)}`);
    return { stop: () => {} };
  }
}
