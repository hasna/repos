import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db/database";
import { upsertRepo } from "../db/repos";
import { findFile } from "./utils";

let testDir = "";

function createTrackedRepo(name: string): string {
  const repoPath = join(testDir, name);
  mkdirSync(repoPath, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath, stdio: "pipe" });

  writeFileSync(join(repoPath, "needle.txt"), "content");
  execFileSync("git", ["add", "needle.txt"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });

  return repoPath;
}

beforeEach(() => {
  closeDb();
  testDir = join(tmpdir(), `open-repos-utils-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
});

afterEach(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  rmSync(testDir, { recursive: true, force: true });
});

describe("utils", () => {
  describe("findFile", () => {
    it("handles repo paths containing shell metacharacters without executing them", () => {
      const markerName = `utils-path-injection-marker-${process.pid}`;
      const markerPath = join(process.cwd(), markerName);
      const repoPath = createTrackedRepo(`quoted"; touch ${markerName}; #`);
      upsertRepo({ path: repoPath, name: "quoted-repo" });

      try {
        const results = findFile("needle");
        expect(results).toEqual([
          {
            repo_name: "quoted-repo",
            repo_path: repoPath,
            matches: ["needle.txt"],
          },
        ]);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        rmSync(markerPath, { force: true });
      }
    });

    it("handles filenames containing shell metacharacters without executing them", () => {
      const markerName = `utils-filename-injection-marker-${process.pid}`;
      const markerPath = join(process.cwd(), markerName);
      const repoPath = createTrackedRepo("plain-repo");
      upsertRepo({ path: repoPath, name: "plain-repo" });

      try {
        const results = findFile(`needle"; touch ${markerName}; #`);
        expect(results).toEqual([]);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        rmSync(markerPath, { force: true });
      }
    });
  });
});
