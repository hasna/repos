import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database.js";

let tempDir = "";

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function runCli(dbPath: string, args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      HASNA_REPOS_DB_PATH: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI remote output boundary", () => {
  it("sanitizes list, detail, search, and export JSON", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-cli-remote-output-"));
    const dbPath = join(tempDir, "repos.db");
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const db = getDb(dbPath);
    db.query("INSERT INTO repos (path, name, remote_url) VALUES (?, 'remoteoutput', ?)")
      .run(join(tempDir, "repo"), unsafe);
    closeDb();

    for (const args of [
      ["repos", "--json"],
      ["repo", "remoteoutput", "--json"],
      ["search", "remoteoutput", "--json"],
      ["export", "--json"],
    ]) {
      const result = runCli(dbPath, args);
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain("git.example.test/team/tool");
      expect(output).not.toContain(unsafe);
      expect(output).not.toContain("phrase");
    }
  });
});
