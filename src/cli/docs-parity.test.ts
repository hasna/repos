import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = resolve(ROOT, "src/cli/index.tsx");
const CLI_DOCS = readFileSync(resolve(ROOT, "docs/cli.md"), "utf8");
const MCP_DOCS = readFileSync(resolve(ROOT, "docs/mcp.md"), "utf8");
const SDK_DOCS = readFileSync(resolve(ROOT, "docs/sdk.md"), "utf8");
const HTTP_DOCS = readFileSync(resolve(ROOT, "docs/http-api.md"), "utf8");
const CONFIG_DOCS = readFileSync(resolve(ROOT, "docs/configuration.md"), "utf8");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");

function help(path: string[]): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", CLI, ...path, "--help"],
    cwd: ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

function commandsInHelp(output: string): string[] {
  const marker = output.indexOf("\nCommands:\n");
  if (marker < 0) return [];
  const commands: string[] = [];
  for (const line of output.slice(marker + 11).split("\n")) {
    const match = line.match(/^  ([a-z][a-z0-9-]*)(?:\s|$)/);
    if (match?.[1] && match[1] !== "help") commands.push(match[1]);
  }
  return commands;
}

function longOptionsInHelp(output: string): string[] {
  return Array.from(new Set(output.match(/--[a-z][a-z0-9-]*/g) ?? []))
    .filter((option) => option !== "--help" && option !== "--version");
}

describe("documentation parity", () => {
  test("the CLI reference contains every command and long option exposed by live help", () => {
    const queue: string[][] = [[]];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const path = queue.shift()!;
      const key = path.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);

      const output = help(path);
      for (const option of longOptionsInHelp(output)) {
        expect(CLI_DOCS, `${key || "repos"} help option ${option}`).toContain(option);
      }
      for (const command of commandsInHelp(output)) {
        const child = [...path, command];
        const commandPath = `repos ${child.join(" ")}`;
        expect(CLI_DOCS, `missing ${commandPath}`).toContain(commandPath);
        queue.push(child);
      }
    }
  }, 30_000);

  test("the MCP reference names every registered tool and reports the exact count", () => {
    const source = readFileSync(resolve(ROOT, "src/mcp/server.ts"), "utf8");
    const tools = Array.from(source.matchAll(/server\.tool\("([^"]+)"/g), (match) => match[1]!);

    expect(tools).toHaveLength(36);
    expect(new Set(tools).size).toBe(tools.length);
    for (const tool of tools) expect(MCP_DOCS).toContain(`\`${tool}\``);
    expect(README).toContain(`${tools.length} tools available`);
  });

  test("the SDK reference names every package-root value export", () => {
    const source = readFileSync(resolve(ROOT, "src/index.ts"), "utf8");
    const exports = Array.from(source.matchAll(/export\s+\{([\s\S]*?)\}\s+from/g))
      .flatMap((match) => match[1]!.split(","))
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !name.startsWith("type "));

    for (const name of exports) expect(SDK_DOCS).toContain(`\`${name}\``);
  });

  test("the HTTP reference covers every REST route and README docs links resolve", () => {
    for (const route of [
      "/api/repos",
      "/api/repos/:id",
      "/api/search/repos",
      "/api/commits",
      "/api/search/commits",
      "/api/branches",
      "/api/tags",
      "/api/prs",
      "/api/search",
      "/api/stats",
      "/api/health",
      "/api/scan",
    ]) expect(HTTP_DOCS).toContain(route);

    const links = Array.from(README.matchAll(/\]\((docs\/[^)]+\.md)\)/g), (match) => match[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(Bun.file(resolve(ROOT, link)).size).toBeGreaterThan(0);

    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(packageJson.files).toContain("docs");
  });

  test("the configuration reference covers every product-specific environment variable", () => {
    const productionFiles = [
      "src/cli/index.tsx",
      "src/db/database.ts",
      "src/lib/auto-index.ts",
      "src/lib/config.ts",
      "src/lib/github-catalog.ts",
      "src/lib/machine-id.ts",
      "src/lib/status.ts",
      "src/mcp/http.ts",
      "src/mcp/server.ts",
      "src/server/index.ts",
    ];
    const variables = new Set<string>();
    for (const file of productionFiles) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      for (const match of source.matchAll(/process\.env(?:\["([A-Z0-9_]+)"\]|\.([A-Z0-9_]+))/g)) {
        const name = match[1] ?? match[2];
        if (name && name !== "HOME" && name !== "USERPROFILE") variables.add(name);
      }
    }
    variables.add("HASNA_REPOS_DATABASE_SSL");
    variables.add("REPOS_DATABASE_SSL");

    for (const variable of variables) expect(CONFIG_DOCS).toContain(variable);
  });
});
