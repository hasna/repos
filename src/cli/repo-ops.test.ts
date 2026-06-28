import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function runCliWithEnv(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      NO_COLOR: "1",
      ...env,
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

  test("no-cloud inventory CLI emits route-safe schema", () => {
    const result = runCli(["no-cloud", "inventory", tempDir, "--pretty"]);
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "no_cloud_inventory",
      schema_version: "1.2",
      summary: {
        repos: 0,
        routeable: 0,
      },
    });
  });

  test("pr queue rejects multi-org sync without an explicit repo cap", () => {
    const result = runCli(["ops", "pr-queue", "--sync-orgs", "hasna", "--json"]);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--sync-orgs requires --sync-max-repos");
  });

  test("pr queue exits non-zero on sync errors by default", () => {
    const binDir = join(tempDir, "bin");
    const repoDir = join(tempDir, "open-test");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, "#!/usr/bin/env bash\necho 'gh unavailable' >&2\nexit 7\n");
    chmodSync(ghPath, 0o755);
    Bun.spawnSync({ cmd: ["git", "init"], cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "https://github.com/hasna/open-test.git"], cwd: repoDir, stdout: "pipe", stderr: "pipe" });

    const env = {
      HASNA_REPOS_DB_PATH: join(tempDir, "repos.db"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const scan = runCliWithEnv(["scan", "--root", tempDir, "--json"], env);
    expect(scan.exitCode).toBe(0);

    const result = runCliWithEnv([
      "ops",
      "pr-queue",
      "--sync-orgs",
      "hasna",
      "--sync-max-repos",
      "1",
      "--json",
    ], env);
    const stdout = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdout).synced.errors[0]).toContain("gh pr list");
  });
});
