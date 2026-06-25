import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HASNA_REPOS_AUTO_BOOTSTRAP: "0",
      ...env,
    },
  });
}

describe("repos storage CLI", () => {
  test("help advertises storage sync without legacy remote alias", () => {
    const result = runCli(["--help"]);
    const out = new TextDecoder().decode(result.stdout);
    const legacyRemoteAlias = ["clo", "ud"].join("");

    expect(result.exitCode).toBe(0);
    expect(out).toContain("storage");
    expect(out).not.toContain(legacyRemoteAlias);
  });

  test("storage status reports local mode as JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "open-repos-storage-cli-"));
    try {
      const result = runCli(["storage", "status", "--json"], {
        HOME: home,
        HASNA_REPOS_DB_PATH: join(home, "repos.db"),
        HASNA_REPOS_DATABASE_URL: "",
        REPOS_DATABASE_URL: "",
        HASNA_REPOS_STORAGE_MODE: "",
        REPOS_STORAGE_MODE: "",
      });
      const out = new TextDecoder().decode(result.stdout);

      expect(result.exitCode).toBe(0);
      const status = JSON.parse(out) as { mode: string; enabled: boolean; tables: Array<{ table: string; rows: number }> };
      expect(status.mode).toBe("local");
      expect(status.enabled).toBe(false);
      expect(status.tables.some((table) => table.table === "repos")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
