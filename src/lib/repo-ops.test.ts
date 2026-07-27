import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  getDocsDrift,
  getPackageDrift,
  getPackageHealth,
  getReleaseHealth,
  getReleasePipelineParity,
  resolvePackageBin,
  scanPorts,
  triageBranches,
  withTodos,
  type OpsCommandRunner,
} from "./repo-ops";

let tempDir = "";

function writePackage(options: {
  name?: string;
  lockName?: string;
  readme?: string;
  bin?: boolean;
  scriptPort?: number;
  license?: string;
  publishConfig?: Record<string, unknown>;
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
    license: options.license ?? "Apache-2.0",
    publishConfig: options.publishConfig,
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

/** HEAD commit of the temp repo, for use as a reachable published gitHead. */
function headSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();
}

/**
 * Command-aware `npm view` stub.
 *
 * The previous stub answered every `npm view` — `version` and anything else —
 * with the same "9.9.9". That is a stub that measures nothing: the drift test
 * passed without the audit ever establishing that the published artifact came
 * from this repo, which is exactly how hasna/cli's unrelated npmjs package read
 * as tag-pipeline drift.
 */
function npmViewRunner(opts: { version: string; gitHead?: string | null }): OpsCommandRunner {
  return (command, args) => {
    if (command === "npm" && args.includes("view") && args.includes("gitHead")) {
      return opts.gitHead
        ? { ok: true, stdout: opts.gitHead, stderr: "", exitCode: 0 }
        : { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "npm" && args.includes("view") && args.includes("version")) {
      return { ok: true, stdout: opts.version, stderr: "", exitCode: 0 };
    }
    return { ok: false, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}`, exitCode: 1 };
  };
}

function initGitRepo() {
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "pipe" });
  writeFileSync(join(tempDir, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "pipe" });
}

function writeWorkflows(options: { ci?: string; publish?: string } = {}) {
  mkdirSync(join(tempDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(tempDir, ".github", "workflows", "ci.yml"), options.ci ?? "on:\n  push:\n    branches: [main]\njobs: {}\n");
  if (options.publish !== undefined) {
    writeFileSync(join(tempDir, ".github", "workflows", "publish.yml"), options.publish);
  }
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
        "repos docs drift repos release health repos release parity repos no-cloud inventory",
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

  it("flags repos missing the standard ci.yml + tag-publish publish.yml pair", () => {
    writePackage();

    const result = getReleasePipelineParity({ cwd: tempDir, includeRegistry: false });

    expect(result.kind).toBe("release_pipeline_parity");
    expect(result.status).toBe("warn");
    expect(result.workflows.standard_pair).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("ci_workflow_missing");
    expect(codes).toContain("publish_workflow_missing");
  });

  it("accepts the standard workflow pair with a tag-triggered publish", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags:\n      - \"v*\"\njobs: {}\n" });

    const result = getReleasePipelineParity({ cwd: tempDir, includeRegistry: false });

    expect(result.status).toBe("ok");
    expect(result.workflows.standard_pair).toBe(true);
    expect(result.workflows.publish.tag_triggered).toBe(true);
  });

  it("flags a publish workflow that is not tag-triggered", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  workflow_dispatch: {}\njobs: {}\n" });

    const result = getReleasePipelineParity({ cwd: tempDir, includeRegistry: false });

    expect(result.status).toBe("warn");
    expect(result.issues.map((issue) => issue.code)).toContain("publish_workflow_not_tag_triggered");
    expect(result.workflows.standard_pair).toBe(false);
  });

  it("does not mistake job-step tags: inputs for a tag trigger", () => {
    writePackage();
    // Branch-triggered publish whose first job step uses docker/build-push-action's `tags:` input.
    writeWorkflows({
      publish: [
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  docker:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: docker/build-push-action@v6",
        "        with:",
        "          push: true",
        "          tags: user/app:latest",
        "",
      ].join("\n"),
    });

    const result = getReleasePipelineParity({ cwd: tempDir, includeRegistry: false });

    expect(result.workflows.publish.tag_triggered).toBe(false);
    expect(result.workflows.standard_pair).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("publish_workflow_not_tag_triggered");
  });

  it("falls back to origin tags when the local clone has not fetched them", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    // Tag exists on origin but not locally (e.g. shallow clone / fetch-tags disabled).
    const remoteDir = join(tempDir, "..", `${basename(tempDir)}-origin.git`);
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["tag", "v9.9.9"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "v9.9.9"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["tag", "-d", "v9.9.9"], { cwd: tempDir, stdio: "pipe" });
    const runner = npmViewRunner({ version: "9.9.9", gitHead: headSha() });

    try {
      const result = getReleasePipelineParity({ cwd: tempDir, runner });

      expect(result.status).toBe("ok");
      expect(result.registry.git_tag_for_latest).toBe("v9.9.9");
      expect(result.registry.npm_latest_without_git_tag).toBe(false);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("detects npm-latest-without-git-tag drift", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    // gitHead is this repo's own HEAD, so the artifact is provably ours and
    // "publish bypassed the tag pipeline" is a claim the evidence supports.
    const runner = npmViewRunner({ version: "9.9.9", gitHead: headSha() });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.registry.checked).toBe(true);
    expect(result.registry.npm_latest).toBe("9.9.9");
    expect(result.registry.git_head_reachability).toBe("reachable");
    expect(result.registry.npm_latest_without_git_tag).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("npm_latest_without_git_tag");
    expect(result.status).toBe("warn");
  });

  it("does not claim tag-pipeline drift when the published artifact is a different package", () => {
    // hasna/cli's npmjs artifact carries gitHead
    // 207800eaf5bc582999b227a2ef7393b5e0991a4e, which is not a commit in
    // hasna/cli. Under the old check that produced a high-priority
    // npm_latest_without_git_tag warning — the tag is genuinely absent, because
    // the artifact was never built here.
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    const runner = npmViewRunner({ version: "9.9.9", gitHead: "207800eaf5bc582999b227a2ef7393b5e0991a4e" });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.registry.git_head_reachability).toBe("absent");
    expect(result.registry.npm_latest_without_git_tag).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("registry_unrelated_name");
    expect(codes).not.toContain("npm_latest_without_git_tag");
  });

  it("reports an unverified tag gap when the artifact carries no gitHead", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    const runner = npmViewRunner({ version: "9.9.9", gitHead: null });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.registry.git_head).toBeNull();
    expect(result.registry.git_head_reachability).toBe("unknown");
    // Absent provenance is its own state: the tag gap is reported, but not as a
    // tag-pipeline bypass, and not as a name collision either.
    expect(result.registry.npm_latest_without_git_tag).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("npm_latest_without_git_tag_unverified");
    expect(codes).not.toContain("npm_latest_without_git_tag");
    expect(codes).not.toContain("registry_unrelated_name");
  });

  it("resolves the drift registry from publishConfig and skips npmjs when it is not the target", () => {
    const seen: string[] = [];
    writePackage({ publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted", tag: "internal" } });
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    const runner: OpsCommandRunner = (command, args) => {
      seen.push(`${command} ${args.join(" ")}`);
      return { ok: true, stdout: "9.9.9", stderr: "", exitCode: 0 };
    };

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.registry.registry_url).toBe("https://npm.pkg.github.com");
    expect(result.registry.registry_source).toBe("publishConfig.registry");
    expect(result.registry.scope).toBe("non-npmjs-registry");
    expect(result.registry.checked).toBe(false);
    // No registry command ran at all: an npmjs lookup under this name would
    // describe a different package.
    expect(seen).toEqual([]);
    const outOfScope = result.issues.find((issue) => issue.code === "registry_out_of_npmjs_scope");
    expect(outOfScope?.message).toContain("npm.pkg.github.com");
  });

  it("positive control: the same capture records npm view when npmjs IS the target", () => {
    const seen: string[] = [];
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    const runner: OpsCommandRunner = (command, args) => {
      seen.push(`${command} ${args.join(" ")}`);
      return { ok: true, stdout: "9.9.9", stderr: "", exitCode: 0 };
    };

    getReleasePipelineParity({ cwd: tempDir, runner });

    expect(seen.some((entry) => entry.startsWith("npm view @hasna/repos version"))).toBe(true);
  });

  it("classifies access=restricted on npmjs out of drift scope", () => {
    writePackage({ publishConfig: { access: "restricted" } });
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    const runner = npmViewRunner({ version: "9.9.9", gitHead: headSha() });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.registry.registry_url).toBe("https://registry.npmjs.org");
    expect(result.registry.registry_source).toBe("default-npmjs");
    expect(result.registry.scope).toBe("npmjs-restricted");
    expect(result.registry.checked).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("registry_out_of_npmjs_scope");
  });

  it("passes the registry check when the npm latest version is tagged", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    initGitRepo();
    execFileSync("git", ["tag", "v9.9.9"], { cwd: tempDir, stdio: "pipe" });
    const runner = npmViewRunner({ version: "9.9.9", gitHead: headSha() });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.status).toBe("ok");
    expect(result.registry.git_tag_for_latest).toBe("v9.9.9");
    expect(result.registry.npm_latest_without_git_tag).toBe(false);
  });

  it("degrades to an info issue when the npm registry is unreachable", () => {
    writePackage();
    writeWorkflows({ publish: "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n" });
    const runner: OpsCommandRunner = () => ({ ok: false, stdout: "", stderr: "ETIMEDOUT registry.npmjs.org", exitCode: 1 });

    const result = getReleasePipelineParity({ cwd: tempDir, runner });

    expect(result.status).toBe("ok");
    expect(result.registry.checked).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("npm_registry_unreachable");
  });

  it("includes the release pipeline parity check in release health", () => {
    writePackage({ readme: "# @hasna/repos\nrepos\n" });

    const result = getReleaseHealth({ cwd: tempDir, includeGit: false, limit: 20 });

    expect(result.checks.pipeline.status).toBe("warn");
    expect(result.summary.pipeline_standard_pair).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("pipeline_ci_workflow_missing");
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
