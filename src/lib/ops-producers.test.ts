import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { closeDb, getDb } from "../db/database.js";
import { bulkInsertPullRequests, upsertRepo } from "../db/repos.js";
import {
  buildDependencyRefresh,
  buildDocsRulesDrift,
  buildPrQueue,
  buildProtectedRelease,
  buildReleaseCandidates,
  buildReleasePipelineParity,
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
    expect(result.items[0]!.task_seed.body).toContain("GitHub author is andrei-hasna");
    expect(result.items[0]!.task_seed.metadata["github_author"]).toBe("andrei-hasna");
    // pr_author + pr_state must be seeded into metadata so the open-loops
    // freshness gate / bot-login fast path avoids a per-task live `gh pr view`.
    expect(result.items[0]!.task_seed.metadata["pr_author"]).toBe("andrei-hasna");
    expect(result.items[0]!.task_seed.metadata["pr_state"]).toBe("open");
    expect(result.task_suggestions[0]!.fingerprint).toBe("github-pr:hasna/loops#12");
    expect(result.task_suggestions[0]!.metadata["github_author"]).toBe("andrei-hasna");
  });

  test("emits one queue item per pull request, not one per local checkout", () => {
    // The pr-queue producer is what automation consumes. It used to JOIN
    // pull_requests to repos with no de-duplication, so a repository checked
    // out N times produced N copies of every PR and `limit` was spent entirely
    // on duplicates — on the live index a 50-item queue held 2 distinct PRs.
    const paths = [
      "/workspace/open-codewith",
      "/home/u/.hasna/repos/worktrees/codewith/a",
      "/home/u/.hasna/repos/worktrees/codewith/b",
    ];
    for (const path of paths) {
      const repo = upsertRepo({
        path,
        name: basename(path),
        org: "hasna",
        remote_url: "git@github.com:hasna/codewith.git",
      });
      bulkInsertPullRequests([{
        repo_id: repo.id,
        number: 424,
        title: "Enforce reserved namespace boundary",
        state: "open",
        author: "andrei-hasna",
        created_at: "2026-07-26T00:00:00Z",
        updated_at: "2026-07-26T01:00:00Z",
        merged_at: null,
        closed_at: null,
        url: "https://github.com/hasna/codewith/pull/424",
        base_branch: "main",
        head_branch: "fix/ns",
        additions: 1,
        deletions: 0,
        changed_files: 1,
      }]);
    }

    const result = buildPrQueue({ org: "hasna" });

    expect(result.summary.items).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.repo.full_name).toBe("hasna/codewith");
    expect(result.task_suggestions).toHaveLength(1);
    // The surviving copy must be the primary clone. The seed body's
    // `Repository: <path>` line routes an agent to this directory, and a
    // worktree belongs to some other task — operating rule 8.
    expect(result.items[0]!.repo.path).toBe("/workspace/open-codewith");
    expect(result.items[0]!.repo.path).not.toContain("/worktrees/");
    expect(result.items[0]!.task_seed.body).toContain("/workspace/open-codewith");
  });

  test("names the repository that owns the PR, not the checkout it was recorded against", () => {
    // The full_name becomes the task fingerprint. Taking it from the winning
    // repo record rather than the pull request makes tasks collide or route to
    // the wrong repository.
    const repo = upsertRepo({
      path: "/workspace/platform-aicopilot",
      name: "platform-aicopilot",
      org: "hasnatools",
      remote_url: "git@github.com:hasnatools/platform-aicopilot.git",
    });
    bulkInsertPullRequests([{
      repo_id: repo.id,
      number: 9,
      title: "Mis-attributed",
      state: "open",
      author: "andrei-hasna",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      merged_at: null,
      closed_at: null,
      url: "https://github.com/hasna/aicopilot/pull/9",
      base_branch: "main",
      head_branch: "fix/x",
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }]);

    const item = buildPrQueue({ org: "hasna" }).items[0]!;
    expect(item.repo.full_name).toBe("hasna/aicopilot");
    expect(item.task_seed.fingerprint).toBe("github-pr:hasna/aicopilot#9");
    expect(item.repo.org).toBe("hasna");
  });

  test("scopes the queue by the org that owns the PR, not the repo record's org", () => {
    // A PR recorded against an unrelated checkout must still be queued under
    // the org that actually owns it.
    const repo = upsertRepo({
      path: "/workspace/platform-aicopilot",
      name: "platform-aicopilot",
      org: "hasnatools",
      remote_url: "git@github.com:hasnatools/platform-aicopilot.git",
    });
    bulkInsertPullRequests([{
      repo_id: repo.id,
      number: 9,
      title: "Mis-attributed pull request",
      state: "open",
      author: "andrei-hasna",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      merged_at: null,
      closed_at: null,
      url: "https://github.com/hasna/aicopilot/pull/9",
      base_branch: "main",
      head_branch: "fix/x",
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }]);

    expect(buildPrQueue({ org: "hasna" }).summary.items).toBe(1);
    expect(buildPrQueue({ org: "hasnatools" }).summary.items).toBe(0);
  });

  test("an unresolvable --repo filter matches nothing rather than everything", () => {
    const repo = upsertRepo({
      path: "/workspace/open-loops-scope",
      name: "open-loops-scope",
      org: "hasna",
      remote_url: "git@github.com:hasna/loops.git",
    });
    bulkInsertPullRequests([{
      repo_id: repo.id,
      number: 1,
      title: "Something",
      state: "open",
      author: "andrei-hasna",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      merged_at: null,
      closed_at: null,
      url: "https://github.com/hasna/loops/pull/1",
      base_branch: "main",
      head_branch: "x",
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }]);

    expect(buildPrQueue({ repo: "no-such-repo-anywhere" }).summary.items).toBe(0);
    expect(buildPrQueue({ repo: "open-loops-scope" }).summary.items).toBe(1);
  });

  test("seed body State/Author lines are gate-parseable (cross-package contract with open-loops)", () => {
    // CONTRACT TEST — guards against "seed-body cross-package format drift"
    // (review-repos-pr11 BLOCK finding; tracked as task 21261ad4): a presence
    // assertion (`toContain`) passed CI while the gate could not PARSE the
    // line. These regexes are copied VERBATIM from @hasna/loops 0.4.11
    // open-loops src/lib/route/pr-review.ts — authorFromPrText (:278-290)
    // and the prStateFromEvidence text fallback (:191). The todos CLI drops
    // task_seed.metadata, so the persisted todos task description is the ONLY
    // channel the gate can read; if open-loops changes these patterns, this
    // test must be updated in lockstep (and vice versa).
    const AUTHOR_FROM_PR_TEXT_PATTERNS = [
      /\bauthor\s+(?:is\s+also|is|=|:)\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/i,
      /\bPR\s*#?\d+\s+author\s+(?:is\s+also|is|=|:)\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/i,
      /\bgithub\s+author\s+(?:is\s+also|is|=|:)\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/i,
    ];
    const PR_STATE_TEXT_PATTERN =
      /\b(?:pr[_\s-]?state|pull[_\s-]?request[_\s-]?state|state)\s*[:=]\s*(MERGED|CLOSED|OPEN)\b/i;

    const repo = upsertRepo({
      path: "/workspace/open-loops-contract",
      name: "open-loops-contract",
      org: "hasna",
      remote_url: "git@github.com:hasna/loops-contract.git",
    });
    bulkInsertPullRequests([
      {
        repo_id: repo.id,
        number: 77,
        title: "Contract probe PR",
        state: "open",
        author: "andrei-hasna",
        created_at: "2026-07-05T00:00:00Z",
        updated_at: "2026-07-05T01:00:00Z",
        merged_at: null,
        closed_at: null,
        url: "https://github.com/hasna/loops-contract/pull/77",
        base_branch: "main",
        head_branch: "probe/contract",
        additions: 1,
        deletions: 1,
        changed_files: 1,
      },
    ]);

    const body = buildPrQueue({ org: "hasna", repo: "open-loops-contract" }).items[0]!.task_seed.body;

    // Author fast path: at least one gate pattern must EXTRACT the login.
    const authorMatch = AUTHOR_FROM_PR_TEXT_PATTERNS
      .map((pattern) => pattern.exec(body)?.[1])
      .find((login) => Boolean(login));
    expect(authorMatch).toBe("andrei-hasna");

    // State fast path: the gate pattern must extract + normalize the state.
    const stateMatch = PR_STATE_TEXT_PATTERN.exec(body)?.[1]?.toUpperCase();
    expect(stateMatch).toBe("OPEN");

    // Regression pin for the exact BLOCK finding: a bare `Author: <login>`
    // line (no whitespace before the separator) must NOT be what we emit —
    // the gate patterns require `\bauthor\s+` before the separator.
    expect(body).not.toMatch(/^Author:\s/m);
    expect(body).toMatch(/^Author is andrei-hasna$/m);
    expect(body).toMatch(/^State: open$/m);
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

  test("release pipeline parity flags repos without the standard workflow pair", () => {
    const compliant = mkdtempSync(join(tmpdir(), "open-repos-parity-ok-"));
    const missing = mkdtempSync(join(tmpdir(), "open-repos-parity-gap-"));
    tempDirs.push(compliant, missing);
    for (const dir of [compliant, missing]) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@hasna/${basename(dir)}`, version: "1.0.0" }));
    }
    mkdirSync(join(compliant, ".github", "workflows"), { recursive: true });
    writeFileSync(join(compliant, ".github", "workflows", "ci.yml"), "on:\n  push:\n    branches: [main]\njobs: {}\n");
    writeFileSync(join(compliant, ".github", "workflows", "publish.yml"), "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n");

    const result = buildReleasePipelineParity({ paths: [compliant, missing], includeRegistry: false });

    expect(result.schema).toBe("open-repos.release-pipeline-parity.v1");
    expect(result.summary).toMatchObject({ repos: 2, flagged: 1, task_seeds: 1 });
    const seed = result.task_suggestions[0]!;
    expect(seed.fingerprint).toBe(`release-pipeline-parity:${basename(missing)}`);
    expect(seed.tags).toContain("release-pipeline-parity");
    expect(seed.priority).toBe("medium");
    expect((seed.metadata["issue_codes"] as string[])).toContain("ci_workflow_missing");
    const okItem = result.items.find((item) => item.issue_codes.length === 0)!;
    expect(okItem.task_seed).toBeUndefined();
    expect(okItem.workflows.standard_pair).toBe(true);
  });

  test("release pipeline parity emits high priority seeds for npm tag drift", () => {
    const repo = mkdtempSync(join(tmpdir(), "open-repos-parity-drift-"));
    tempDirs.push(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@hasna/parity-drift", version: "1.0.0" }));
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on:\n  push:\n    branches: [main]\njobs: {}\n");
    writeFileSync(join(repo, ".github", "workflows", "publish.yml"), "on:\n  push:\n    tags: [\"v*\"]\njobs: {}\n");
    execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo, stdio: "pipe" });

    const result = buildReleasePipelineParity({
      paths: [repo],
      runner: () => ({ ok: true, stdout: "2.0.0", stderr: "", exitCode: 0 }),
    });

    expect(result.summary.flagged).toBe(1);
    const seed = result.task_suggestions[0]!;
    expect(seed.priority).toBe("high");
    expect((seed.metadata["issue_codes"] as string[])).toContain("npm_latest_without_git_tag");
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
