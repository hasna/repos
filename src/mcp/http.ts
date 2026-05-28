import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer, MCP_NAME } from "./server.js";

export const DEFAULT_MCP_HTTP_PORT = 8874;

export function isHttpMode(argv: string[]): boolean {
  return argv.includes("--http") || process.env["MCP_HTTP"] === "1";
}

export function isStdioMode(argv: string[]): boolean {
  return argv.includes("--stdio") || process.env["MCP_STDIO"] === "1";
}

export function resolveMcpHttpPort(argv: string[]): number {
  const portIdx = argv.indexOf("--port");
  if (portIdx >= 0 && argv[portIdx + 1]) {
    return parseInt(argv[portIdx + 1]!, 10);
  }
  if (process.env["MCP_HTTP_PORT"]) {
    return parseInt(process.env["MCP_HTTP_PORT"], 10);
  }
  return DEFAULT_MCP_HTTP_PORT;
}

export function healthPayload(name: string = MCP_NAME): { status: string; name: string } {
  return { status: "ok", name };
}

export async function handleMcpHttpRoutes(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json(healthPayload());
  }

  if (url.pathname === "/mcp") {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildServer();
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  return null;
}

export function startMcpHttpServer(options: {
  port?: number;
  hostname?: string;
  onListening?: (port: number) => void;
} = {}): Server {
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? DEFAULT_MCP_HTTP_PORT;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${hostname}:${requestedPort}`}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthPayload()));
      return;
    }

    if (url.pathname === "/mcp") {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(requestedPort, hostname, () => {
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    options.onListening?.(port);
    console.error(`[${MCP_NAME}-mcp] HTTP listening on http://${hostname}:${port}/mcp`);
  });

  return httpServer;
}
