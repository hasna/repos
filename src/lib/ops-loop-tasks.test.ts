import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertTaskSeeds, writeLoopReport, type TodosRunner } from "./ops-loop-tasks.js";
import type { TaskSeed } from "./ops-producers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loop task helpers", () => {
  test("upserts task seeds through the todos CLI contract with bounded duplicate handling", () => {
    const calls: string[][] = [];
    const tasks: Array<{ id: string; status: string; description: string }> = [];
    const runner: TodosRunner = (args) => {
      calls.push(args);
      if (args.includes("task-lists") && !args.includes("--add")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("task-lists") && args.includes("--add")) return { status: 0, stdout: "created", stderr: "" };
      if (args.includes("search")) {
        const fingerprint = args[args.indexOf("search") + 1]!;
        return {
          status: 0,
          stdout: JSON.stringify(tasks.filter((task) => task.description.includes(fingerprint))),
          stderr: "",
        };
      }
      if (args.includes("task") && args.includes("upsert")) {
        const description = args[args.indexOf("--description") + 1]!;
        const task = { id: `task-${tasks.length + 1}`, status: "pending", description };
        tasks.push(task);
        return { status: 0, stdout: JSON.stringify({ task, created: true }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    };
    const seed = makeSeed("github-pr:hasna/repos#1");

    const result = upsertTaskSeeds([seed, seed], {
      project: "/home/hasna/.hasna/loops",
      taskList: "repo-pr-merge-queue",
      taskListName: "Repo PR Merge Queue",
      taskListDescription: "PR work",
      maxActions: 5,
      runner,
    });

    expect(result.summary.created).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.errors).toBe(0);
    expect(tasks[0]!.description).toContain("Fingerprint: github-pr:hasna/repos#1");
    const upsertCall = calls.find((args) => args.includes("task") && args.includes("upsert"));
    expect(upsertCall).toContain("--fingerprint");
    expect(upsertCall).toContain("github-pr:hasna/repos#1");
    expect(upsertCall).toContain("--metadata-json");
    expect(JSON.parse(upsertCall![upsertCall!.indexOf("--metadata-json") + 1]!)).toEqual({
      source: "test",
      fingerprint: "github-pr:hasna/repos#1",
    });
    expect(upsertCall).toContain("--working-dir");
    expect(upsertCall![upsertCall!.indexOf("--working-dir") + 1]).toBe("/home/hasna/.hasna/loops");
    expect(calls.some((args) => args.includes("task-lists") && args.includes("--add"))).toBe(true);
  });

  test("does not recreate non-terminal existing tasks", () => {
    const calls: string[][] = [];
    const existing = { id: "task-existing", status: "in_progress" };
    const runner: TodosRunner = (args) => {
      calls.push(args);
      if (args.includes("task-lists")) return { status: 0, stdout: "global-cli-smoke", stderr: "" };
      if (args.includes("search")) return { status: 0, stdout: JSON.stringify([existing]), stderr: "" };
      if (args.includes("task") && args.includes("upsert")) return { status: 0, stdout: JSON.stringify({ task: { id: "should-not-upsert" }, created: true }), stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    };

    const result = upsertTaskSeeds([makeSeed("cli-smoke:opencode")], {
      project: "/home/hasna/.hasna/loops",
      taskList: "global-cli-smoke",
      taskListName: "Global CLI Smoke",
      taskListDescription: "CLI smoke",
      runner,
    });

    expect(result.summary.existing).toBe(1);
    expect(result.actions[0]).toMatchObject({ action: "exists", task_id: "task-existing" });
    expect(calls.some((args) => args.includes("task") && args.includes("upsert"))).toBe(false);
  });

  test("does not starve new tasks behind existing active tasks", () => {
    const added: string[] = [];
    const runner: TodosRunner = (args) => {
      if (args.includes("task-lists")) return { status: 0, stdout: "repo-pr-merge-queue", stderr: "" };
      if (args.includes("search")) {
        const fingerprint = args[args.indexOf("search") + 1]!;
        if (fingerprint === "github-pr:hasna/repos#1") {
          return { status: 0, stdout: JSON.stringify([{ id: "existing-1", status: "pending" }]), stderr: "" };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (args.includes("task") && args.includes("upsert")) {
        const title = args[args.indexOf("--title") + 1]!;
        added.push(title);
        return { status: 0, stdout: JSON.stringify({ task: { id: "created-1", status: "pending" }, created: true }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };

    const result = upsertTaskSeeds([
      makeSeed("github-pr:hasna/repos#1"),
      makeSeed("github-pr:hasna/repos#2"),
    ], {
      project: "/home/hasna/.hasna/loops",
      taskList: "repo-pr-merge-queue",
      taskListName: "Repo PR Merge Queue",
      taskListDescription: "PR work",
      maxActions: 1,
      runner,
    });

    expect(result.summary.existing).toBe(1);
    expect(result.summary.created).toBe(1);
    expect(added).toHaveLength(1);
    expect(result.actions.map((action) => action.action)).toEqual(["exists", "created"]);
  });

  test("uses an active duplicate even when a terminal search hit appears first", () => {
    const runner: TodosRunner = (args) => {
      if (args.includes("task-lists")) return { status: 0, stdout: "global-cli-smoke", stderr: "" };
      if (args.includes("search")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "terminal", status: "done" },
            { id: "active", status: "in_progress" },
          ]),
          stderr: "",
        };
      }
      if (args.includes("task") && args.includes("upsert")) return { status: 0, stdout: JSON.stringify({ task: { id: "should-not-upsert" }, created: true }), stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    };

    const result = upsertTaskSeeds([makeSeed("cli-smoke:opencode")], {
      project: "/home/hasna/.hasna/loops",
      taskList: "global-cli-smoke",
      taskListName: "Global CLI Smoke",
      taskListDescription: "CLI smoke",
      runner,
    });

    expect(result.summary.existing).toBe(1);
    expect(result.actions[0]).toMatchObject({ action: "exists", task_id: "active" });
  });

  test("reports task upsert reuse when the todos metadata fingerprint already exists", () => {
    const runner: TodosRunner = (args) => {
      if (args.includes("task-lists")) return { status: 0, stdout: "repo-pr-merge-queue", stderr: "" };
      if (args.includes("search")) return { status: 0, stdout: "[]", stderr: "" };
      if (args.includes("task") && args.includes("upsert")) {
        return {
          status: 0,
          stdout: JSON.stringify({ task: { id: "existing-metadata", status: "done" }, created: false }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };

    const result = upsertTaskSeeds([makeSeed("github-pr:hasna/repos#1")], {
      project: "/home/hasna/.hasna/loops",
      taskList: "repo-pr-merge-queue",
      taskListName: "Repo PR Merge Queue",
      taskListDescription: "PR work",
      runner,
    });

    expect(result.summary.created).toBe(0);
    expect(result.summary.existing).toBe(1);
    expect(result.actions[0]).toMatchObject({
      action: "exists",
      task_id: "existing-metadata",
      reason: "upsert reused existing metadata fingerprint",
    });
  });

  test("writes loop report JSON with private file permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-repos-loop-report-"));
    tempDirs.push(dir);

    const path = writeLoopReport({ ok: true }, { reportDir: dir, prefix: "smoke" });

    expect(path).toBeTruthy();
    expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual({ ok: true });
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });

  test("can annotate loop report JSON with its own report path", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-repos-loop-report-"));
    tempDirs.push(dir);

    const path = writeLoopReport({ ok: true, loop: {} }, { reportDir: dir, prefix: "smoke", annotatePath: true });
    const parsed = JSON.parse(readFileSync(path!, "utf8")) as { loop: { report_path: string } };

    expect(parsed.loop.report_path).toBe(path);
  });
});

function makeSeed(fingerprint: string): TaskSeed {
  return {
    fingerprint,
    title: `Fix ${fingerprint}`,
    body: "Do the routed work safely.",
    priority: "high",
    tags: ["auto:route", "area:repoops"],
    metadata: { source: "test" },
  };
}
