import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNoCloudInventory } from "./no-cloud-inventory";

function withTempWorkspace(fn: (root: string) => void) {
  const root = join(tmpdir(), `repos-no-cloud-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function gitRepo(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init"], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: path, stdio: "pipe" });
  writeFileSync(join(path, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: path, stdio: "pipe" });
}

function commitAll(path: string, message: string) {
  execFileSync("git", ["add", "."], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: path, stdio: "pipe" });
}

function setTrackedGitHubRemote(path: string, remote: string) {
  execFileSync("git", ["branch", "-M", "main"], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: path, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf-8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: path, stdio: "pipe" });
  execFileSync("git", ["branch", "--set-upstream-to=origin/main", "main"], { cwd: path, stdio: "pipe" });
}

const cloudPackage = "@hasna" + "/cloud";
const cloudTools = ["register", "Cloud", "Tools"].join("");
const cloudMcp = ["cloud", "mcp"].join("-");
const cloudEnv = ["HASNA", "CLOUD", "MODE"].join("_");

describe("no-cloud inventory", () => {
  it("counts package, lock, source, docs, and config cloud references", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "open-repos");
      gitRepo(repo);
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, "infra"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        dependencies: { [cloudPackage]: "0.1.41" },
      }));
      writeFileSync(join(repo, "bun.lock"), `${cloudPackage}\n`);
      writeFileSync(join(repo, "src", "index.ts"), `${cloudTools}();\n`);
      writeFileSync(join(repo, "README.md"), `uses ${cloudMcp}\n`);
      writeFileSync(join(repo, "infra", "config.json"), JSON.stringify({ env: cloudEnv }) + "\n");

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "open-repos");

      expect(report.summary.repos).toBe(1);
      expect(report.summary.needs_remediation).toBe(1);
      expect(finding).toMatchObject({
        files: 5,
        package: 1,
        lock: 1,
        source: 1,
        docs: 1,
        config: 2,
        status: "needs-remediation",
      });
    });
  });

  it("excludes open-loops and codewith paths from mutation routing inventories", () => {
    withTempWorkspace((root) => {
      const included = join(root, "open-secrets");
      const excludedLoop = join(root, "open-loops");
      const excludedCodewith = join(root, "open-codewith");
      const excludedCodewithDuplicate = join(root, "open-secrets-codewith-improve");
      const excludedCodewithWorktree = join(root, "open-knowledge", ".codewith-worktrees", "compact-cli-output");
      gitRepo(included);
      gitRepo(excludedLoop);
      gitRepo(excludedCodewith);
      gitRepo(excludedCodewithDuplicate);
      gitRepo(excludedCodewithWorktree);
      writeFileSync(join(included, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedLoop, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedCodewith, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedCodewithDuplicate, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedCodewithWorktree, "README.md"), `${cloudPackage}\n`);

      const report = getNoCloudInventory({ root, limit: 10 });

      expect(report.repos.map((entry) => entry.path)).toEqual(["open-secrets"]);
      expect(report.excluded.some((path) => path.includes("open-loops"))).toBe(true);
      expect(report.excluded.some((path) => path.includes("open-codewith"))).toBe(true);
      expect(report.excluded.some((path) => path.includes("open-secrets-codewith-improve"))).toBe(true);
      expect(report.excluded.some((path) => path.includes(".codewith-worktrees"))).toBe(true);
      expect(report.excluded.some((path) => path.endsWith("/.git"))).toBe(false);
    });
  });

  it("marks duplicate remote checkouts as non-routeable with a canonical path", () => {
    withTempWorkspace((root) => {
      const canonical = join(root, "open-repos");
      const duplicate = join(root, "open-repos-compact-cli");
      gitRepo(canonical);
      gitRepo(duplicate);
      for (const repo of [canonical, duplicate]) {
        writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
        commitAll(repo, "add cloud evidence");
        setTrackedGitHubRemote(repo, "https://github.com/hasna/repos.git");
      }

      const report = getNoCloudInventory({ root, limit: 10 });
      const canonicalFinding = report.repos.find((entry) => entry.path === "open-repos");
      const duplicateFinding = report.repos.find((entry) => entry.path === "open-repos-compact-cli");

      expect(canonicalFinding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: true,
        route_blocked_reason: null,
        canonical_path: "open-repos",
        duplicate_of: null,
      });
      expect(duplicateFinding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "duplicate",
        routeable: false,
        route_blocked_reason: "duplicate-checkout",
        canonical_path: "open-repos",
        duplicate_of: "open-repos",
      });
      expect(report.summary.duplicate_repos).toBe(1);
    });
  });

  it("keeps the shared cloud package visible but not routeable before the final tombstone gate", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "open-cloud");
      gitRepo(repo);
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
      commitAll(repo, "add cloud evidence");
      setTrackedGitHubRemote(repo, "https://github.com/hasna/cloud.git");

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "open-cloud");

      expect(finding).toMatchObject({
        repo_key: "hasna/cloud",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "cloud-package-final-tombstone-gated",
      });
    });
  });

  it("blocks no-touch repos by GitHub remote identity even when the local path is renamed", () => {
    withTempWorkspace((root) => {
      const loopCopy = join(root, "loops-copy");
      const codewithCopy = join(root, "cw-copy");
      gitRepo(loopCopy);
      gitRepo(codewithCopy);
      writeFileSync(join(loopCopy, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(codewithCopy, "README.md"), `${cloudPackage}\n`);
      commitAll(loopCopy, "add cloud evidence");
      commitAll(codewithCopy, "add cloud evidence");
      setTrackedGitHubRemote(loopCopy, "https://github.com/hasna/loops.git");
      setTrackedGitHubRemote(codewithCopy, "git@github.com:hasna/codewith.git");

      const report = getNoCloudInventory({ root, limit: 10 });

      expect(report.repos.find((entry) => entry.path === "loops-copy")).toMatchObject({
        repo_key: "hasna/loops",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "no-touch-repo",
      });
      expect(report.repos.find((entry) => entry.path === "cw-copy")).toMatchObject({
        repo_key: "hasna/codewith",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "no-touch-repo",
      });
    });
  });

  it("blocks auxiliary canonical candidates instead of routing the least-bad checkout", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "opensourcedev", "open-repos");
      gitRepo(repo);
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
      commitAll(repo, "add cloud evidence");
      setTrackedGitHubRemote(repo, "https://github.com/hasna/repos.git");

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "opensourcedev/open-repos");
      const reportFromOpenSourceDev = getNoCloudInventory({ root: join(root, "opensourcedev"), limit: 10 });
      const findingFromOpenSourceDev = reportFromOpenSourceDev.repos.find((entry) => entry.path === "open-repos");

      expect(finding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "auxiliary-opensourcedev-checkout",
      });
      expect(findingFromOpenSourceDev).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "auxiliary-opensourcedev-checkout",
      });
    });
  });

  it("blocks canonical candidates that are behind their known upstream", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "open-repos");
      gitRepo(repo);
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
      commitAll(repo, "add cloud evidence");
      setTrackedGitHubRemote(repo, "https://github.com/hasna/repos.git");
      writeFileSync(join(repo, "CHANGELOG.md"), "new remote-only commit\n");
      commitAll(repo, "remote-only change");
      const remoteHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", remoteHead], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: repo, stdio: "pipe" });

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "open-repos");

      expect(finding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "behind-upstream",
        ahead: 0,
        behind: 1,
      });
    });
  });

  it("requires canonical candidates to track origin main, not another upstream", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "open-repos");
      gitRepo(repo);
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
      commitAll(repo, "add cloud evidence");
      setTrackedGitHubRemote(repo, "https://github.com/hasna/repos.git");
      execFileSync("git", ["remote", "add", "fork", "https://github.com/someone/repos.git"], { cwd: repo, stdio: "pipe" });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      execFileSync("git", ["update-ref", "refs/remotes/fork/main", head], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["branch", "--set-upstream-to=fork/main", "main"], { cwd: repo, stdio: "pipe" });

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "open-repos");

      expect(finding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "non-origin-main-upstream",
        upstream: "fork/main",
      });
    });
  });

  it("blocks external GitHub repos from Hasna remediation routing", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "BrowserOS");
      gitRepo(repo);
      setTrackedGitHubRemote(repo, "https://github.com/browseros-ai/BrowserOS.git");

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "BrowserOS");

      expect(finding).toMatchObject({
        repo_key: "browseros-ai/browseros",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "outside-managed-org",
        status: "verify-clean",
      });
    });
  });

  it("blocks dirty canonical checkouts from remediation routing", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "open-repos");
      gitRepo(repo);
      setTrackedGitHubRemote(repo, "https://github.com/hasna/repos.git");
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "open-repos");

      expect(finding).toMatchObject({
        repo_key: "hasna/repos",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "dirty-worktree",
        dirty: 1,
      });
    });
  });

  it("does not count nested git repository files in the parent repository", () => {
    withTempWorkspace((root) => {
      const parent = join(root, "parent");
      const child = join(parent, "packages", "child");
      gitRepo(parent);
      gitRepo(child);
      writeFileSync(join(parent, "README.md"), "parent is clean\n");
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);

      const report = getNoCloudInventory({ root, limit: 10, maxDepth: 4 });
      const parentFinding = report.repos.find((entry) => entry.path === "parent");
      const childFinding = report.repos.find((entry) => entry.path === "parent/packages/child");

      expect(parentFinding).toMatchObject({ files: 0, status: "verify-clean" });
      expect(childFinding).toMatchObject({ files: 1, status: "needs-remediation" });
    });
  });

  it("blocks nested git checkouts from remediation routing even when they are otherwise clean", () => {
    withTempWorkspace((root) => {
      const parent = join(root, "open-brains");
      const child = join(parent, "brains");
      gitRepo(parent);
      gitRepo(child);
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);
      commitAll(child, "add cloud evidence");
      setTrackedGitHubRemote(child, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root, limit: 10, maxDepth: 4 });
      const childFinding = report.repos.find((entry) => entry.path === "open-brains/brains");

      expect(childFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "nested-git-checkout",
        canonical_path: "open-brains/brains",
      });
      expect(report.summary.routeable).toBe(0);
    });
  });

  it("does not promote a clean nested duplicate over a top-level checkout", () => {
    withTempWorkspace((root) => {
      const parent = join(root, "open-brains");
      const child = join(parent, "brains");
      gitRepo(parent);
      writeFileSync(join(parent, "README.md"), `${cloudPackage}\n`);
      commitAll(parent, "add cloud evidence");
      setTrackedGitHubRemote(parent, "https://github.com/hasna/brains.git");
      gitRepo(child);
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);
      commitAll(child, "add cloud evidence");
      setTrackedGitHubRemote(child, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root, limit: 10, maxDepth: 4 });
      const parentFinding = report.repos.find((entry) => entry.path === "open-brains");
      const childFinding = report.repos.find((entry) => entry.path === "open-brains/brains");

      expect(parentFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "dirty-worktree",
        canonical_path: "open-brains",
      });
      expect(childFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "duplicate",
        routeable: false,
        route_blocked_reason: "duplicate-checkout",
        canonical_path: "open-brains",
        duplicate_of: "open-brains",
      });
    });
  });

  it("does not skip large lockfiles that contain cloud references", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "large-lock");
      gitRepo(repo);
      writeFileSync(join(repo, "bun.lock"), `${"x".repeat(1024 * 1024 + 1)}\n${cloudPackage}\n`);

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "large-lock");

      expect(finding).toMatchObject({ files: 1, lock: 1, status: "needs-remediation" });
    });
  });

  it("redacts credential-bearing remotes across URL schemes", () => {
    withTempWorkspace((root) => {
      const repo = join(root, "secret-remote");
      gitRepo(repo);
      execFileSync("git", ["remote", "add", "origin", "ssh://user:super-secret@git.example.com/hasna/repo.git"], {
        cwd: repo,
        stdio: "pipe",
      });

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === "secret-remote");

      expect(finding?.remote).toBe("ssh://***@git.example.com/hasna/repo.git");
      expect(finding?.remote).not.toContain("super-secret");
    });
  });
});
