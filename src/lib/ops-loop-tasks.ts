import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskSeed } from "./ops-producers.js";

export interface TodosCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type TodosRunner = (args: string[], opts: { timeoutMs: number }) => TodosCommandResult;

export interface UpsertTaskSeedsOptions {
  project: string;
  taskList: string;
  taskListName: string;
  taskListDescription: string;
  maxActions?: number;
  timeoutMs?: number;
  runner?: TodosRunner;
}

export interface UpsertTaskSeedsResult {
  schema: "open-repos.loop-task-upsert.v1";
  generated_at: string;
  project: string;
  task_list: string;
  summary: {
    seeds: number;
    attempted: number;
    created: number;
    existing: number;
    skipped: number;
    errors: number;
  };
  actions: Array<{
    action: "created" | "exists" | "skipped" | "error";
    fingerprint: string;
    title: string;
    task_id?: string;
    reason?: string;
    error?: string;
  }>;
  errors: string[];
}

const TERMINAL_STATUSES = new Set(["done", "completed", "cancelled", "canceled", "failed", "archived"]);

export function upsertTaskSeeds(seeds: TaskSeed[], options: UpsertTaskSeedsOptions): UpsertTaskSeedsResult {
  const runner = options.runner ?? runTodos;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 15_000);
  const maxActions = normalizePositiveInteger(options.maxActions, 20);
  const result: UpsertTaskSeedsResult = {
    schema: "open-repos.loop-task-upsert.v1",
    generated_at: new Date().toISOString(),
    project: options.project,
    task_list: options.taskList,
    summary: {
      seeds: seeds.length,
      attempted: 0,
      created: 0,
      existing: 0,
      skipped: 0,
      errors: 0,
    },
    actions: [],
    errors: [],
  };

  const ensure = ensureTaskList(options, runner, timeoutMs);
  if (!ensure.ok) {
    result.errors.push(ensure.error);
    result.summary.errors = 1;
    return result;
  }

  const seen = new Set<string>();
  for (const seed of seeds) {
    if (result.summary.attempted >= maxActions) {
      result.summary.skipped += 1;
      result.actions.push({
        action: "skipped",
        fingerprint: seed.fingerprint,
        title: seed.title,
        reason: `max-actions ${maxActions} reached`,
      });
      continue;
    }
    if (seen.has(seed.fingerprint)) {
      result.summary.skipped += 1;
      result.actions.push({
        action: "skipped",
        fingerprint: seed.fingerprint,
        title: seed.title,
        reason: "duplicate fingerprint in this run",
      });
      continue;
    }
    seen.add(seed.fingerprint);
    result.summary.attempted += 1;

    const existing = findExistingTask(options, seed.fingerprint, runner, timeoutMs);
    if (existing.error) {
      result.summary.errors += 1;
      result.errors.push(existing.error);
      result.actions.push({
        action: "error",
        fingerprint: seed.fingerprint,
        title: seed.title,
        error: existing.error,
      });
      continue;
    }
    if (existing.task && !TERMINAL_STATUSES.has(String(existing.task.status ?? ""))) {
      result.summary.existing += 1;
      result.actions.push({
        action: "exists",
        fingerprint: seed.fingerprint,
        title: seed.title,
        task_id: String(existing.task.id ?? ""),
      });
      continue;
    }

    const added = addTaskSeed(options, seed, runner, timeoutMs);
    if (added.error) {
      result.summary.errors += 1;
      result.errors.push(added.error);
      result.actions.push({
        action: "error",
        fingerprint: seed.fingerprint,
        title: seed.title,
        error: added.error,
      });
      continue;
    }

    result.summary.created += 1;
    result.actions.push({
      action: "created",
      fingerprint: seed.fingerprint,
      title: seed.title,
      task_id: String(added.task?.id ?? ""),
    });
  }

  return result;
}

export function writeLoopReport(report: unknown, options: { reportDir?: string; prefix: string }): string | undefined {
  if (!options.reportDir) return undefined;
  mkdirSync(options.reportDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(options.reportDir, `${options.prefix}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function ensureTaskList(
  options: UpsertTaskSeedsOptions,
  runner: TodosRunner,
  timeoutMs: number,
): { ok: true } | { ok: false; error: string } {
  const existing = runner(["--project", options.project, "task-lists"], { timeoutMs });
  if (existing.status === 0 && existing.stdout.includes(options.taskList)) return { ok: true };

  const created = runner([
    "--project",
    options.project,
    "task-lists",
    "--add",
    options.taskListName,
    "--slug",
    options.taskList,
    "-d",
    options.taskListDescription,
  ], { timeoutMs });
  if (created.status === 0) return { ok: true };
  return { ok: false, error: compactError(created, `failed to ensure task list ${options.taskList}`) };
}

function findExistingTask(
  options: UpsertTaskSeedsOptions,
  fingerprint: string,
  runner: TodosRunner,
  timeoutMs: number,
): { task?: Record<string, unknown>; error?: string } {
  const result = runner([
    "--project",
    options.project,
    "-j",
    "search",
    fingerprint,
    "--task-list",
    options.taskList,
    "--limit",
    "10",
  ], { timeoutMs });
  if (result.status !== 0) return { error: compactError(result, `failed to search task ${fingerprint}`) };
  try {
    const parsed = JSON.parse(result.stdout || "[]") as unknown;
    if (Array.isArray(parsed)) return { task: parsed[0] as Record<string, unknown> | undefined };
    return {};
  } catch (error) {
    return { error: `failed to parse todos search JSON for ${fingerprint}: ${(error as Error).message}` };
  }
}

function addTaskSeed(
  options: UpsertTaskSeedsOptions,
  seed: TaskSeed,
  runner: TodosRunner,
  timeoutMs: number,
): { task?: Record<string, unknown>; error?: string } {
  const body = seed.body.includes(seed.fingerprint)
    ? seed.body
    : `Fingerprint: ${seed.fingerprint}\n${seed.body}`;
  const result = runner([
    "--project",
    options.project,
    "-j",
    "add",
    seed.title,
    "-d",
    body,
    "--priority",
    seed.priority,
    "--task-list",
    options.taskList,
    "--tags",
    Array.from(new Set(seed.tags)).join(","),
    "--reason",
    `Deterministic OpenRepos ops producer generated ${seed.fingerprint}.`,
  ], { timeoutMs });
  if (result.status !== 0) return { error: compactError(result, `failed to add task ${seed.fingerprint}`) };
  try {
    return { task: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
  } catch (error) {
    return { error: `failed to parse todos add JSON for ${seed.fingerprint}: ${(error as Error).message}` };
  }
}

function runTodos(args: string[], opts: { timeoutMs: number }): TodosCommandResult {
  const result = spawnSync("todos", args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: (result.error as Error).message } : {}),
  };
}

function compactError(result: TodosCommandResult, fallback: string): string {
  const message = result.stderr || result.error || result.stdout || fallback;
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
