import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDocsDrift,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  withTodos,
} from "./repo-ops";

let tempDir = "";

function writePackage(options: {
  name?: string;
  lockName?: string;
  readme?: string;
  bin?: boolean;
  scriptPort?: number;
} = {}) {
  const packageName = options.name ?? "@hasna/repos";
  const scripts: Record<string, string> = {
    build: "tsc",
    test: "bun test",
    typecheck: "tsc --noEmit",
  };
  if (options.scriptPort) {
    scripts.dev = `PORT=${options.scriptPort} vite --port ${options.scriptPort}`;
  }

  if (options.bin) {
    mkdirSync(join(tempDir, "bin"), { recursive: true });
    writeFileSync(join(tempDir, "bin", "cli.js"), "#!/usr/bin/env bun\nconsole.log('ok');\n");
    chmodSync(join(tempDir, "bin", "cli.js"), 0o755);
  }

  writeFileSync(join(tempDir, "package.json"), JSON.stringify({
    name: packageName,
    version: "1.2.3",
    license: "Apache-2.0",
    scripts,
    bin: options.bin ? { repos: "bin/cli.js" } : undefined,
    dependencies: {
      chalk: "^5.0.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  }, null, 2));

  writeFileSync(join(tempDir, "bun.lock"), `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "${options.lockName ?? packageName}",
      "dependencies": {
        "chalk": "^5.0.0",
      },
      "devDependencies": {
        "typescript": "^5.0.0",
      },
    },
  },
  "packages": {},
}
`);

  if (options.readme !== undefined) {
    writeFileSync(join(tempDir, "README.md"), options.readme);
  }
}

function initGitRepo() {
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "pipe" });
  writeFileSync(join(tempDir, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "pipe" });
}

beforeEach(() => {
  tempDir = join(tmpdir(), `repos-ops-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("repo ops primitives", () => {
  it("reports package health and bun.lock drift with bounded issues", () => {
    writePackage({ lockName: "@hasna/old-repos", bin: true });

    const health = getPackageHealth({ cwd: tempDir, limit: 5 });
    expect(health.kind).toBe("package_health");
    expect(health.status).toBe("warn");
    expect(health.bins).toMatchObject([{ name: "repos", exists: true, shebang: true }]);
    expect(health.issues.map((issue) => issue.code)).toContain("lock_package_name_mismatch");

    const drift = getPackageDrift({ cwd: tempDir, limit: 5 });
    expect(drift.status).toBe("warn");
    expect(drift.drift?.package_name).toBe("@hasna/repos");
    expect(drift.drift?.lock_package_name).toBe("@hasna/old-repos");
    expect(drift.drift?.sections.dependencies?.spec_mismatches).toEqual([]);
  });

  it("redacts secret-shaped strings from package and drift output", () => {
    const rawSecret = ["github", "pat", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("_");
    writePackage({ name: rawSecret, lockName: rawSecret });

    const health = getPackageHealth({ cwd: tempDir });
    const drift = getPackageDrift({ cwd: tempDir });
    const serialized = `${JSON.stringify(health)}\n${JSON.stringify(drift)}`;

    expect(serialized).not.toContain(rawSecret);
    expect(serialized).toContain("github_pat_***");
  });

  it("skips drift without warning when a supported non-bun lockfile exists", () => {
    writePackage();
    rmSync(join(tempDir, "bun.lock"), { force: true });
    writeFileSync(join(tempDir, "package-lock.json"), "{}\n");

    const drift = getPackageDrift({ cwd: tempDir });

    expect(drift.status).toBe("ok");
    expect(drift.drift?.skipped).toBe(true);
    expect(drift.drift?.lockfile).toBe("package-lock.json");
    expect(drift.issues).toMatchObject([{ code: "drift_skipped", severity: "info" }]);
  });

  it("resolves package bins without requiring PATH lookup", () => {
    writePackage({ bin: true });

    const result = resolvePackageBin({ cwd: tempDir, name: "repos" });

    expect(result.status).toBe("ok");
    expect(result.matches.some((match) => match.source === "package.bin" && match.exists)).toBe(true);
  });

  it("checks docs drift for package and agent ops command mentions", () => {
    writePackage({
      bin: true,
      readme: [
        "# @hasna/repos",
        "repos repos-mcp repos-serve",
        "repos package health repos package drift repos package resolve-bin",
        "repos ports scan repos triage branches repos triage prs",
        "repos docs drift repos release health repos no-cloud inventory",
      ].join("\n"),
    });

    const result = getDocsDrift({ cwd: tempDir });

    expect(result.status).toBe("ok");
    expect(result.docs.missing_mentions).toEqual([]);
  });

  it("combines release health checks without duplicate lock drift messages", () => {
    writePackage({ lockName: "@hasna/old-repos", readme: "# @hasna/repos\nrepos\n" });

    const result = getReleaseHealth({ cwd: tempDir, includeGit: false, limit: 20 });

    expect(result.status).toBe("warn");
    expect(result.issues.filter((issue) => issue.message === "package.json name does not match bun.lock root name")).toHaveLength(1);
    expect(result.checks.branches).toBeNull();
  });

  it("detects dirty branch state in a git repo", () => {
    initGitRepo();
    writeFileSync(join(tempDir, "tracked.txt"), "changed\n");

    const result = triageBranches({ cwd: tempDir });

    expect(result.kind).toBe("branch_triage");
    expect(result.status).toBe("warn");
    expect(result.git.dirty.modified).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("worktree_dirty");
  });

  it("preserves dotted branch names during branch triage", () => {
    initGitRepo();
    execFileSync("git", ["checkout", "-b", "release/1.2.3"], { cwd: tempDir, stdio: "pipe" });

    const result = triageBranches({ cwd: tempDir });

    expect(result.git.current).toBe("release/1.2.3");
  });

  it("extracts package script port hints during port scans", () => {
    writePackage({ scriptPort: 3456 });

    const result = scanPorts({ cwd: tempDir, port: 3456 });

    expect(result.project_ports).toContainEqual({ port: 3456, source: "script:dev" });
    expect(result.summary.project_ports).toBe(1);
  });

  it("keeps todos integration as a dry-run unless apply is requested", () => {
    writePackage();
    const report = withTodos(getPackageDrift({ cwd: tempDir }), { taskId: "task-123", cwd: tempDir });

    expect(report.todos).toMatchObject({
      task_id: "task-123",
      dry_run: true,
      applied: false,
    });
    expect(report.todos?.comment_preview).toContain("repos package_drift");
  });
});
