import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

function writePackage() {
  writeFileSync(join(tempDir, "package.json"), JSON.stringify({
    name: "@hasna/repos",
    version: "1.0.0",
    license: "Apache-2.0",
    scripts: {
      build: "tsc",
      test: "bun test",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      chalk: "^5.0.0",
    },
  }, null, 2));
  writeFileSync(join(tempDir, "bun.lock"), `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "@hasna/repos",
      "dependencies": {
        "chalk": "^5.0.0",
      },
    },
  },
  "packages": {},
}
`);
  writeFileSync(join(tempDir, "README.md"), [
    "# @hasna/repos",
    "repos package health repos package drift repos package resolve-bin",
    "repos ports scan repos triage branches repos triage prs",
    "repos docs drift repos release health",
  ].join("\n"));
}

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      NO_COLOR: "1",
    },
  });
}

beforeEach(() => {
  tempDir = join(tmpdir(), `repos-cli-ops-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  writePackage();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("repo ops CLI commands", () => {
  test("package drift emits compact JSON by default", () => {
    const result = runCli(["package", "drift", tempDir]);
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode, stderr).toBe(0);
    expect(stdout.trim()).not.toContain("\n");
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "package_drift",
      schema_version: "1.0",
      status: "ok",
      summary: {
        issues: 0,
      },
    });
  });

  test("todo integration is a dry-run preview unless explicitly applied", () => {
    const result = runCli(["package", "health", tempDir, "--todo", "task-123"]);
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "package_health",
      todos: {
        task_id: "task-123",
        dry_run: true,
        applied: false,
      },
    });
  });

  test("top-level help lists agent ops command groups", () => {
    const result = runCli(["--help"]);
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("package");
    expect(stdout).toContain("ports");
    expect(stdout).toContain("triage");
    expect(stdout).toContain("release-health");
  });
});
