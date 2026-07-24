import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer, MCP_NAME } from "./server.js";
import { handleMcpHttpRoutes, healthPayload, startMcpHttpServer } from "./http.js";
import { closeDb, getDb } from "../db/database.js";

let httpServer: Server;
let port: number;

beforeAll(async () => {
  process.env["REPOS_DB_PATH"] = ":memory:";
  httpServer = startMcpHttpServer({ port: 0 });
  await new Promise<void>((resolve) => {
    httpServer.once("listening", () => resolve());
  });
  const address = httpServer.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  delete process.env["REPOS_DB_PATH"];
  closeDb();
});

describe("MCP HTTP transport", () => {
  it("GET /health returns 200 with service name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(healthPayload());
  });

  it("performs initialize + tool call over Streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    const client = new Client({ name: "repos-http-test", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({ name: "get_stats", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.type).toBe("text");

    await client.close();
  });

  it("sanitizes contaminated repo and remote rows over MCP HTTP", async () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const db = getDb();
    const repo = db.query("INSERT INTO repos (path, name, remote_url) VALUES ('/tmp/mcp-output', 'mcp-output', ?) RETURNING id")
      .get(unsafe) as { id: number };
    db.query("INSERT INTO remotes (repo_id, name, url, fetch_url) VALUES (?, 'origin', ?, ?)")
      .run(repo.id, unsafe, unsafe);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "repos-http-redaction-test", version: "1.0.0" });
    await client.connect(transport);
    for (const request of [
      // Compact list_repos omits remotes; verbose exercises the full-record sanitization path.
      { name: "list_repos", arguments: { query: "mcp-output", verbose: true } },
      { name: "get_repo", arguments: { id: String(repo.id) } },
      { name: "search_repos", arguments: { query: "mcp" } },
      { name: "list_remotes", arguments: { repo_id: repo.id } },
    ]) {
      const result = await client.callTool(request);
      const text = (result.content?.[0] as { type?: string; text?: string } | undefined)?.text ?? "";
      expect(result.isError).not.toBe(true);
      expect(text).toContain("git.example.test/team/tool");
      expect(text).not.toContain(unsafe);
      expect(text).not.toContain("phrase");
    }
    await client.close();
  });

  it("handleMcpHttpRoutes mounts /health for Bun.serve reuse", async () => {
    const res = await handleMcpHttpRoutes(new Request("http://127.0.0.1/health"));
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual(healthPayload());
  });

  it("buildServer registers tools for stdio mode", () => {
    const server = buildServer();
    expect(server).toBeDefined();
    expect(MCP_NAME).toBe("repos");
  });
});
