#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  listRepos,
  getRepo,
  searchRepos,
  listCommits,
  searchCommits,
  listBranches,
  listTags,
  listPullRequests,
  searchAll,
  getGlobalStats,
  getRepoStats,
} from "../db/repos.js";
import { ensureWorkspaceBootstrap, startAutoIndexWorker } from "../lib/auto-index.js";
import { getHealthReport } from "../lib/utils.js";
import { handleMcpHttpRoutes } from "../mcp/http.js";
import { getCliVersion } from "../cli/version.js";

const VERSION = getCliVersion();

function handleCliFlags(argv: string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: repos-serve [options]");
    console.log("");
    console.log("HTTP API and dashboard server for @hasna/repos");
    console.log("");
    console.log("Options:");
    console.log("  -h, --help     display help");
    console.log("  -V, --version  display version");
    console.log("");
    console.log("Environment:");
    console.log("  REPOS_PORT     Server port (default: 19450)");
    return true;
  }

  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(VERSION);
    return true;
  }

  return false;
}

if (handleCliFlags(process.argv.slice(2))) {
  process.exit(0);
}

const PORT = parseInt(process.env["REPOS_PORT"] || "19450");

const clients = new Set<ServerWebSocket>();

function broadcast(event: string, data?: unknown) {
  const msg = JSON.stringify({ event, data });
  for (const ws of clients) {
    ws.send(msg);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function parseQuery(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = value;
  }
  return params;
}

const dashboardDir = join(import.meta.dir, "../../dashboard/dist");

const autoIndexWorker = await startAutoIndexWorker(undefined, {
  onProgress: (msg) => console.log(`[auto-index] ${msg}`),
});

process.on("SIGINT", () => autoIndexWorker.stop());
process.on("SIGTERM", () => autoIndexWorker.stop());

Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ event: "connected", data: { status: "ok" } }));
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, msg: string | Buffer) {
      try {
        const { event } = JSON.parse(msg.toString());
        if (event === "ping") ws.send(JSON.stringify({ event: "pong" }));
      } catch { /* ignore malformed */ }
    },
  },
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const q = parseQuery(url);

    // MCP Streamable HTTP (shared long-lived transport)
    const mcpResponse = await handleMcpHttpRoutes(req);
    if (mcpResponse) return mcpResponse;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // ── API Routes ──

    if (path === "/api/repos" && req.method === "GET") {
      return json(listRepos({ org: q["org"], query: q["query"], limit: parseInt(q["limit"] || "50"), offset: parseInt(q["offset"] || "0") }));
    }

    if (path.startsWith("/api/repos/") && req.method === "GET") {
      const id = path.replace("/api/repos/", "");
      const repo = getRepo(isNaN(Number(id)) ? id : Number(id));
      if (!repo) return json({ error: "Repo not found" }, 404);
      const stats = getRepoStats(repo.id);
      return json({ ...repo, ...stats });
    }

    if (path === "/api/search/repos" && req.method === "GET") {
      return json(searchRepos(q["query"] || "", parseInt(q["limit"] || "20")));
    }

    if (path === "/api/commits" && req.method === "GET") {
      return json(listCommits({
        repo_id: q["repo_id"] ? parseInt(q["repo_id"]) : undefined,
        author: q["author"],
        since: q["since"],
        until: q["until"],
        limit: parseInt(q["limit"] || "50"),
        offset: parseInt(q["offset"] || "0"),
      }));
    }

    if (path === "/api/search/commits" && req.method === "GET") {
      return json(searchCommits(q["query"] || "", parseInt(q["limit"] || "20")));
    }

    if (path === "/api/branches" && req.method === "GET") {
      return json(listBranches({
        repo_id: q["repo_id"] ? parseInt(q["repo_id"]) : undefined,
        limit: parseInt(q["limit"] || "100"),
      }));
    }

    if (path === "/api/tags" && req.method === "GET") {
      return json(listTags({
        repo_id: q["repo_id"] ? parseInt(q["repo_id"]) : undefined,
        limit: parseInt(q["limit"] || "100"),
      }));
    }

    if (path === "/api/prs" && req.method === "GET") {
      return json(listPullRequests({
        repo_id: q["repo_id"] ? parseInt(q["repo_id"]) : undefined,
        state: q["state"],
        author: q["author"],
        limit: parseInt(q["limit"] || "50"),
      }));
    }

    if (path === "/api/search" && req.method === "GET") {
      return json(searchAll(q["query"] || "", parseInt(q["limit"] || "20")));
    }

    if (path === "/api/stats" && req.method === "GET") {
      return json(getGlobalStats());
    }

    if (path === "/api/health" && req.method === "GET") {
      return json(getHealthReport());
    }

    if (path === "/api/scan" && req.method === "POST") {
      const body = req.headers.get("content-type")?.includes("json") ? await req.json() : {};
      const result = await ensureWorkspaceBootstrap(body.roots, { force: true, full: body.full });
      const hookSummary = {
        installed: result.hooks.installed,
        updated: result.hooks.updated,
        unchanged: result.hooks.unchanged,
        skipped: result.hooks.skipped,
      };
      broadcast("scan:complete", { ...result.scan, hooks: hookSummary });
      return json({ ...result.scan, hooks: hookSummary });
    }

    // ── Dashboard static files ──
    if (existsSync(dashboardDir)) {
      let filePath = join(dashboardDir, path === "/" ? "index.html" : path);
      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath));
      }
      // SPA fallback
      const indexPath = join(dashboardDir, "index.html");
      if (existsSync(indexPath) && !path.startsWith("/api/")) {
        return new Response(Bun.file(indexPath));
      }
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`repos server running on http://localhost:${PORT}`);
