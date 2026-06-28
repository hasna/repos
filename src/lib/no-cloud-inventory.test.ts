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
      gitRepo(included);
      gitRepo(excludedLoop);
      gitRepo(excludedCodewith);
      writeFileSync(join(included, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedLoop, "README.md"), `${cloudPackage}\n`);
      writeFileSync(join(excludedCodewith, "README.md"), `${cloudPackage}\n`);

      const report = getNoCloudInventory({ root, limit: 10 });

      expect(report.repos.map((entry) => entry.path)).toEqual(["open-secrets"]);
      expect(report.excluded.some((path) => path.includes("open-loops"))).toBe(true);
      expect(report.excluded.some((path) => path.includes("open-codewith"))).toBe(true);
      expect(report.excluded.some((path) => path.endsWith("/.git"))).toBe(false);
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
