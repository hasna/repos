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
import { getDb } from "../db/database.js";

export const MCP_NAME = "repos";
export const VERSION = "0.1.7";

const MCP_COMPACT_LIMIT = 20;
const MCP_MAX_LIMIT = 200;

function limitArg(description: string) {
  return z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe(`${description} (max ${MCP_MAX_LIMIT})`);
}

function offsetArg(description = "Skip N results") {
  return z.number().int().nonnegative().max(100_000).optional().describe(description);
}

function textResponse(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function compactText(value: unknown, max = 120): string {
  const text = String(value ?? "")
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1***@")
    .replace(/\b(token|password|secret)=([^&\s]+)/gi, "$1=***")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function compactLimit(args: { limit?: number; verbose?: boolean }, verboseDefault = 50, compactDefault = MCP_COMPACT_LIMIT): number {
  const raw = args.limit ?? (args.verbose ? verboseDefault : compactDefault);
  if (!Number.isFinite(raw)) return compactDefault;
  return Math.min(MCP_MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

export function compactPage<T, U>(
  kind: string,
  items: T[],
  args: { limit?: number; offset?: number; verbose?: boolean; pageable?: boolean },
  mapItem: (item: T) => U,
  hint: string
) {
  const limit = compactLimit(args);
  const offset = args.offset ?? 0;
  return {
    kind,
    output: "compact",
    count: items.length,
    limit,
    offset,
    next_cursor: args.pageable && items.length >= limit ? offset + limit : null,
    items: items.map(mapItem),
    hint: `${hint}. Set verbose=true for full records${args.pageable ? "; pass limit/offset to page" : ""}.`,
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: VERSION,
  });

// ── Repos ──

server.tool("list_repos", "List all tracked repositories", {
  limit: limitArg("Max results (default 20 compact, 50 verbose)"),
  offset: offsetArg(),
  org: z.string().optional().describe("Filter by GitHub org"),
  query: z.string().optional().describe("Filter by name/description"),
  verbose: z.boolean().optional().describe("Return full repo records instead of compact summaries"),
}, async (args) => {
  const limit = compactLimit(args, 50);
  const repos = listRepos({ ...args, limit });
  if (args.verbose) return textResponse(repos);
  return textResponse(compactPage("repos", repos, { ...args, limit, pageable: true }, (repo) => ({
    id: repo.id,
    name: repo.name,
    org: repo.org,
    default_branch: repo.default_branch,
    counts: { commits: repo.commit_count, branches: repo.branch_count, tags: repo.tag_count },
    description: compactText(repo.description, 120),
  }), "Call get_repo with the repo id/name for path, remote, authors, and commits"));
});

server.tool("get_repo", "Get a repo by ID, path, or name", {
  id: z.string().describe("Repo ID, path, or name"),
  verbose: z.boolean().optional().describe("Return the full repo plus stats object"),
}, async ({ id, verbose }) => {
  const repo = getRepo(isNaN(Number(id)) ? id : Number(id));
  if (!repo) return textResponse({ error: "Repo not found" });
  const stats = getRepoStats(repo.id);
  if (verbose) return textResponse({ ...repo, ...stats });
  return textResponse({
    kind: "repo",
    output: "compact",
    repo: {
      id: repo.id,
      name: repo.name,
      org: repo.org,
      path: compactText(repo.path, 180),
      remote_url: compactText(repo.remote_url, 180),
      default_branch: repo.default_branch,
      description: compactText(repo.description, 180),
    },
    counts: {
      commits: stats.commit_count,
      branches: stats.branch_count,
      tags: stats.tag_count,
      pull_requests: stats.pr_count,
    },
    top_authors: stats.top_authors.slice(0, 5),
    recent_commits: stats.recent_commits.slice(0, 5).map((commit) => ({
      sha: commit.sha.slice(0, 8),
      message: compactText(commit.message, 120),
      author_name: commit.author_name,
      date: commit.date,
    })),
    hint: "Set verbose=true for the full repo/stats object.",
  });
});

server.tool("search_repos", "Search repos by name, description, or URL", {
  query: z.string().describe("Search query"),
  limit: limitArg("Max results (default 20)"),
  verbose: z.boolean().optional().describe("Return full repo records instead of compact summaries"),
}, async ({ query, limit, verbose }) => {
  const effectiveLimit = compactLimit({ limit, verbose }, 20);
  const repos = searchRepos(query, effectiveLimit);
  if (verbose) return textResponse(repos);
  return textResponse(compactPage("repos", repos, { limit: effectiveLimit }, (repo) => ({
    id: repo.id,
    name: repo.name,
    org: repo.org,
    counts: { commits: repo.commit_count, branches: repo.branch_count, tags: repo.tag_count },
    description: compactText(repo.description || repo.remote_url || repo.path, 120),
  }), "Call get_repo with the repo id/name for details"));
});

// ── Commits ──

server.tool("list_commits", "List commits with optional filters", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  author: z.string().optional().describe("Filter by author name/email"),
  since: z.string().optional().describe("Commits after this date (ISO 8601)"),
  until: z.string().optional().describe("Commits before this date (ISO 8601)"),
  limit: limitArg("Max results (default 20 compact, 50 verbose)"),
  offset: offsetArg(),
  verbose: z.boolean().optional().describe("Return full commit records instead of compact summaries"),
}, async (args) => {
  const limit = compactLimit(args, 50);
  const commits = listCommits({ ...args, limit });
  if (args.verbose) return textResponse(commits);
  return textResponse(compactPage("commits", commits, { ...args, limit, pageable: true }, (commit) => ({
    id: commit.id,
    repo_id: commit.repo_id,
    sha: commit.sha.slice(0, 12),
    message: compactText(commit.message, 140),
    author_name: commit.author_name,
    date: commit.date,
  }), "Call get_repo for repo context or set verbose=true for author emails and diff stats"));
});

server.tool("search_commits", "Full-text search on commit messages", {
  query: z.string().describe("Search query"),
  limit: limitArg("Max results (default 20)"),
  verbose: z.boolean().optional().describe("Return full commit records instead of compact summaries"),
}, async ({ query, limit, verbose }) => {
  const effectiveLimit = compactLimit({ limit, verbose }, 20);
  const commits = searchCommits(query, effectiveLimit);
  if (verbose) return textResponse(commits);
  return textResponse(compactPage("commits", commits, { limit: effectiveLimit }, (commit) => ({
    id: commit.id,
    repo_id: commit.repo_id,
    repo_name: commit.repo_name,
    sha: commit.sha.slice(0, 12),
    message: compactText(commit.message, 140),
    author_name: commit.author_name,
    date: commit.date,
  }), "Set verbose=true for full commit records"));
});

// ── Branches ──

server.tool("list_branches", "List branches with optional filters", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  is_remote: z.boolean().optional().describe("Filter remote/local branches"),
  limit: limitArg("Max results (default 20 compact, 100 verbose)"),
  offset: offsetArg(),
  verbose: z.boolean().optional().describe("Return full branch records instead of compact summaries"),
}, async (args) => {
  const limit = compactLimit(args, 100);
  const branches = listBranches({ ...args, limit });
  if (args.verbose) return textResponse(branches);
  return textResponse(compactPage("branches", branches, { ...args, limit, pageable: true }, (branch) => ({
    id: branch.id,
    repo_id: branch.repo_id,
    name: compactText(branch.name, 100),
    is_remote: Boolean(branch.is_remote),
    last_commit_sha: branch.last_commit_sha?.slice(0, 12) ?? null,
    last_commit_date: branch.last_commit_date,
  }), "Set verbose=true for ahead/behind and full names"));
});

// ── Tags ──

server.tool("list_tags", "List git tags", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  limit: limitArg("Max results (default 20 compact, 100 verbose)"),
  offset: offsetArg(),
  verbose: z.boolean().optional().describe("Return full tag records instead of compact summaries"),
}, async (args) => {
  const limit = compactLimit(args, 100);
  const tags = listTags({ ...args, limit });
  if (args.verbose) return textResponse(tags);
  return textResponse(compactPage("tags", tags, { ...args, limit, pageable: true }, (tag) => ({
    id: tag.id,
    repo_id: tag.repo_id,
    name: compactText(tag.name, 100),
    sha: tag.sha.slice(0, 12),
    date: tag.date,
    message: compactText(tag.message, 100),
  }), "Set verbose=true for full tag records"));
});

// ── Pull Requests ──

server.tool("list_prs", "List pull requests", {
  repo_id: z.number().optional().describe("Filter by repo ID"),
  state: z.string().optional().describe("Filter by state: open, closed, merged"),
  author: z.string().optional().describe("Filter by author"),
  limit: limitArg("Max results (default 20 compact, 50 verbose)"),
  offset: offsetArg(),
  verbose: z.boolean().optional().describe("Return full PR records instead of compact summaries"),
}, async (args) => {
  const limit = compactLimit(args, 50);
  const prs = listPullRequests({ ...args, limit });
  if (args.verbose) return textResponse(prs);
  return textResponse(compactPage("pull_requests", prs, { ...args, limit, pageable: true }, (pr) => ({
    id: pr.id,
    repo_id: pr.repo_id,
    number: pr.number,
    title: compactText(pr.title, 140),
    state: pr.state,
    author: pr.author,
    created_at: pr.created_at,
  }), "Set verbose=true for branch names, URLs, and diff stats"));
});

server.tool("search_prs", "Full-text search on PR titles", {
  query: z.string().describe("Search query"),
  limit: limitArg("Max results (default 20)"),
  verbose: z.boolean().optional().describe("Return full PR records instead of compact summaries"),
}, async ({ query, limit, verbose }) => {
  const effectiveLimit = compactLimit({ limit, verbose }, 20);
  const prs = searchPullRequests(query, effectiveLimit);
  if (verbose) return textResponse(prs);
  return textResponse(compactPage("pull_requests", prs, { limit: effectiveLimit }, (pr) => ({
    id: pr.id,
    repo_id: pr.repo_id,
    repo_name: pr.repo_name,
    number: pr.number,
    title: compactText(pr.title, 140),
    state: pr.state,
    author: pr.author,
    created_at: pr.created_at,
  }), "Set verbose=true for full PR records"));
});

// ── Remotes ──

server.tool("list_remotes", "List remotes for a repo", {
  repo_id: z.number().describe("Repo ID"),
  verbose: z.boolean().optional().describe("Return full remote records"),
}, async ({ repo_id, verbose }) => {
  const remotes = listRemotes(repo_id);
  if (verbose) return textResponse(remotes);
  return textResponse({
    kind: "remotes",
    output: "compact",
    count: remotes.length,
    items: remotes.map((remote) => ({
      id: remote.id,
      name: remote.name,
      url: compactText(remote.url, 120),
    })),
    hint: "Set verbose=true for full remote records.",
  });
});

// ── Unified Search ──

server.tool("search", "Search across all entities (repos, commits, PRs)", {
  query: z.string().describe("Search query"),
  limit: limitArg("Max results (default 20)"),
  verbose: z.boolean().optional().describe("Return wider snippets"),
}, async ({ query, limit, verbose }) => {
  const effectiveLimit = compactLimit({ limit, verbose }, 20);
  const results = searchAll(query, effectiveLimit);
  if (verbose) return textResponse(results);
  return textResponse(compactPage("search_results", results, { limit: effectiveLimit }, (result) => ({
    type: result.type,
    repo_name: result.repo_name,
    title: compactText(result.title, 120),
    snippet: compactText(result.snippet, 160),
    date: result.date,
  }), "Call get_repo for repo details or set verbose=true for full search rows"));
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

server.tool("get_stats", "Get global stats across all repos", {
  verbose: z.boolean().optional().describe("Return full stats arrays"),
}, async ({ verbose }) => {
  const stats = getGlobalStats();
  if (verbose) return textResponse(stats);
  return textResponse({
    kind: "stats",
    output: "compact",
    totals: {
      repos: stats.total_repos,
      commits: stats.total_commits,
      branches: stats.total_branches,
      tags: stats.total_tags,
      pull_requests: stats.total_prs,
    },
    repos_by_org: Object.fromEntries(Object.entries(stats.repos_by_org).slice(0, 10)),
    most_active_repos: stats.most_active_repos.slice(0, 5),
    stale_repos: stats.stale_repos.slice(0, 5),
    hint: "Set verbose=true for all org/activity/stale arrays.",
  });
});

server.tool("get_repo_stats", "Get detailed stats for a specific repo", {
  repo_id: z.number().describe("Repo ID"),
  verbose: z.boolean().optional().describe("Return full recent commit and author lists"),
}, async ({ repo_id, verbose }) => {
  const stats = getRepoStats(repo_id);
  if (verbose) return textResponse(stats);
  return textResponse({
    kind: "repo_stats",
    output: "compact",
    counts: {
      commits: stats.commit_count,
      branches: stats.branch_count,
      tags: stats.tag_count,
      pull_requests: stats.pr_count,
    },
    top_authors: stats.top_authors.slice(0, 5),
    recent_commits: stats.recent_commits.slice(0, 5).map((commit) => ({
      sha: commit.sha.slice(0, 12),
      message: compactText(commit.message, 120),
      author_name: commit.author_name,
      date: commit.date,
    })),
    hint: "Set verbose=true for all recent commits and authors.",
  });
});

// ── GitHub Sync ──

server.tool("sync_github_prs", "Sync PRs from GitHub for a specific repo", {
  repo: z.string().describe("Repo name, path, or ID"),
  limit: limitArg("Max PRs to fetch (default 100)"),
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
  limit: limitArg("Max PRs per repo (default 50)"),
}, async ({ org, limit }) => {
  const result = syncAllGithubPRs({ org, limit });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("fetch_repo_metadata", "Fetch GitHub metadata (stars, topics, language)", {
  repo: z.string().describe("Repo name or ID"),
  verbose: z.boolean().optional().describe("Return full fetched metadata"),
}, async ({ repo, verbose }) => {
  const meta = fetchRepoMetadata(repo);
  if (!meta) return textResponse({ error: "Cannot fetch metadata" });
  if (verbose) return textResponse(meta);
  return textResponse({
    kind: "github_metadata",
    output: "compact",
    description: compactText(meta.description, 180),
    language: meta.language,
    stars: meta.stars,
    forks: meta.forks,
    topics: meta.topics.slice(0, 10),
    hint: "Set verbose=true for the full metadata object.",
  });
});

// ── Knowledge Graph ──

server.tool("graph_build", "Build knowledge graph from repo data", {}, async () => {
  const result = buildGraph();
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("graph_query", "Query a node and its connections", {
  type: z.string().describe("Node type: repo, author, org, language"),
  id: z.string().describe("Node ID"),
  limit: limitArg("Max connection rows (default 20)"),
  verbose: z.boolean().optional().describe("Return full graph node"),
}, async ({ type, id, limit, verbose }) => {
  const node = queryNode(type, id);
  if (!node) return textResponse({ error: "Node not found" });
  if (verbose) return textResponse(node);
  const effectiveLimit = compactLimit({ limit }, node.edges.length || MCP_COMPACT_LIMIT);
  return textResponse({
    kind: "graph_node",
    output: "compact",
    type: node.type,
    id: node.id,
    label: compactText(node.label, 120),
    connection_count: node.edges.length,
    connections: node.edges.slice(0, effectiveLimit).map((edge) => ({
      relation: edge.relation,
      target_type: edge.target_type,
      target_id: compactText(edge.target_id, 120),
      weight: edge.weight,
    })),
    hint: "Set verbose=true for all graph node connections.",
  });
});

server.tool("graph_related", "Find repos related to a given repo", {
  repo: z.string().describe("Repo name or ID"),
  limit: limitArg("Max results (default 10)"),
  verbose: z.boolean().optional().describe("Return full related records"),
}, async ({ repo, limit, verbose }) => {
  const effectiveLimit = compactLimit({ limit, verbose }, 10, 10);
  const results = queryRelated(repo, effectiveLimit);
  if (verbose) return textResponse(results);
  return textResponse(compactPage("related_repos", results, { limit: effectiveLimit }, (result) => ({
    repo_id: result.repo_id,
    repo_name: compactText(result.repo_name, 120),
    relation: result.relation,
    weight: result.weight,
  }), "Set verbose=true for full related records"));
});

server.tool("graph_path", "Find shortest path between two nodes", {
  from_type: z.string().describe("Source node type"),
  from_id: z.string().describe("Source node ID"),
  to_type: z.string().describe("Target node type"),
  to_id: z.string().describe("Target node ID"),
  verbose: z.boolean().optional().describe("Return full graph path"),
}, async ({ from_type, from_id, to_type, to_id, verbose }) => {
  const path = findPath(from_type, from_id, to_type, to_id);
  if (!path) return textResponse({ error: "No path found" });
  if (verbose) return textResponse(path);
  return textResponse({
    kind: "graph_path",
    output: "compact",
    length: path.length,
    nodes: path.nodes.map((node) => ({ type: node.type, id: compactText(node.id, 120) })),
    edges: path.edges,
    hint: "Set verbose=true for full node ids.",
  });
});

server.tool("graph_deps", "Show dependency tree for a repo", {
  repo: z.string().describe("Repo name or ID"),
  depth: z.number().optional().describe("Max depth (default 3)"),
  limit: limitArg("Max dependency rows (default 20)"),
  verbose: z.boolean().optional().describe("Return full dependency rows"),
}, async ({ repo, depth, limit, verbose }) => {
  const deps = getDeps(repo, depth);
  if (verbose) return textResponse(deps);
  const effectiveLimit = compactLimit({ limit }, deps.length || MCP_COMPACT_LIMIT);
  return textResponse({
    kind: "graph_dependencies",
    output: "compact",
    count: deps.length,
    limit: effectiveLimit,
    items: deps.slice(0, effectiveLimit).map((dep) => ({
      repo_id: dep.repo_id,
      repo_name: compactText(dep.repo_name, 120),
      depth: dep.depth,
    })),
    hint: "Set verbose=true for full dependency rows.",
  });
});

server.tool("graph_stats", "Get knowledge graph statistics", {
  verbose: z.boolean().optional().describe("Return full relation/source breakdowns"),
}, async ({ verbose }) => {
  const stats = getGraphStats();
  if (verbose) return textResponse(stats);
  return textResponse({
    kind: "graph_stats",
    output: "compact",
    total_edges: stats.total_edges,
    by_relation: Object.fromEntries(Object.entries(stats.by_relation).slice(0, 10)),
    by_source_type: Object.fromEntries(Object.entries(stats.by_source_type).slice(0, 10)),
    hint: "Set verbose=true for full graph stats.",
  });
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

server.tool("list_agents", "List registered agents", {
  limit: limitArg("Max agents (default 20)"),
  verbose: z.boolean().optional().describe("Return full agent records"),
}, async ({ limit, verbose }) => {
  const db = getDb();
  const effectiveLimit = compactLimit({ limit, verbose }, 100);
  const agents = db.query("SELECT * FROM agents ORDER BY last_seen DESC LIMIT ?").all(effectiveLimit) as any[];
  if (verbose) return textResponse(agents);
  return textResponse({
    kind: "agents",
    output: "compact",
    count: agents.length,
    limit: effectiveLimit,
    items: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: compactText(agent.description, 120),
      session_id: agent.session_id,
      last_seen: agent.last_seen,
    })),
    hint: "Set verbose=true for capabilities and working directories.",
  });
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
