import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function runImport(args: string[]) {
  tempDir ||= mkdtempSync(join(tmpdir(), "repos-cli-worktrees-"));
  return Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      "src/cli/index.tsx",
      "worktrees",
      "import",
      "--repo",
      "hasna/repos",
      "--task-id",
      "task-cli-import",
      "--run-id",
      "run-cli-import",
      "--branch",
      "task/cli-import",
      "--path",
      join(tempDir, "worktrees", "candidate"),
      "--root",
      join(tempDir, "worktrees"),
      "--json",
      ...args,
    ],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      HASNA_REPOS_DB_PATH: join(tempDir, "repos.db"),
      HASNA_MACHINE_ID: "machine-cli",
      HASNA_AGENT_ID: "agent-cli",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("worktree CLI validation", () => {
  it("rejects a blank required import identity before filesystem inspection", () => {
    const result = runImport(["--task-id", " \t "]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      action: "import",
      code: "missing_required_key",
    });
  });

  it("rejects a blank import path before resolving it", () => {
    const result = runImport(["--path", " \t "]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      action: "import",
      code: "missing_required_path",
    });
  });
});
