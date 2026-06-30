import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import { bulkInsertPullRequests, upsertRepo } from "../db/repos.js";
import {
  buildDependencyRefresh,
  buildDocsRulesDrift,
  buildPrQueue,
  buildProtectedRelease,
  buildReleaseCandidates,
  buildTaskRouteHealth,
  buildWorkspaceWorktreeHygiene,
  inspectPackageHygiene,
  runGlobalCliSmoke,
  type CommandRunner,
} from "./ops-producers.js";

const tempDirs: string[] = [];

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ops producers", () => {
  test("builds normalized PR queue items with task seeds", () => {
    const repo = upsertRepo({
      path: "/workspace/open-loops",
      name: "open-loops",
      org: "hasna",
      remote_url: "git@github.com:hasna/loops.git",
    });
    bulkInsertPullRequests([
      {
        repo_id: repo.id,
        number: 12,
        title: "Fix loop routing",
        state: "open",
        author: "andrei-hasna",
        created_at: "2026-06-27T00:00:00Z",
        updated_at: "2026-06-27T01:00:00Z",
        merged_at: null,
        closed_at: null,
        url: "https://github.com/hasna/loops/pull/12",
        base_branch: "main",
        head_branch: "fix/routing",
        additions: 10,
        deletions: 2,
        changed_files: 3,
      },
    ]);

    const result = buildPrQueue({ org: "hasna" });

    expect(result.schema).toBe("open-repos.pr-queue.v1");
    expect(result.summary.items).toBe(1);
    expect(result.items[0]!.repo.full_name).toBe("hasna/loops");
    expect(result.items[0]!.task_seed.fingerprint).toBe("github-pr:hasna/loops#12");
    expect(result.items[0]!.task_seed.tags).toContain("auto:route");
    expect(result.task_suggestions[0]!.fingerprint).toBe("github-pr:hasna/loops#12");
  });

  test("keeps large PR queue JSON stable with escaped task seed content", () => {
    const repo = upsertRepo({
      path: "/workspace/open-repos",
      name: "open-repos",
      org: "hasna",
      remote_url: "https://github.com/hasna/repos.git",
    });
    const oddTitle = "Fix \"quoted\" PR queue\nwith tab\tand bell \u0007";
    bulkInsertPullRequests(Array.from({ length: 505 }, (_, index) => ({
      repo_id: repo.id,
      number: index + 1,
      title: `${oddTitle} #${index + 1}`,
      state: "open" as const,
      author: "andrei-hasna",
      created_at: "2026-06-27T00:00:00Z",
      updated_at: `2026-06-27T01:${String(index % 60).padStart(2, "0")}:00Z`,
      merged_at: null,
      closed_at: null,
      url: `https://github.com/hasna/repos/pull/${index + 1}`,
      base_branch: "main",
      head_branch: `fix/pr-queue-${index + 1}`,
      additions: index,
      deletions: 1,
      changed_files: 2,
    })));

    const result = buildPrQueue({ org: "hasna", limit: 500 });
    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json) as typeof result;

    expect(parsed.schema).toBe("open-repos.pr-queue.v1");
    expect(parsed.summary.items).toBe(500);
    expect(parsed.items).toHaveLength(500);
    expect(parsed.items[0]!.pr.title).toContain('"quoted"');
    expect(parsed.items[0]!.pr.title).toContain("\n");
    expect(parsed.items[0]!.task_seed.title).toContain('"quoted"');
    expect(parsed.items[0]!.task_seed.body).toContain("https://github.com/hasna/repos/pull/");
  });

  test("smokes CLIs with an injectable bounded runner", () => {
    const runner: CommandRunner = (command) => command === "missing"
      ? { status: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "not found" } }
      : { status: 0, stdout: "ok\n", stderr: "" };

    const result = runGlobalCliSmoke({ commands: ["repos", "missing"], runner });

    expect(result.summary.checked).toBe(2);
    expect(result.summary.ok).toBe(1);
    expect(result.summary.missing).toBe(1);
    expect(result.commands.find((row) => row.command === "missing")?.task_seed?.fingerprint).toBe("cli-smoke:missing");
    expect(result.task_suggestions[0]!.fingerprint).toBe("cli-smoke:missing");
  });

  test("global CLI smoke uses fallback probes and includes legacy commands", () => {
    const seen: string[] = [];
    const runner: CommandRunner = (command, args) => {
      seen.push(`${command} ${args.join(" ")}`.trim());
      if (command === "dispatch") return { status: 0, stdout: "dispatch help", stderr: "" };
      if (command === "loops-daemon") return { status: 0, stdout: "0.3.26", stderr: "" };
      if (command === "fallback-only" && args[0] === "version") return { status: 0, stdout: "1.0.0", stderr: "" };
      return { status: 1, stdout: "", stderr: "bad flag" };
    };

    const defaultResult = runGlobalCliSmoke({ commands: ["loops-daemon", "dispatch"], runner });
    const fallbackResult = runGlobalCliSmoke({ commands: ["fallback-only"], runner });

    expect(defaultResult.summary.ok).toBe(2);
    expect(fallbackResult.summary.ok).toBe(1);
    expect(fallbackResult.commands[0]!.args).toEqual(["version"]);
    expect(seen).toContain("fallback-only --help");
    expect(seen).toContain("fallback-only version");
  });

  test("detects Hasna packages duplicated in npm global installs", () => {
    const runner: CommandRunner = (command) => {
      if (command === "bun") {
        return { status: 0, stdout: "@hasna/loops@0.3.21\n@hasna/repos@0.1.16\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          dependencies: {
            "@hasna/loops": { version: "0.3.19" },
            "typescript": { version: "5.8.2" },
          },
        }),
        stderr: "",
      };
    };

    const result = inspectPackageHygiene({ scopes: ["@hasna"], runner });

    expect(result.summary.bun_packages_seen).toBe(2);
    expect(result.summary.scoped_npm_duplicates).toBe(1);
    expect(result.task_seeds[0]!.fingerprint).toBe("package-hygiene:npm-global-duplicate:@hasna/loops");
  });

  test("emits a release candidate task for a quiet green branch with unreleased commits", () => {
    const repoPath = writeCargoVersion("0.2.0");
    const headSha = "abcdef1234567890abcdef1234567890abcdef12";
    const runner = releaseRunner({
      headSha,
      headCommittedAt: "2026-06-26T00:00:00Z",
      latestReachableTag: "rust-v0.1.0",
      commitsSinceTag: "3",
      latestGithubRelease: "rust-v0.1.0",
      latestNpmVersion: "0.1.0",
      openPrCount: 0,
      latestReleaseAncestor: true,
      intendedTagExists: false,
      ciRuns: [{ status: "completed", conclusion: "success", workflowName: "ci" }],
    });

    const result = buildReleaseCandidates({
      repo: repoPath,
      githubRepo: "hasna/codewith",
      packageName: "@hasna/codewith",
      tagPrefix: "rust-v",
      versionFile: "codex-rs/Cargo.toml",
      fetch: false,
      runner,
    });

    expect(result.schema).toBe("open-repos.release-candidates.v1");
    expect(result.summary.status).toBe("candidate");
    expect(result.state.intended_tag).toBe("rust-v0.2.0");
    expect(result.summary.task_seeds).toBe(1);
    expect(result.task_suggestions[0]!.fingerprint).toBe(`release-candidate:hasna/codewith:rust-v0.2.0:${headSha.slice(0, 12)}`);
    expect(result.task_suggestions[0]!.tags).toContain("auto:route");
    expect(result.task_suggestions[0]!.tags).toContain("task-lifecycle");
    expect(result.task_suggestions[0]!.metadata["publish_path"]).toBe("separate-approved-protected-release-step");
    expect(result.task_suggestions[0]!.body).toContain("Do not create or push release tags");
  });

  test("emits a release blocker task when published release state is ahead of branch state", () => {
    const repoPath = writeCargoVersion("0.1.48");
    const runner = releaseRunner({
      headSha: "7984aa35cf6f54048c36da286f7250576c27789a",
      headCommittedAt: "2026-06-26T00:00:00Z",
      latestReachableTag: "rust-v0.1.45",
      commitsSinceTag: "95",
      latestGithubRelease: "rust-v0.1.51",
      latestNpmVersion: "0.1.51",
      openPrCount: 2,
      latestReleaseAncestor: false,
      intendedTagExists: false,
      ciRuns: [{ status: "completed", conclusion: "success", workflowName: "ci" }],
    });

    const result = buildReleaseCandidates({
      repo: repoPath,
      githubRepo: "hasna/codewith",
      packageName: "@hasna/codewith",
      tagPrefix: "rust-v",
      versionFile: "codex-rs/Cargo.toml",
      fetch: false,
      runner,
    });

    expect(result.summary.status).toBe("blocked");
    expect(result.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining([
      "version-regression",
      "tag-regression",
      "latest-release-not-ancestor",
      "open-prs",
    ]));
    expect(result.task_suggestions[0]!.fingerprint).toBe("release-blocker:hasna/codewith:main:7984aa35cf6f:rust-v0.1.48");
    expect(result.task_suggestions[0]!.tags).toContain("release-blocker");
    expect(result.task_suggestions[0]!.tags).toContain("task-lifecycle");
    expect(result.task_suggestions[0]!.body).toContain("latest GitHub release rust-v0.1.51 is not an ancestor");
  });

  test("fails closed when external release state cannot be verified", () => {
    const repoPath = writeCargoVersion("0.2.0");
    const runner = releaseRunner({
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      headCommittedAt: "2026-06-26T00:00:00Z",
      latestReachableTag: "rust-v0.1.0",
      commitsSinceTag: "3",
      latestGithubRelease: "rust-v0.1.0",
      latestNpmVersion: "0.1.0",
      openPrCount: 0,
      latestReleaseAncestor: true,
      intendedTagExists: false,
      ciRuns: [{ status: "completed", conclusion: "success", workflowName: "ci" }],
      failGithubRelease: true,
      failNpm: true,
      failOpenPrs: true,
    });

    const result = buildReleaseCandidates({
      repo: repoPath,
      githubRepo: "hasna/codewith",
      packageName: "@hasna/codewith",
      tagPrefix: "rust-v",
      versionFile: "codex-rs/Cargo.toml",
      fetch: false,
      runner,
    });

    expect(result.summary.status).toBe("blocked");
    expect(result.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining([
      "github-release-check",
      "npm-registry-check",
      "open-pr-check",
    ]));
    expect(result.state.checks.github_release.ok).toBe(false);
    expect(result.state.checks.npm_package.ok).toBe(false);
    expect(result.state.checks.open_prs.ok).toBe(false);
    expect(result.task_suggestions[0]!.body).toContain("Routing metadata:");
  });

  test("infers package.json release config for standard packages", () => {
    const repoPath = writePackageJsonVersion("@hasna/repos", "0.2.0");
    const runner = releaseRunner({
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      headCommittedAt: "2026-06-26T00:00:00Z",
      latestReachableTag: "v0.1.0",
      commitsSinceTag: "4",
      latestGithubRelease: "v0.1.0",
      latestNpmVersion: "0.1.0",
      openPrCount: 0,
      latestReleaseAncestor: true,
      intendedTagExists: false,
      ciRuns: [{ status: "completed", conclusion: "success", workflowName: "ci" }],
    });

    const result = buildReleaseCandidates({
      repo: repoPath,
      githubRepo: "hasna/repos",
      fetch: false,
      runner,
    });

    expect(result.repo.package_name).toBe("@hasna/repos");
    expect(result.repo.tag_prefix).toBe("v");
    expect(result.repo.version_file).toBe("package.json");
    expect(result.state.intended_tag).toBe("v0.2.0");
    expect(result.summary.status).toBe("candidate");
  });

  test("detects docs and agent-rule drift after source changes", () => {
    const repoPath = writePackageJsonVersion("@hasna/codewith", "0.2.0");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# docs\n");
    writeFileSync(join(repoPath, "CODEWITH.md"), "rules\n");
    writeFileSync(join(repoPath, "src", "index.ts"), "export {}\n");
    const runner: CommandRunner = (command, args) => {
      if (command === "git" && args.includes("config")) return { status: 0, stdout: "https://github.com/hasna/codewith.git\n", stderr: "" };
      if (command === "git" && args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
      if (command === "git" && args.includes("log")) return { status: 0, stdout: "1111111111111111\n", stderr: "" };
      if (command === "git" && args.includes("rev-list")) return { status: 0, stdout: "2\n", stderr: "" };
      if (command === "git" && args.includes("diff")) return { status: 0, stdout: "src/index.ts\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = buildDocsRulesDrift({ repo: repoPath, fetch: false, runner });

    expect(result.schema).toBe("open-repos.docs-rules-drift.v1");
    expect(result.summary.status).toBe("drift");
    expect(result.task_suggestions[0]!.tags).toContain("docs-rules-drift");
    expect(result.task_suggestions[0]!.body).toContain("CHANGELOG/README/docs");
  });

  test("detects dependency refresh needs with Bun outdated output", () => {
    const repoPath = writePackageJsonVersion("@hasna/codewith", "0.2.0");
    const runner: CommandRunner = (command) => {
      if (command === "git") return { status: 0, stdout: "https://github.com/hasna/codewith.git\n", stderr: "" };
      if (command === "bun") return { status: 1, stdout: JSON.stringify({ react: { current: "18.0.0", latest: "19.0.0" } }), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = buildDependencyRefresh({ repo: repoPath, runner });

    expect(result.schema).toBe("open-repos.dependency-refresh.v1");
    expect(result.summary.status).toBe("needs-refresh");
    expect(result.checks.find((check) => check.id === "bun-outdated")?.count).toBe(1);
    expect(result.task_suggestions[0]!.tags).toContain("dependency-refresh");
  });

  test("detects stale dirty workspace worktrees under the configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "open-repos-worktree-root-"));
    tempDirs.push(root);
    const repoPath = join(root, "open-codewith");
    const worktreeRoot = join(root, "worktrees");
    const worktreePath = join(worktreeRoot, "open-codewith", "task-123");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const runner: CommandRunner = (command, args) => {
      if (command === "git" && args.includes("worktree")) {
        return {
          status: 0,
          stdout: [
            `worktree ${repoPath}`,
            "HEAD mainhead",
            "branch refs/heads/main",
            "",
            `worktree ${worktreePath}`,
            "HEAD taskhead",
            "branch refs/heads/openloops/task-123",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (command === "git" && args.includes("status")) return { status: 0, stdout: " M src/main.rs\n", stderr: "" };
      if (command === "git" && args.includes("show")) return { status: 0, stdout: "2026-01-01T00:00:00Z\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = buildWorkspaceWorktreeHygiene({ roots: [root], worktreeRoot, staleDays: 1, runner });

    expect(result.schema).toBe("open-repos.workspace-worktree-hygiene.v1");
    expect(result.summary.repos_checked).toBe(1);
    expect(result.summary.issue_worktrees).toBe(1);
    expect(result.worktrees[0]!.issues).toContain("dirty-worktree");
    expect(result.worktrees[0]!.task_seed?.tags).toContain("worktree-hygiene");
  });

  test("emits route health task when router latest run is stale or failed", () => {
    const runner: CommandRunner = (command, args) => {
      if (command === "loops" && args.includes("show")) return { status: 0, stdout: JSON.stringify({ status: "active" }), stderr: "" };
      if (command === "loops" && args.includes("runs")) return { status: 0, stdout: JSON.stringify([{ status: "failed", startedAt: "2026-01-01T00:00:00Z" }]), stderr: "" };
      return { status: 1, stdout: "", stderr: "bad" };
    };

    const result = buildTaskRouteHealth({ routerLoop: "machine-repo-open-codewith-task-lifecycle-router", project: "/repo", runner });

    expect(result.schema).toBe("open-repos.task-route-health.v1");
    expect(result.summary.status).toBe("issue");
    expect(result.task_suggestions[0]!.fingerprint).toContain("task-route-health");
  });

  test("emits protected release task only when release gates are candidate-ready", () => {
    const repoPath = writePackageJsonVersion("@hasna/repos", "0.2.0");
    const headSha = "abcdef1234567890abcdef1234567890abcdef12";
    const runner = releaseRunner({
      headSha,
      headCommittedAt: "2026-06-26T00:00:00Z",
      latestReachableTag: "v0.1.0",
      commitsSinceTag: "2",
      latestGithubRelease: "v0.1.0",
      latestNpmVersion: "0.1.0",
      openPrCount: 0,
      latestReleaseAncestor: true,
      intendedTagExists: false,
      ciRuns: [{ status: "completed", conclusion: "success", workflowName: "ci" }],
    });

    const result = buildProtectedRelease({ repo: repoPath, githubRepo: "hasna/repos", fetch: false, runner });

    expect(result.schema).toBe("open-repos.protected-release.v1");
    expect(result.summary.status).toBe("ready");
    expect(result.task_suggestions[0]!.tags).toContain("protected-release");
    expect(result.task_suggestions[0]!.priority).toBe("critical");
  });
});

function writeCargoVersion(version: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), "open-repos-release-test-"));
  tempDirs.push(repoPath);
  mkdirSync(join(repoPath, "codex-rs"), { recursive: true });
  writeFileSync(join(repoPath, "codex-rs", "Cargo.toml"), `[package]\nname = "codewith"\nversion = "${version}"\n`);
  return repoPath;
}

function writePackageJsonVersion(name: string, version: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), "open-repos-release-test-"));
  tempDirs.push(repoPath);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name, version }, null, 2));
  return repoPath;
}

function releaseRunner(opts: {
  headSha: string;
  headCommittedAt: string;
  latestReachableTag: string;
  commitsSinceTag: string;
  latestGithubRelease: string;
  latestNpmVersion: string;
  openPrCount: number;
  latestReleaseAncestor: boolean;
  intendedTagExists: boolean;
  ciRuns: Array<{ status: string; conclusion: string; workflowName: string }>;
  failGithubRelease?: boolean;
  failNpm?: boolean;
  failOpenPrs?: boolean;
}): CommandRunner {
  return (command, args) => {
    const text = `${command} ${args.join(" ")}`;
    if (command === "git" && args.includes("config") && args.includes("remote.origin.url")) {
      return { status: 0, stdout: "https://github.com/hasna/codewith.git\n", stderr: "" };
    }
    if (command === "git" && args.includes("rev-parse") && args.includes("origin/main")) {
      return { status: 0, stdout: `${opts.headSha}\n`, stderr: "" };
    }
    if (command === "git" && args.includes("show") && args.includes("--format=%cI")) {
      return { status: 0, stdout: `${opts.headCommittedAt}\n`, stderr: "" };
    }
    if (command === "git" && args.includes("describe")) {
      return { status: 0, stdout: `${opts.latestReachableTag}\n`, stderr: "" };
    }
    if (command === "git" && args.includes("rev-list")) {
      return { status: 0, stdout: `${opts.commitsSinceTag}\n`, stderr: "" };
    }
    if (command === "git" && args.includes("merge-base")) {
      return { status: opts.latestReleaseAncestor ? 0 : 1, stdout: "", stderr: opts.latestReleaseAncestor ? "" : "not ancestor" };
    }
    if (command === "git" && args.includes("--verify")) {
      return { status: opts.intendedTagExists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command === "gh" && args.includes("release")) {
      if (opts.failGithubRelease) return { status: 1, stdout: "", stderr: "gh auth failed" };
      return { status: 0, stdout: JSON.stringify([{ tagName: opts.latestGithubRelease }]), stderr: "" };
    }
    if (command === "gh" && args.includes("pr")) {
      if (opts.failOpenPrs) return { status: 1, stdout: "", stderr: "gh pr failed" };
      return { status: 0, stdout: JSON.stringify(Array.from({ length: opts.openPrCount }, (_, index) => ({ number: index + 1 }))), stderr: "" };
    }
    if (command === "gh" && args.includes("run")) {
      return { status: 0, stdout: JSON.stringify(opts.ciRuns), stderr: "" };
    }
    if (command === "curl") {
      if (opts.failNpm) return { status: 22, stdout: "", stderr: "404" };
      return { status: 0, stdout: JSON.stringify({ "dist-tags": { latest: opts.latestNpmVersion } }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected command: ${text}` };
  };
}
