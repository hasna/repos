import { afterEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestRepo(workspaceRoot: string, name: string): string {
  const repoPath = join(workspaceRoot, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  writeFileSync(join(repoPath, "README.md"), "# auto bootstrap");
  execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
  return repoPath;
}

let tempDir = "";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startConnectionProbe(root: string): { port: number; logPath: string; stop: () => void } {
  const scriptPath = join(root, "connection-probe.mjs");
  const portPath = join(root, "connection-probe.port");
  const logPath = join(root, "connection-probe.log");
  writeFileSync(logPath, "");
  writeFileSync(scriptPath, `
    import { createServer } from "node:net";
    import { appendFileSync, writeFileSync } from "node:fs";
    const portPath = process.argv[2];
    const logPath = process.argv[3];
    const server = createServer((socket) => {
      appendFileSync(logPath, "connection\\n");
      socket.destroy();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") process.exit(1);
      writeFileSync(portPath, String(address.port));
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    setInterval(() => {}, 1000);
  `);

  const proc = Bun.spawn(["bun", scriptPath, portPath, logPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(portPath)) {
      const port = Number.parseInt(readFileSync(portPath, "utf-8"), 10);
      if (Number.isFinite(port)) {
        return { port, logPath, stop: () => proc.kill() };
      }
    }
    sleepSync(20);
  }
  proc.kill();
  throw new Error("connection probe did not start");
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("cli auto bootstrap", () => {
  it("indexes the workspace on first read command", () => {
    tempDir = mkdtempSync(join(tmpdir(), "open-repos-cli-"));
    const homeDir = join(tempDir, "home");
    const workspaceRoot = join(homeDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const repoPath = createTestRepo(workspaceRoot, "workspace-repo");

    const env = {
      ...process.env,
      HOME: homeDir,
      HASNA_REPOS_DB_PATH: join(tempDir, "repos.db"),
      HASNA_REPOS_CONFIG_PATH: join(tempDir, "config.json"),
      HASNA_REPOS_HOOK_QUEUE_PATH: join(tempDir, "hook-events.tsv"),
    };

    const output = execSync("bun run src/cli/index.tsx repos --json", {
      cwd: join(import.meta.dir, "../.."),
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const repos = JSON.parse(output) as Array<{ name: string }>;
    const hookContent = readFileSync(join(repoPath, ".git", "hooks", "post-commit"), "utf-8");

    expect(repos.some((repo) => repo.name === "workspace-repo")).toBe(true);
    expect(hookContent).toContain("hasna repos auto-index");
  });

  it("stays local for implicit bootstrap even when remote database env is present", () => {
    tempDir = mkdtempSync(join(tmpdir(), "open-repos-cli-remote-"));
    const homeDir = join(tempDir, "home");
    const workspaceRoot = join(homeDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    createTestRepo(workspaceRoot, "workspace-repo");
    const probe = startConnectionProbe(tempDir);

    const env = {
      ...process.env,
      HOME: homeDir,
      HASNA_REPOS_DB_PATH: join(tempDir, "repos.db"),
      HASNA_REPOS_CONFIG_PATH: join(tempDir, "config.json"),
      HASNA_REPOS_HOOK_QUEUE_PATH: join(tempDir, "hook-events.tsv"),
      HASNA_REPOS_DATABASE_URL: `postgres://repos@127.0.0.1:${probe.port}/repos`,
      HASNA_REPOS_DATABASE_SSL: "0",
    };

    let stdout = "";
    try {
      stdout = execSync("bun run src/cli/index.tsx repos --json", {
        cwd: join(import.meta.dir, "../.."),
        env,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
    } finally {
      probe.stop();
    }

    const repos = JSON.parse(stdout) as Array<{ name: string }>;
    expect(repos.some((repo) => repo.name === "workspace-repo")).toBe(true);
    expect(readFileSync(probe.logPath, "utf-8")).toBe("");
  });
});
