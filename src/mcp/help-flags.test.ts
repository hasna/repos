import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;

function runScript(script: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", script, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

describe("entrypoint help/version flags", () => {
  test("mcp help mentions http mode", () => {
    const result = runScript("src/mcp/index.ts", "--help");
    const out = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(out).toContain("--http");
    expect(out).toContain("--stdio");
    expect(out).toContain("default 8874");
    expect(out).toContain("Streamable HTTP default");
  });

  test("server help exits cleanly without starting server", () => {
    const result = runScript("src/server/index.ts", "--help");
    const out = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(out).toContain("Usage: repos-serve [options]");
    expect(out).not.toContain("repos server running");
  });

  test("mcp version returns semver", () => {
    const result = runScript("src/mcp/index.ts", "--version");
    const out = new TextDecoder().decode(result.stdout).trim();

    expect(result.exitCode).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out).toBe(PACKAGE_VERSION);
  });

  test("server version returns semver", () => {
    const result = runScript("src/server/index.ts", "--version");
    const out = new TextDecoder().decode(result.stdout).trim();

    expect(result.exitCode).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out).toBe(PACKAGE_VERSION);
  });

  test("release verifier exposes help and version without requiring verification options", () => {
    const help = runScript("src/release/verify-provenance.ts", "--help");
    const version = runScript("src/release/verify-provenance.ts", "--version");

    expect(help.exitCode).toBe(0);
    expect(new TextDecoder().decode(help.stdout)).toContain("Usage: repos-verify-release [options]");
    expect(version.exitCode).toBe(0);
    expect(new TextDecoder().decode(version.stdout).trim()).toBe(PACKAGE_VERSION);
  });
});
