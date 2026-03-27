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
import { scanRepos } from "../lib/scanner.js";
import { getHealthReport } from "../lib/utils.js";

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
      const result = await scanRepos(body.roots, { full: body.full });
      broadcast("scan:complete", result);
      return json(result);
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
