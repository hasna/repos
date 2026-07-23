import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["run", "src/cli/index.tsx", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HASNA_REPOS_DB_PATH: ":memory:",
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      ...env,
    },
  });
}

describe("task worktree CLI contract", () => {
  it("discovers capabilities as a machine-readable success", () => {
    const result = cli(
      ["worktrees", "capabilities"],
      { HASNA_REPOS_DB_PATH: "/proc/repos-capability-probe-must-not-open.db" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "repos.task-worktrees.capabilities.v1",
      capability: "repos.task-worktrees.v1",
      available: true,
      fallback: {
        allowed_when: "capability_absent",
        forbidden_when: "capability_failed",
      },
    });
  });

  it("reports an operational failure distinctly from an absent command", () => {
    const failed = cli([
      "worktrees",
      "status",
      "--lease-id",
      "missing",
      "--repo",
      "hasna/repos",
      "--branch",
      "feat/missing",
    ]);
    expect(failed.status).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      schema: "repos.task-worktrees.error.v1",
      capability: "repos.task-worktrees.v1",
      available: true,
      ok: false,
      error: { code: "LEASE_NOT_FOUND" },
    });

    const absent = cli(["worktrees-not-installed", "capabilities"]);
    expect(absent.status).toBe(1);
    expect(absent.stdout).toBe("");
    expect(absent.stderr).toContain("unknown command");
  });
});
