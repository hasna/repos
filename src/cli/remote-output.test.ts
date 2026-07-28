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
      // The fixture path does not exist, so `repo` refuses it with a non-zero
      // exit. Opt out of the failure — the subject here is redaction.
      ["repo", "remoteoutput", "--json", "--allow-unusable-checkout"],
      ["search", "remoteoutput", "--json"],
      ["export", "--json"],
    ]) {
      const result = runCli(dbPath, args);
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain("git.example.test/team/tool");
      expect(output).not.toContain(unsafe);
      expect(output).not.toContain("phrase");
      // stderr is a new output boundary: the unusable-checkout refusal quotes the
      // row's remote back at the caller to name a clone command, so it is exactly
      // the kind of message that leaks an embedded credential if it uses the raw
      // stored value instead of the sanitized one.
      const errors = result.stderr.toString();
      expect(errors).not.toContain(unsafe);
      expect(errors).not.toContain("phrase");
    }
  });

  it("does not leak an embedded credential through the unusable-checkout refusal", () => {
    tempDir = mkdtempSync(join(tmpdir(), "repos-cli-refusal-output-"));
    const dbPath = join(tempDir, "repos.db");
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const db = getDb(dbPath);
    db.query("INSERT INTO repos (path, name, remote_url) VALUES (?, 'refusalrepo', ?)")
      .run(join(tempDir, "absent-checkout"), unsafe);
    closeDb();

    const result = runCli(dbPath, ["repo", "refusalrepo", "--json"]);
    expect(result.exitCode).toBe(1);
    const errors = result.stderr.toString();
    expect(errors).toContain("missing-path");
    expect(errors).toContain("git.example.test/team/tool");
    expect(errors).not.toContain(unsafe);
    expect(errors).not.toContain("phrase");
  });
});
