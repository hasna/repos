import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../db/database.js";
import {
  TASK_WORKTREE_CAPABILITY,
  TASK_WORKTREE_ERROR_SCHEMA,
  TASK_WORKTREE_RECEIPT_SCHEMA,
  TaskWorktreeError,
  TaskWorktreeService,
  type CreateOrAdoptTaskWorktreeOptions,
  type TaskWorktreeErrorCode,
  type TaskWorktreeGitAdapter,
  type TaskWorktreeGitState,
} from "./task-worktrees.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

class FakeGit implements TaskWorktreeGitAdapter {
  readonly states = new Map<string, TaskWorktreeGitState>();
  readonly provider = new Map<string, string>();
  prState: "open" | "closed" | "merged" | "absent" | "unreachable" = "absent";
  providerFailure = false;
  dirtyAfterInspectCount: number | null = null;
  beforeCreate: (() => void) | null = null;
  private readonly inspectCounts = new Map<string, number>();
  createCount = 0;
  cleanupCount = 0;

  create(input: {
    repository: string;
    branch: string;
    baseBranch: string;
    target: string;
  }): TaskWorktreeGitState {
    if (this.providerHead(input.repository, input.branch)) {
      throw new TaskWorktreeError("BRANCH_COLLISION", "provider branch already exists");
    }
    this.beforeCreate?.();
    this.createCount += 1;
    mkdirSync(input.target, { recursive: true });
    const state: TaskWorktreeGitState = {
      root: realpathSync(input.target),
      repository: input.repository,
      branch: input.branch,
      head: HEAD,
      clean: true,
      upstream: null,
      upstreamHead: null,
    };
    this.states.set(input.target, state);
    return state;
  }

  inspect(path: string): TaskWorktreeGitState {
    const state = this.states.get(path);
    if (!state) throw new Error("missing fake git state");
    const count = (this.inspectCounts.get(path) ?? 0) + 1;
    this.inspectCounts.set(path, count);
    return {
      ...state,
      ...(this.dirtyAfterInspectCount != null && count > this.dirtyAfterInspectCount
        ? { clean: false }
        : {}),
    };
  }

  providerHead(repository: string, branch: string): string | null {
    if (this.providerFailure) {
      throw new TaskWorktreeError("PROVIDER_UNREACHABLE", "provider branch lookup failed");
    }
    return this.provider.get(`${repository}:${branch}`) ?? null;
  }

  pullRequestState(): "open" | "closed" | "merged" | "absent" | "unreachable" {
    return this.prState;
  }

  cleanup(path: string): void {
    this.cleanupCount += 1;
    this.states.delete(path);
    rmSync(path, { recursive: true, force: false });
  }

  update(path: string, patch: Partial<TaskWorktreeGitState>): void {
    const current = this.states.get(path);
    if (!current) throw new Error("missing fake git state");
    this.states.set(path, { ...current, ...patch });
  }
}

function expectCode(fn: () => unknown, code: TaskWorktreeErrorCode): TaskWorktreeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskWorktreeError);
    expect((error as TaskWorktreeError).code).toBe(code);
    return error as TaskWorktreeError;
  }
  throw new Error(`expected ${code}`);
}

describe("task worktree lifecycle", () => {
  let db: Database;
  let temp: string;
  let root: string;
  let now: Date;
  let git: FakeGit;
  let service: TaskWorktreeService;
  let base: CreateOrAdoptTaskWorktreeOptions;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrateDb(db);
    db.query(`INSERT INTO repos
      (path, name, org, remote_url, default_branch, created_at, updated_at)
      VALUES (?, 'repos', 'hasna', 'github.com/hasna/repos', 'main', datetime('now'), datetime('now'))`)
      .run("/registered/repos");
    temp = mkdtempSync(join(tmpdir(), "repos-task-worktrees-"));
    root = join(temp, "worktrees");
    now = new Date("2026-07-23T12:00:00.000Z");
    git = new FakeGit();
    service = new TaskWorktreeService({
      db,
      root,
      now: () => new Date(now),
      machineId: () => "machine-a",
      git,
    });
    base = {
      repository: "hasna/repos",
      taskId: "task-1",
      taskWorktreeName: "task-one",
      branch: "feat/task-one",
      machineId: "machine-a",
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      prGroup: "pr-group-1",
      leaf: "leaf-1",
      ttlSeconds: 30,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  });

  it("advertises capability absence separately from operational failure", () => {
    const capabilities = service.capabilities();
    expect(capabilities).toMatchObject({
      capability: TASK_WORKTREE_CAPABILITY,
      available: true,
      fallback: {
        allowed_when: "capability_absent",
        forbidden_when: "capability_failed",
      },
    });
    const error = expectCode(
      () => service.status({ leaseId: "missing" }),
      "LEASE_NOT_FOUND",
    );
    expect(error.toJSON()).toEqual({
      schema: TASK_WORKTREE_ERROR_SCHEMA,
      capability: TASK_WORKTREE_CAPABILITY,
      available: true,
      ok: false,
      error: {
        code: "LEASE_NOT_FOUND",
        message: "task worktree lease was not found",
      },
    });
  });

  it("creates once and idempotently adopts the same full identity", () => {
    const created = service.createOrAdopt(base);
    const adopted = service.createOrAdopt(base);
    expect(created.schema).toBe(TASK_WORKTREE_RECEIPT_SCHEMA);
    expect(created.outcome).toBe("created");
    expect(adopted.outcome).toBe("adopted");
    expect(adopted.lease).toMatchObject({
      repository: "hasna/repos",
      task_id: "task-1",
      pr_group: "pr-group-1",
      leaf: "leaf-1",
      branch: "feat/task-one",
      machine_id: "machine-a",
      writer_generation: "generation-1",
      attempt: "attempt-1",
      status: "active",
    });
    expect(git.createCount).toBe(1);
    expect(db.query("SELECT count(*) AS count FROM task_worktree_leases").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM task_worktree_receipts").get()).toEqual({ count: 3 });
  });

  it("requires explicit recovery after expiry instead of renewing through create-or-adopt", () => {
    const created = service.createOrAdopt(base);
    const originalExpiry = created.lease!.lease_expires_at;
    now = new Date(now.getTime() + 31_000);

    const stale = expectCode(
      () => service.createOrAdopt(base),
      "STALE_WRITER",
    );
    expect(stale.receipt).toMatchObject({
      ok: false,
      operation: "create_or_adopt",
      outcome: "collision",
      lease: {
        writer_generation: "generation-1",
        lease_expires_at: originalExpiry,
      },
    });
    expect(git.createCount).toBe(1);
  });

  it("never reactivates a retired writer generation through ABA transfer or recovery", () => {
    const created = service.createOrAdopt(base);
    service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
      ttlSeconds: 30,
    });

    expectCode(() => service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-2",
      attempt: "attempt-2",
      machineId: "machine-b",
      newWriterGeneration: "generation-1",
      newAttempt: "attempt-1",
      newMachineId: "machine-a",
      ttlSeconds: 30,
    }), "STALE_WRITER");

    now = new Date(now.getTime() + 31_000);
    expectCode(() => service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "generation-2",
      observedAttempt: "attempt-2",
      newWriterGeneration: "generation-1",
      newAttempt: "attempt-replay",
      newMachineId: "machine-c",
      ttlSeconds: 30,
    }), "STALE_WRITER");
    expect(db.query(
      "SELECT writer_generation FROM task_worktree_leases WHERE lease_id = ?",
    ).get(created.lease!.lease_id)).toEqual({ writer_generation: "generation-2" });
  });

  it("rejects contradictory cleanup policy and preserves an advanced unmerged head", () => {
    const created = service.createOrAdopt({
      ...base,
      cleanupPolicy: { pullRequest: "merged" },
    });

    const collision = expectCode(
      () => service.createOrAdopt({
        ...base,
        cleanupPolicy: { pullRequest: "none" },
      }),
      "WORKTREE_COLLISION",
    );
    expect(collision.receipt).toMatchObject({
      ok: false,
      operation: "create_or_adopt",
      outcome: "collision",
    });

    const path = created.lease!.worktree_path;
    git.update(path, {
      head: OTHER_HEAD,
      clean: true,
      upstream: "origin/feat/task-one",
      upstreamHead: OTHER_HEAD,
    });
    git.provider.set("hasna/repos:feat/task-one", OTHER_HEAD);
    git.prState = "open";
    const blocked = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    });
    expect(blocked).toMatchObject({
      ok: false,
      outcome: "blocked",
      lease: { status: "cleanup_blocked" },
    });
    expect(blocked.gates).toContainEqual(expect.objectContaining({
      id: "pull_request_policy",
      passed: false,
    }));
    expect(git.cleanupCount).toBe(0);
  });

  it("fails closed when lease-id selectors contradict the authoritative binding", () => {
    const created = service.createOrAdopt(base);
    const leaseId = created.lease!.lease_id;
    const contradictions = [
      { taskId: "task-other" },
      { worktreePath: join(root, "repos", "task-other") },
      { repository: "hasna/other" },
      { branch: "feat/other" },
    ];

    for (const selector of contradictions) {
      expectCode(
        () => service.status({ leaseId, ...selector }),
        "INVALID_REQUEST",
      );
    }
  });

  it("rolls back provisioning before filesystem mutation when receipt persistence fails", () => {
    db.exec(`
      CREATE TRIGGER task_worktree_receipt_failure
      BEFORE INSERT ON task_worktree_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt persistence failure');
      END;
    `);

    expectCode(
      () => service.createOrAdopt(base),
      "CAPABILITY_OPERATION_FAILED",
    );
    expect(git.createCount).toBe(0);
    expect(db.query("SELECT count(*) AS count FROM task_worktree_leases").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM task_worktree_receipts").get()).toEqual({ count: 0 });
  });

  it("leaves a deterministic failed reservation receipt and supports retry after final receipt failure", () => {
    db.exec(`
      CREATE TRIGGER task_worktree_final_receipt_failure
      BEFORE INSERT ON task_worktree_receipts
      WHEN NEW.outcome = 'created'
      BEGIN
        SELECT RAISE(ABORT, 'injected final receipt persistence failure');
      END;
    `);

    const failed = expectCode(
      () => service.createOrAdopt(base),
      "CAPABILITY_OPERATION_FAILED",
    );
    expect(failed.receipt).toMatchObject({
      operation: "create_or_adopt",
      outcome: "failed",
      ok: false,
      lease: { status: "failed" },
    });
    expect(git.createCount).toBe(1);
    expect(db.query("SELECT status FROM task_worktree_leases").get()).toEqual({ status: "failed" });
    expect(db.query("SELECT count(*) AS count FROM task_worktree_generations").get()).toEqual({ count: 0 });

    db.exec("DROP TRIGGER task_worktree_final_receipt_failure");
    const retried = service.createOrAdopt(base);
    expect(retried).toMatchObject({
      outcome: "adopted",
      lease: {
        status: "active",
        writer_generation: "generation-1",
      },
    });
    expect(git.createCount).toBe(1);
    expect(db.query("SELECT count(*) AS count FROM task_worktree_generations").get()).toEqual({ count: 1 });
  });

  it("retires an active lease when idempotent adoption finds divergent filesystem identity", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.states.delete(path);
    const collision = expectCode(
      () => service.createOrAdopt(base),
      "WORKTREE_COLLISION",
    );
    expect(collision.receipt).toMatchObject({
      ok: false,
      outcome: "collision",
      lease: { status: "failed" },
    });
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "LEASE_NOT_ACTIVE");
    expectCode(
      () => service.createOrAdopt(base),
      "STALE_WRITER",
    );
    expect(git.createCount).toBe(1);
  });

  it("returns stable collision receipts for path, branch, and concurrent-writer conflicts", () => {
    service.createOrAdopt(base);
    const pathCollision = expectCode(
      () => service.createOrAdopt({
        ...base,
        taskId: "task-2",
        writerGeneration: "generation-2",
        attempt: "attempt-2",
      }),
      "WORKTREE_COLLISION",
    );
    expect(pathCollision.receipt).toMatchObject({
      ok: false,
      operation: "create_or_adopt",
      outcome: "collision",
      available: true,
    });
    const branchCollision = expectCode(
      () => service.createOrAdopt({
        ...base,
        taskId: "task-3",
        taskWorktreeName: "task-three",
        writerGeneration: "generation-3",
        attempt: "attempt-3",
      }),
      "WORKTREE_COLLISION",
    );
    expect(branchCollision.receipt?.outcome).toBe("collision");
    expect(git.createCount).toBe(1);
  });

  it("serializes a concurrent writer behind the durable provisioning reservation", () => {
    let collision: TaskWorktreeError | null = null;
    git.beforeCreate = () => {
      git.beforeCreate = null;
      collision = expectCode(
        () => service.createOrAdopt({
          ...base,
          writerGeneration: "generation-2",
          attempt: "attempt-2",
          machineId: "machine-b",
        }),
        "WORKTREE_COLLISION",
      );
    };
    const created = service.createOrAdopt(base);
    expect(created.outcome).toBe("created");
    expect(collision?.receipt).toMatchObject({
      ok: false,
      outcome: "collision",
      lease: { status: "provisioning" },
    });
    expect(git.createCount).toBe(1);
  });

  it("keeps a blocked worktree branch reserved until cleanup completes", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.update(path, { clean: false });
    expect(service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }).lease?.status).toBe("cleanup_blocked");

    const collision = expectCode(
      () => service.createOrAdopt({
        ...base,
        taskId: "task-2",
        taskWorktreeName: "task-two",
        writerGeneration: "generation-2",
        attempt: "attempt-2",
      }),
      "WORKTREE_COLLISION",
    );
    expect(collision.receipt).toMatchObject({
      ok: false,
      outcome: "collision",
    });
  });

  it("rejects a second non-cleaned worktree for the same task", () => {
    service.createOrAdopt(base);
    const collision = expectCode(
      () => service.createOrAdopt({
        ...base,
        taskWorktreeName: "task-one-alternate",
        branch: "feat/task-one-alternate",
      }),
      "WORKTREE_COLLISION",
    );
    expect(collision.receipt).toMatchObject({
      ok: false,
      outcome: "collision",
    });
    expect(git.createCount).toBe(1);
  });

  it("fails closed when repository registration is ambiguous", () => {
    db.query(`INSERT INTO repos
      (path, name, org, remote_url, default_branch, created_at, updated_at)
      VALUES (?, 'repos', 'hasna', 'github.com/hasna/repos', 'main', datetime('now'), datetime('now'))`)
      .run("/registered/repos-duplicate");
    expectCode(
      () => service.createOrAdopt(base),
      "REPOSITORY_IDENTITY_MISMATCH",
    );
    expect(git.createCount).toBe(0);
  });

  it("rejects unknown cleanup policy values before reserving a lease", () => {
    expectCode(
      () => service.createOrAdopt({
        ...base,
        cleanupPolicy: { pullRequest: "unknown" as "none" },
      }),
      "INVALID_REQUEST",
    );
    expect(db.query("SELECT count(*) AS count FROM task_worktree_leases").get()).toEqual({ count: 0 });
  });

  it("classifies an occupied non-adoptable path and provider branch as stable collisions", () => {
    const occupied = join(root, "repos", "task-one");
    mkdirSync(occupied, { recursive: true });
    const pathCollision = expectCode(
      () => service.createOrAdopt(base),
      "WORKTREE_COLLISION",
    );
    expect(pathCollision.receipt).toMatchObject({
      ok: false,
      operation: "create_or_adopt",
      outcome: "collision",
    });

    rmSync(occupied, { recursive: true });
    git.provider.set("hasna/repos:feat/task-one", HEAD);
    const branchCollision = expectCode(
      () => service.createOrAdopt(base),
      "BRANCH_COLLISION",
    );
    expect(branchCollision.receipt).toMatchObject({
      ok: false,
      outcome: "collision",
    });
  });

  it("treats provider unreachability as an operational failure, never branch absence", () => {
    git.providerFailure = true;
    const error = expectCode(
      () => service.createOrAdopt(base),
      "PROVIDER_UNREACHABLE",
    );
    expect(error.receipt).toMatchObject({
      ok: false,
      outcome: "failed",
      available: true,
    });
    expect(git.createCount).toBe(0);
  });

  it("fences stale heartbeats, transfers, and cleanup after an ownership transfer", () => {
    const created = service.createOrAdopt(base);
    const transferred = service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
      ttlSeconds: 30,
    });
    expect(transferred.lease).toMatchObject({
      writer_generation: "generation-2",
      attempt: "attempt-2",
      machine_id: "machine-b",
    });
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "STALE_WRITER");
    expectCode(() => service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-3",
      newAttempt: "attempt-3",
      newMachineId: "machine-c",
    }), "STALE_WRITER");
    expectCode(() => service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "STALE_WRITER");
    expect(service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-2",
      attempt: "attempt-2",
      machineId: "machine-b",
    }).outcome).toBe("heartbeat");
  });

  it("recovers only the exact observed expired generation and fences the predecessor", () => {
    const created = service.createOrAdopt(base);
    expectCode(() => service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "generation-1",
      observedAttempt: "attempt-1",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }), "LEASE_NOT_EXPIRED");
    now = new Date(now.getTime() + 31_000);
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "STALE_WRITER");
    expectCode(() => service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }), "STALE_WRITER");
    expectCode(() => service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "STALE_WRITER");
    expectCode(() => service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "wrong-generation",
      observedAttempt: "attempt-1",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }), "STALE_WRITER");
    const recovered = service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "generation-1",
      observedAttempt: "attempt-1",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    });
    expect(recovered.transition).toMatchObject({
      from_generation: "generation-1",
      to_generation: "generation-2",
    });
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "STALE_WRITER");
  });

  it("requires transfer and recovery to advance the writer generation", () => {
    const created = service.createOrAdopt(base);
    expectCode(() => service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-1",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }), "INVALID_REQUEST");
    now = new Date(now.getTime() + 31_000);
    expectCode(() => service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "generation-1",
      observedAttempt: "attempt-1",
      newWriterGeneration: "generation-1",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }), "INVALID_REQUEST");
  });

  it("rejects traversal, noncanonical supplied paths, and symlinked repository roots", () => {
    expectCode(() => service.createOrAdopt({
      ...base,
      taskWorktreeName: "../escape",
    }), "INVALID_REQUEST");
    expectCode(() => service.createOrAdopt({
      ...base,
      worktreePath: join(temp, "outside"),
    }), "PATH_OUTSIDE_CANONICAL_ROOT");

    mkdirSync(root, { recursive: true });
    const outside = join(temp, "outside-repo-root");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "repos"), "dir");
    expectCode(() => service.createOrAdopt(base), "PATH_SYMLINK");
    expect(git.createCount).toBe(0);
  });

  it("rejects a dangling symlink in the canonical path", () => {
    mkdirSync(root, { recursive: true });
    symlinkSync(join(temp, "missing-target"), join(root, "repos"), "dir");
    expectCode(() => service.createOrAdopt(base), "PATH_SYMLINK");
    expect(git.createCount).toBe(0);
  });

  it("binds machine identity into every writer transition", () => {
    const created = service.createOrAdopt(base);
    expect(created.lease?.machine_id).toBe("machine-a");
    const transferred = service.transfer({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    });
    expect(transferred.lease?.machine_id).toBe("machine-b");
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-2",
      attempt: "attempt-2",
      machineId: "machine-a",
    }), "STALE_WRITER");
  });

  it("reports the current active head and fails when its canonical path disappears", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.update(path, { head: OTHER_HEAD });
    expect(service.status({ leaseId: created.lease!.lease_id }).lease?.head_sha).toBe(OTHER_HEAD);
    rmSync(path, { recursive: true });
    git.states.delete(path);
    expectCode(
      () => service.status({ leaseId: created.lease!.lease_id }),
      "GIT_STATE_INVALID",
    );
  });

  it("rejects persisted path tampering before any fenced operation", () => {
    const created = service.createOrAdopt(base);
    const outside = join(temp, "outside-tampered");
    db.query("UPDATE task_worktree_leases SET worktree_path = ? WHERE lease_id = ?")
      .run(outside, created.lease!.lease_id);
    expectCode(() => service.heartbeat({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "PATH_OUTSIDE_CANONICAL_ROOT");
  });

  it.each([
    {
      name: "dirty worktree",
      state: { clean: false },
      provider: HEAD,
      expectedGate: "worktree_clean",
    },
    {
      name: "unpushed branch",
      state: { clean: true, upstream: null, upstreamHead: null },
      provider: HEAD,
      expectedGate: "branch_pushed",
    },
    {
      name: "provider-unreachable commit",
      state: { clean: true, upstream: "origin/feat/task-one", upstreamHead: HEAD },
      provider: OTHER_HEAD,
      expectedGate: "provider_reachable",
    },
  ])("fails cleanup closed for $name and reports the exact gate", ({ state, provider, expectedGate }) => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.update(path, state);
    git.provider.set("hasna/repos:feat/task-one", provider);
    const result = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    });
    expect(result.outcome).toBe("blocked");
    expect(result.ok).toBe(false);
    expect(result.lease?.status).toBe("cleanup_blocked");
    expect(result.gates).toContainEqual(expect.objectContaining({ id: expectedGate, passed: false }));
    expect(git.cleanupCount).toBe(0);
  });

  it("enforces PR policy and permits recovery from blocked cleanup", () => {
    const created = service.createOrAdopt({
      ...base,
      cleanupPolicy: { pullRequest: "merged" },
    });
    const path = created.lease!.worktree_path;
    git.update(path, {
      clean: true,
      upstream: "origin/feat/task-one",
      upstreamHead: HEAD,
    });
    git.provider.set("hasna/repos:feat/task-one", HEAD);
    git.prState = "open";
    const blocked = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    });
    expect(blocked.gates).toContainEqual(expect.objectContaining({
      id: "pull_request_policy",
      passed: false,
    }));
    expect(service.recover({
      leaseId: created.lease!.lease_id,
      observedWriterGeneration: "generation-1",
      observedAttempt: "attempt-1",
      newWriterGeneration: "generation-2",
      newAttempt: "attempt-2",
      newMachineId: "machine-b",
    }).lease?.status).toBe("active");
  });

  it("cleans only after every gate passes and persists the exact receipt", () => {
    const created = service.createOrAdopt({
      ...base,
      cleanupPolicy: { pullRequest: "merged" },
    });
    const path = created.lease!.worktree_path;
    git.update(path, {
      clean: true,
      upstream: "origin/feat/task-one",
      upstreamHead: HEAD,
    });
    git.provider.set("hasna/repos:feat/task-one", HEAD);
    git.prState = "merged";
    const cleaned = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    });
    expect(cleaned.outcome).toBe("cleaned");
    expect(cleaned.lease?.status).toBe("cleaned");
    expect(cleaned.gates?.every((gate) => gate.passed)).toBe(true);
    expect(git.cleanupCount).toBe(1);
    expect(db.query("SELECT payload_json FROM task_worktree_receipts WHERE receipt_id = ?").get(cleaned.receipt_id))
      .toEqual({ payload_json: JSON.stringify(cleaned) });
  });

  it("emits cleanup eligibility without deleting the worktree", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.update(path, {
      clean: true,
      upstream: "origin/feat/task-one",
      upstreamHead: HEAD,
    });
    git.provider.set("hasna/repos:feat/task-one", HEAD);
    const eligible = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
      eligibilityOnly: true,
    });
    expect(eligible).toMatchObject({
      operation: "cleanup_eligibility",
      outcome: "eligible",
      ok: true,
      lease: { status: "cleanup_blocked" },
    });
    expect(eligible.gates?.every((gate) => gate.passed)).toBe(true);
    expect(git.cleanupCount).toBe(0);
  });

  it("revalidates cleanliness and reachability immediately before destructive cleanup", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    git.update(path, {
      clean: true,
      upstream: "origin/feat/task-one",
      upstreamHead: HEAD,
    });
    git.provider.set("hasna/repos:feat/task-one", HEAD);
    git.dirtyAfterInspectCount = 1;
    const blocked = service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.gates).toContainEqual(expect.objectContaining({
      id: "worktree_clean",
      passed: false,
    }));
    expect(git.cleanupCount).toBe(0);
  });

  it("rejects a symlink substituted at cleanup without deleting its target", () => {
    const created = service.createOrAdopt(base);
    const path = created.lease!.worktree_path;
    const outside = join(temp, "outside-cleanup");
    mkdirSync(outside);
    rmSync(path, { recursive: true });
    symlinkSync(outside, path, "dir");
    expectCode(() => service.cleanup({
      leaseId: created.lease!.lease_id,
      writerGeneration: "generation-1",
      attempt: "attempt-1",
      machineId: "machine-a",
    }), "PATH_SYMLINK");
    expect(realpathSync(path)).toBe(realpathSync(outside));
    expect(git.cleanupCount).toBe(0);
  });
});
