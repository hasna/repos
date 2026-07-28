import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyNpmViewFailure,
  deriveLocalPackageNames,
  getNoCloudInventory,
  resolveNpmPackageChecks,
} from "./no-cloud-inventory";

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
const cloudRepoName = ["open", "cloud"].join("-");

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
      const repo = join(root, cloudRepoName);
      gitRepo(repo);
      writeFileSync(join(repo, "README.md"), `${cloudPackage}\n`);
      commitAll(repo, "add cloud evidence");
      setTrackedGitHubRemote(repo, "https://github.com/hasna/cloud.git");

      const report = getNoCloudInventory({ root, limit: 10 });
      const finding = report.repos.find((entry) => entry.path === cloudRepoName);

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

  it("blocks a nested git checkout even when the inventory root is the nested checkout itself", () => {
    withTempWorkspace((root) => {
      const parent = join(root, "open-brains");
      const child = join(parent, "brains");
      gitRepo(parent);
      gitRepo(child);
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);
      commitAll(child, "add cloud evidence");
      setTrackedGitHubRemote(child, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root: child, limit: 10 });
      const childFinding = report.repos.find((entry) => entry.path === child);

      expect(childFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "nested-git-checkout",
        canonical_path: child,
      });
      expect(report.summary.routeable).toBe(0);
    });
  });

  it("does not promote clean auxiliary or nested duplicates over a heavily penalized top-level checkout", () => {
    withTempWorkspace((root) => {
      const parent = join(root, "open-brains");
      const auxiliary = join(root, "open-brains-compact-cli");
      const child = join(parent, "brains");
      gitRepo(parent);
      writeFileSync(join(parent, "README.md"), `${cloudPackage}\n`);
      commitAll(parent, "add cloud evidence");
      setTrackedGitHubRemote(parent, "https://github.com/hasna/brains.git");
      writeFileSync(join(parent, "CHANGELOG.md"), "new remote-only commit\n");
      commitAll(parent, "remote-only change");
      const remoteHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf-8" }).trim();
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", remoteHead], { cwd: parent, stdio: "pipe" });
      execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: parent, stdio: "pipe" });
      writeFileSync(join(parent, "README.md"), `${cloudPackage}\nlocal dirty change\n`);
      gitRepo(auxiliary);
      writeFileSync(join(auxiliary, "README.md"), `${cloudPackage}\n`);
      commitAll(auxiliary, "add cloud evidence");
      setTrackedGitHubRemote(auxiliary, "https://github.com/hasna/brains.git");
      gitRepo(child);
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);
      commitAll(child, "add cloud evidence");
      setTrackedGitHubRemote(child, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root, limit: 10, maxDepth: 4 });
      const parentFinding = report.repos.find((entry) => entry.path === "open-brains");
      const auxiliaryFinding = report.repos.find((entry) => entry.path === "open-brains-compact-cli");
      const childFinding = report.repos.find((entry) => entry.path === "open-brains/brains");

      expect(parentFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "dirty-worktree",
        canonical_path: "open-brains",
        behind: 1,
      });
      expect(parentFinding?.dirty).toBeGreaterThan(0);
      expect(auxiliaryFinding).toMatchObject({
        repo_key: "hasna/brains",
        routing: "duplicate",
        routeable: false,
        route_blocked_reason: "duplicate-checkout",
        canonical_path: "open-brains",
        duplicate_of: "open-brains",
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

  it("treats repo names that already start with open as expected top-level checkouts", () => {
    withTempWorkspace((root) => {
      const expected = join(root, "hasna", "opensource", "open-chrome");
      const duplicate = join(root, "hasnaxyz", "project", "open-chrome");
      gitRepo(expected);
      writeFileSync(join(expected, "README.md"), `${cloudPackage}\n`);
      commitAll(expected, "add cloud evidence");
      setTrackedGitHubRemote(expected, "https://github.com/hasnaxyz/open-chrome.git");
      writeFileSync(join(expected, "README.md"), `${cloudPackage}\nlocal dirty change\n`);
      gitRepo(duplicate);
      writeFileSync(join(duplicate, "README.md"), `${cloudPackage}\n`);
      commitAll(duplicate, "add cloud evidence");
      setTrackedGitHubRemote(duplicate, "https://github.com/hasnaxyz/open-chrome.git");

      const report = getNoCloudInventory({ root, limit: 10, maxDepth: 4 });
      const expectedFinding = report.repos.find((entry) => entry.path === "hasna/opensource/open-chrome");
      const duplicateFinding = report.repos.find((entry) => entry.path === "hasnaxyz/project/open-chrome");

      expect(expectedFinding).toMatchObject({
        repo_key: "hasnaxyz/open-chrome",
        routing: "canonical",
        routeable: false,
        route_blocked_reason: "dirty-worktree",
        canonical_path: "hasna/opensource/open-chrome",
      });
      expect(duplicateFinding).toMatchObject({
        repo_key: "hasnaxyz/open-chrome",
        routing: "duplicate",
        routeable: false,
        route_blocked_reason: "duplicate-checkout",
        canonical_path: "hasna/opensource/open-chrome",
        duplicate_of: "hasna/opensource/open-chrome",
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

      expect(finding?.remote).toBe("git.example.com/hasna/repo");
      expect(finding?.remote).not.toContain("super-secret");
    });
  });
});

describe("registry inventory sources", () => {
  const cloudPkg = "@hasna" + "/cloud";
  const walletsPkg = "@hasna" + "/wallets";
  const reposPkg = "@hasna" + "/repos";
  const localOnlyPkg = "@hasna" + "/localonly";

  function manifest(root: string, dir: string, name: string) {
    const path = join(root, dir);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
    return path;
  }

  it("unions local manifests with the registry rather than substituting for them", () => {
    // THE REGRESSION THIS PINS: deriving the list from local manifests only sees
    // packages that have one. iapp-wallets has no package.json, so
    // @hasna/wallets@0.1.10 — which actively declares the retired @hasna/cloud —
    // silently stopped being checked. Fifteen published packages dropped out that
    // way. The registry side has to ADD to the derived set, never replace it.
    withTempWorkspace((root) => {
      manifest(root, "open-localonly", localOnlyPkg);
      const inventory = resolveNpmPackageChecks([join(root, "open-localonly")], {
        enumerate: () => ({ status: "ok", names: [walletsPkg, reposPkg], detail: null }),
      });
      expect(inventory.packages).toContain(localOnlyPkg);
      expect(inventory.packages).toContain(walletsPkg);
      expect(inventory.packages).toContain(reposPkg);
      expect(inventory.from_local_manifests).toBe(1);
      expect(inventory.from_registry).toBe(2);
      expect(inventory.registry_enumeration).toBe("ok");
    });
  });

  it("keeps @hasna/cloud even though the registry enumeration cannot see it", () => {
    // Measured against live npmjs on 2026-07-28: `npm search @hasna` returns 160
    // scoped packages and @hasna/cloud is NOT among them, because npm search omits
    // deprecated packages and @hasna/cloud@0.1.41 is deprecated. That deprecation
    // is the exact fact this report exists to surface, so no source may drop it.
    const inventory = resolveNpmPackageChecks([], {
      enumerate: () => ({ status: "ok", names: [reposPkg], detail: null }),
    });
    expect(inventory.packages).toContain(cloudPkg);
  });

  it("keeps @hasna/cloud when both sources are empty", () => {
    const inventory = resolveNpmPackageChecks([], {
      enumerate: () => ({ status: "ok", names: [], detail: null }),
    });
    expect(inventory.packages).toEqual([cloudPkg]);
  });

  it("reports a failed enumeration instead of quietly narrowing coverage", () => {
    // Absorbing the failure would return the local manifests and look exactly like
    // a successful enumeration of a workspace with nothing published — the same
    // silent-narrowing failure the union exists to prevent.
    withTempWorkspace((root) => {
      manifest(root, "open-localonly", localOnlyPkg);
      const inventory = resolveNpmPackageChecks([join(root, "open-localonly")], {
        enumerate: () => ({ status: "failed", names: [], detail: "network unreachable" }),
      });
      expect(inventory.registry_enumeration).toBe("failed");
      expect(inventory.from_registry).toBeNull();
      expect(inventory.registry_enumeration_detail).toBe("network unreachable");
      // Coverage is still the union of what it could see, not nothing.
      expect(inventory.packages).toContain(localOnlyPkg);
      expect(inventory.packages).toContain(cloudPkg);
    });
  });

  it("de-duplicates a name declared by two checkouts and by the registry", () => {
    withTempWorkspace((root) => {
      const a = manifest(root, "open-repos", reposPkg);
      const b = manifest(root, "repos-worktree", reposPkg);
      const inventory = resolveNpmPackageChecks([a, b], {
        enumerate: () => ({ status: "ok", names: [reposPkg], detail: null }),
      });
      expect(inventory.packages.filter((name) => name === reposPkg).length).toBe(1);
    });
  });

  it("ignores manifests that are missing, unparseable, unnamed, or foreign-scoped", () => {
    withTempWorkspace((root) => {
      const noManifest = join(root, "no-manifest");
      mkdirSync(noManifest, { recursive: true });
      const broken = join(root, "broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, "package.json"), "{ not json");
      const unnamed = join(root, "unnamed");
      mkdirSync(unnamed, { recursive: true });
      writeFileSync(join(unnamed, "package.json"), JSON.stringify({ version: "1.0.0" }));
      const foreign = manifest(root, "foreign", "@other/thing");

      expect(deriveLocalPackageNames([noManifest, broken, unnamed, foreign])).toEqual([]);
    });
  });

  it("does not treat a scope-prefixed name from another scope as in-scope", () => {
    // `@hasnafoo/x` starts with the scope string but is a different scope. A
    // startsWith check without the slash would accept it.
    withTempWorkspace((root) => {
      const impostor = manifest(root, "impostor", "@hasnafoo/x");
      expect(deriveLocalPackageNames([impostor])).toEqual([]);
    });
  });

  it("classifies a registry 404 as unpublished and anything else as a failure", () => {
    // An absent package and a broken npm client both exit non-zero. Collapsing
    // them is how a retired package reads as a transient blip.
    expect(classifyNpmViewFailure("npm error code E404\nnpm error 404 Not Found")).toBe("unpublished");
    expect(classifyNpmViewFailure("404 Not Found - GET https://registry.npmjs.org/@hasna%2fgone")).toBe("unpublished");
    expect(classifyNpmViewFailure("npm error network ETIMEDOUT")).toBe("npm-view-failed");
    expect(classifyNpmViewFailure("")).toBe("npm-view-failed");
  });

  it("uses an explicit --npm-package list verbatim without enumerating", () => {
    withTempWorkspace((root) => {
      let enumerated = false;
      const report = getNoCloudInventory({
        root,
        includeNpm: true,
        npmPackages: ["@hasna/nonexistent-fixture-package"],
        enumerateScopedPackages: () => { enumerated = true; return { status: "ok", names: [], detail: null }; },
      });
      expect(enumerated).toBe(false);
      expect(report.summary.registry_enumeration).toBe("skipped");
      expect(report.npm.map((entry) => entry.package)).toEqual(["@hasna/nonexistent-fixture-package"]);
    });
  });

  it("reports registry_enumeration skipped when --include-npm is absent", () => {
    withTempWorkspace((root) => {
      const report = getNoCloudInventory({ root, limit: 10 });
      expect(report.summary.registry_enumeration).toBe("skipped");
      expect(report.summary.registry_packages).toBe(0);
      expect(report.summary.registry_from_registry).toBeNull();
      expect(report.schema_version).toBe("1.3");
    });
  });
});

describe("enclosing-repository detection", () => {
  it("does not treat a directory with an invalid .git as an enclosing repository", () => {
    // `existsSync(dir + "/.git")` accepted anything holding a `.git` entry. A bare
    // empty `/tmp/.git` on the host was therefore the "parent" of every fixture
    // created under TMPDIR, which made 7 tests in this file fail on an untouched
    // main and get mistaken for a broken baseline. In production it means a stray
    // `.git` anywhere above a workspace marks every checkout below it
    // non-routeable, with canonical_path decided from a repo that does not exist.
    withTempWorkspace((root) => {
      const outer = join(root, "outer");
      mkdirSync(join(outer, ".git"), { recursive: true });
      const inner = join(outer, "open-brains");
      gitRepo(inner);
      writeFileSync(join(inner, "README.md"), `${cloudPackage}\n`);
      commitAll(inner, "add cloud evidence");
      setTrackedGitHubRemote(inner, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root: inner, limit: 10 });
      const finding = report.repos.find((entry) => entry.repo_key === "hasna/brains");
      expect(finding?.route_blocked_reason).toBeNull();
      expect(finding?.routeable).toBe(true);
    });
  });

  it("still treats a real enclosing checkout as a nested-git-checkout block", () => {
    // The control for the test above: the fix must not be achievable by simply
    // never reporting a nested parent. A genuine parent repository still blocks,
    // and it still blocks when the scan root IS the nested checkout — otherwise a
    // nested repo could be laundered into a routeable one by pointing the scan
    // at it.
    withTempWorkspace((root) => {
      const parent = join(root, "open-brains");
      const child = join(parent, "brains");
      gitRepo(parent);
      gitRepo(child);
      writeFileSync(join(child, "README.md"), `${cloudPackage}\n`);
      commitAll(child, "add cloud evidence");
      setTrackedGitHubRemote(child, "https://github.com/hasna/brains.git");

      const report = getNoCloudInventory({ root: child, limit: 10 });
      const finding = report.repos.find((entry) => entry.repo_key === "hasna/brains");
      expect(finding?.route_blocked_reason).toBe("nested-git-checkout");
      expect(finding?.routeable).toBe(false);
    });
  });
});
