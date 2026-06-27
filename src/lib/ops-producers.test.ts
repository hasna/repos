import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDb } from "../db/database.js";
import { bulkInsertPullRequests, upsertRepo } from "../db/repos.js";
import {
  buildPrQueue,
  inspectPackageHygiene,
  runGlobalCliSmoke,
  type CommandRunner,
} from "./ops-producers.js";

beforeEach(() => {
  closeDb();
  process.env["HASNA_REPOS_DB_PATH"] = ":memory:";
  getDb(":memory:");
});

afterAll(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
});

describe("ops producers", () => {
  test("builds normalized PR queue items with task seeds", () => {
    const repo = upsertRepo({
      path: "/workspace/open-loops",
      name: "open-loops",
      org: "hasna",
      remote_url: "git@github.com:hasna/loops.git",
    });
    bulkInsertPullRequests([
      {
        repo_id: repo.id,
        number: 12,
        title: "Fix loop routing",
        state: "open",
        author: "andrei-hasna",
        created_at: "2026-06-27T00:00:00Z",
        updated_at: "2026-06-27T01:00:00Z",
        merged_at: null,
        closed_at: null,
        url: "https://github.com/hasna/loops/pull/12",
        base_branch: "main",
        head_branch: "fix/routing",
        additions: 10,
        deletions: 2,
        changed_files: 3,
      },
    ]);

    const result = buildPrQueue({ org: "hasna" });

    expect(result.schema).toBe("open-repos.pr-queue.v1");
    expect(result.summary.items).toBe(1);
    expect(result.items[0]!.repo.full_name).toBe("hasna/loops");
    expect(result.items[0]!.task_seed.fingerprint).toBe("github-pr:hasna/loops#12");
    expect(result.items[0]!.task_seed.tags).toContain("auto:route");
  });

  test("keeps large PR queue JSON stable with escaped task seed content", () => {
    const repo = upsertRepo({
      path: "/workspace/open-repos",
      name: "open-repos",
      org: "hasna",
      remote_url: "https://github.com/hasna/repos.git",
    });
    const oddTitle = "Fix \"quoted\" PR queue\nwith tab\tand bell \u0007";
    bulkInsertPullRequests(Array.from({ length: 505 }, (_, index) => ({
      repo_id: repo.id,
      number: index + 1,
      title: `${oddTitle} #${index + 1}`,
      state: "open" as const,
      author: "andrei-hasna",
      created_at: "2026-06-27T00:00:00Z",
      updated_at: `2026-06-27T01:${String(index % 60).padStart(2, "0")}:00Z`,
      merged_at: null,
      closed_at: null,
      url: `https://github.com/hasna/repos/pull/${index + 1}`,
      base_branch: "main",
      head_branch: `fix/pr-queue-${index + 1}`,
      additions: index,
      deletions: 1,
      changed_files: 2,
    })));

    const result = buildPrQueue({ org: "hasna", limit: 500 });
    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json) as typeof result;

    expect(parsed.schema).toBe("open-repos.pr-queue.v1");
    expect(parsed.summary.items).toBe(500);
    expect(parsed.items).toHaveLength(500);
    expect(parsed.items[0]!.pr.title).toContain('"quoted"');
    expect(parsed.items[0]!.pr.title).toContain("\n");
    expect(parsed.items[0]!.task_seed.title).toContain('"quoted"');
    expect(parsed.items[0]!.task_seed.body).toContain("https://github.com/hasna/repos/pull/");
  });

  test("smokes CLIs with an injectable bounded runner", () => {
    const runner: CommandRunner = (command) => command === "missing"
      ? { status: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "not found" } }
      : { status: 0, stdout: "ok\n", stderr: "" };

    const result = runGlobalCliSmoke({ commands: ["repos", "missing"], runner });

    expect(result.summary.checked).toBe(2);
    expect(result.summary.ok).toBe(1);
    expect(result.summary.missing).toBe(1);
    expect(result.commands.find((row) => row.command === "missing")?.task_seed?.fingerprint).toBe("cli-smoke:missing");
  });

  test("detects Hasna packages duplicated in npm global installs", () => {
    const runner: CommandRunner = (command) => {
      if (command === "bun") {
        return { status: 0, stdout: "@hasna/loops@0.3.21\n@hasna/repos@0.1.16\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          dependencies: {
            "@hasna/loops": { version: "0.3.19" },
            "typescript": { version: "5.8.2" },
          },
        }),
        stderr: "",
      };
    };

    const result = inspectPackageHygiene({ scopes: ["@hasna"], runner });

    expect(result.summary.bun_packages_seen).toBe(2);
    expect(result.summary.scoped_npm_duplicates).toBe(1);
    expect(result.task_seeds[0]!.fingerprint).toBe("package-hygiene:npm-global-duplicate:@hasna/loops");
  });
});
