import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../db/database";
import {
  canonicalizeRepo,
  claimWorktree,
  defaultWorktreeBranch,
  defaultWorktreePath,
  importWorktree,
  inspectWorktree,
  inventoryWorktrees,
  releaseWorktree,
  renewWorktreeLease,
  verifyWorktree,
} from "./worktrees";

setDefaultTimeout(20_000);

let tempDir = "";
let root = "";
let source = "";
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const originalPath = process.env["PATH"] || "";
const transportEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;
const originalTransportEnv = Object.fromEntries(transportEnvKeys.map((key) => [key, process.env[key]]));

function git(args: string[], cwd: string) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createSourceRepo() {
  const remote = join(tempDir, "remote.git");
  const checkout = join(tempDir, "source");
  mkdirSync(remote, { recursive: true });
  git(["init", "--bare", remote], tempDir);
  git(["--git-dir", remote, "remote", "add", "origin", "https://github.com/hasna/repos.git"], tempDir);
  git(["clone", remote, checkout], tempDir);
  git(["config", "user.email", "test@example.com"], checkout);
  git(["config", "user.name", "Test User"], checkout);
  git(["checkout", "-b", "main"], checkout);
  writeFileSync(join(checkout, "README.md"), "# test\n");
  git(["add", "README.md"], checkout);
  git(["commit", "-m", "initial"], checkout);
  git(["push", "-u", "origin", "main"], checkout);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], tempDir);
  git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], checkout);
  return checkout;
}

function claim(branch: string, extra: Partial<Parameters<typeof claimWorktree>[0]> = {}) {
  return claimWorktree({
    repo: "hasna/repos",
    source,
    taskId: "task-1",
    runId: "run-1",
    machineId: "machine-1",
    branch,
    owner: "pacuvius",
    root,
    idempotencyKey: branch,
    ...extra,
  });
}

function publishBranch(path: string, branch: string) {
  const head = git(["rev-parse", "HEAD"], path);
  git(["push", join(tempDir, "remote.git"), `HEAD:refs/heads/${branch}`], path);
  git(["update-ref", `refs/remotes/origin/${branch}`, head], path);
  git(["config", `branch.${branch}.remote`, "origin"], path);
  git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], path);
}

function installGitTestShim() {
  const bin = join(tempDir, "bin");
  const shim = join(bin, "git");
  mkdirSync(bin, { recursive: true });
  writeFileSync(shim, `#!/bin/sh
if [ "$1" = "ls-remote" ] && [ "$2" = "--symref" ] && [ "$4" = "HEAD" ]; then
  if [ "\${HASNA_REPOS_TEST_LS_REMOTE_FAIL:-}" = "1" ]; then
    echo "simulated remote default probe failure" >&2
    exit 128
  fi
  if [ "\${HASNA_REPOS_TEST_LS_REMOTE_MALFORMED:-}" = "1" ]; then
    printf 'ref: refs/heads/main\\tHEAD\\n'
    exit 0
  fi
  if [ "\${HASNA_REPOS_TEST_LS_REMOTE_SHA256_PROOF:-}" = "1" ]; then
    printf 'ref: refs/heads/main\\tHEAD\\n'
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\tHEAD\\n'
    exit 0
  fi
  if [ -n "\${HASNA_REPOS_TEST_LS_REMOTE_OBJECT_ID:-}" ]; then
    printf 'ref: refs/heads/main\\tHEAD\\n'
    printf '%s\\tHEAD\\n' "$HASNA_REPOS_TEST_LS_REMOTE_OBJECT_ID"
    exit 0
  fi
  if [ -n "\${HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER:-}" ]; then
    count=0
    if [ -f "$HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER" ]; then
      count="$(cat "$HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"
    if [ "$count" = "\${HASNA_REPOS_TEST_DEFAULT_PROBE_FAIL_AT:-0}" ]; then
      echo "simulated pre-activation default probe failure" >&2
      exit 128
    fi
    if [ "$count" = "2" ] && [ -n "\${HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH:-}" ]; then
      "${realGit}" --git-dir="$HASNA_REPOS_TEST_GIT_REMOTE" symbolic-ref \
        HEAD "refs/heads/$HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"
    fi
  fi
  if [ "$3" = "origin" ]; then
    exec "${realGit}" ls-remote --symref "$HASNA_REPOS_TEST_GIT_REMOTE" HEAD
  fi
  exec "${realGit}" ls-remote --symref "$3" HEAD
fi
if [ "$1" = "ls-remote" ] && [ "$2" = "--exit-code" ] && [ "$3" = "origin" ]; then
  if [ -n "\${HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER:-}" ]; then
    count=0
    if [ -f "$HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER" ]; then
      count="$(cat "$HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER"
    if [ "$count" = "3" ]; then
      if "${realGit}" commit --allow-empty -m "attempted during terminal release" >/dev/null 2>&1; then
        printf 'advanced\n' > "$HASNA_REPOS_TEST_RELEASE_LOCK_RESULT"
      else
        printf 'blocked\n' > "$HASNA_REPOS_TEST_RELEASE_LOCK_RESULT"
      fi
    fi
  fi
  if [ -n "\${HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER:-}" ]; then
    count=0
    if [ -f "$HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER" ]; then
      count="$(cat "$HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER"
    if [ "$count" = "2" ]; then
      bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env["HASNA_REPOS_TEST_RELEASE_WINNER_DB"]); const row = db.query("SELECT head_sha, metadata_json FROM worktree_leases WHERE lease_id = ?").get(process.env["HASNA_REPOS_TEST_RELEASE_WINNER_LEASE"]); const metadata = JSON.parse(row.metadata_json); const now = Date.now(); db.query("UPDATE worktree_leases SET status = ?1, released_at_ms = ?2, updated_at_ms = ?2, metadata_json = ?3 WHERE lease_id = ?4 AND status = ?5").run("released", now, JSON.stringify({ ...metadata, release_verified_head_sha: row.head_sha, release_finalized: true, release_finalized_at_ms: now }), process.env["HASNA_REPOS_TEST_RELEASE_WINNER_LEASE"], "releasing"); db.close()'
      echo "simulated losing release probe" >&2
      exit 128
    fi
  fi
  if [ "\${HASNA_REPOS_TEST_LS_REMOTE_FAIL:-}" = "1" ]; then
    echo "simulated remote probe failure" >&2
    exit 128
  fi
  if [ -n "\${HASNA_REPOS_TEST_REMOTE_OBJECT_ID:-}" ]; then
    printf '%s\\t%s\\n' "$HASNA_REPOS_TEST_REMOTE_OBJECT_ID" "$4"
    exit 0
  fi
  if [ "\${HASNA_REPOS_TEST_REQUIRE_SANITIZED_TRANSPORT_ENV:-}" = "1" ]; then
    for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR; do
      eval "value=\\\${$name:-}"
      if [ -n "$value" ]; then
        echo "unsanitized transport environment: $name" >&2
        exit 128
      fi
    done
  fi
  if [ -n "\${HASNA_REPOS_TEST_QUARANTINE_WINNER_DB:-}" ]; then
    bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_DB"]); db.query("UPDATE worktree_leases SET status = ?1, canonical_path = ?2, worktree_path = ?2 WHERE lease_id = ?3").run("quarantined", process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_PATH"], process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_LEASE"]); db.close()'
  fi
  if [ -n "\${HASNA_REPOS_TEST_RELEASE_HEAD_RACE_MARKER:-}" ] && [ ! -f "$HASNA_REPOS_TEST_RELEASE_HEAD_RACE_MARKER" ]; then
    printf 'raced during release proof\n' > "$HASNA_REPOS_TEST_RELEASE_HEAD_RACE_MARKER"
    printf 'raced during release proof\n' > raced-during-release-proof.txt
    "${realGit}" add raced-during-release-proof.txt
    "${realGit}" commit -m "raced during release proof" >/dev/null
  fi
  if [ -n "\${HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER:-}" ]; then
    count=0
    if [ -f "$HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER" ]; then
      count="$(cat "$HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER"
    if [ "$count" = "4" ]; then
      "${realGit}" --git-dir="$HASNA_REPOS_TEST_GIT_REMOTE" update-ref \
        "refs/heads/$HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_BRANCH" \
        "$HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_SHA"
    fi
  fi
  exec "${realGit}" ls-remote --exit-code "$HASNA_REPOS_TEST_GIT_REMOTE" "$4"
fi
if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ -n "\${HASNA_REPOS_TEST_LOCAL_ORIGIN_RACE_URL:-}" ]; then
  "${realGit}" "$@"
  "${realGit}" remote set-url origin "$HASNA_REPOS_TEST_LOCAL_ORIGIN_RACE_URL"
  exit 0
fi
if [ "$1" = "worktree" ] && [ "$2" = "move" ] && [ "\${HASNA_REPOS_TEST_WORKTREE_MOVE_FAIL_AFTER_MOVE:-}" = "1" ]; then
  case "$4" in
    *"/.quarantine/"*) ;;
    *) exec "${realGit}" "$@" ;;
  esac
  "${realGit}" "$@"
  echo "simulated failure after worktree move" >&2
  exit 128
fi
if [ "$1" = "worktree" ] && [ "$2" = "move" ] && [ -n "\${HASNA_REPOS_TEST_QUARANTINE_RETRY_RESULT:-}" ]; then
  "${realGit}" "$@"
  bun -e 'const { releaseWorktree } = await import(process.env["HASNA_REPOS_TEST_WORKTREES_MODULE"]); const result = releaseWorktree({ leaseId: process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_LEASE"], generation: Number(process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_GENERATION"]), fencingToken: process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_FENCE"], cleanup: "quarantine" }); await Bun.write(process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_RESULT"], JSON.stringify(result))'
  exit 0
fi
if [ "$1" = "worktree" ] && [ "$2" = "move" ] && [ "\${HASNA_REPOS_TEST_MUTATE_AFTER_WORKTREE_MOVE:-}" = "1" ]; then
  "${realGit}" "$@"
  case "$3" in
    *"/.quarantine/"*)
      if [ -n "\${HASNA_REPOS_TEST_ROLLBACK_CLAIM_RESULT:-}" ]; then
        bun -e 'const { claimWorktree } = await import(process.env["HASNA_REPOS_TEST_WORKTREES_MODULE"]); const result = claimWorktree({ repo: "hasna/repos", source: process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_SOURCE"], taskId: "task-rollback-competitor", runId: "run-rollback-competitor", machineId: "machine-1", branch: process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_BRANCH"], owner: "competitor", root: process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_ROOT"], idempotencyKey: "rollback-competitor" }); await Bun.write(process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_RESULT"], JSON.stringify(result))'
      fi
      ;;
  esac
  printf 'raced after move\n' > "$4/raced-after-move.txt"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && [ -n "\${HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER:-}" ]; then
  case "$(pwd)" in
    *"/.quarantine/"*)
      count=0
      if [ -f "$HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER" ]; then
        count="$(cat "$HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER")"
      fi
      count=$((count + 1))
      printf '%s\n' "$count" > "$HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER"
      if [ "$count" = "2" ]; then
        printf 'raced before backup ref\n' > raced-before-backup-ref.txt
        "${realGit}" add raced-before-backup-ref.txt
        "${realGit}" commit -m "raced before backup ref" >/dev/null
      fi
      ;;
  esac
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && [ -n "$3" ] && [ -n "\${HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER:-}" ]; then
  case "$3" in
    refs/hasna/worktrees/*)
      count=0
      if [ -f "$HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER" ]; then
        count="$(cat "$HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER")"
      fi
      count=$((count + 1))
      printf '%s\n' "$count" > "$HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER"
      if [ "$count" = "2" ]; then
        printf 'raced after completion CAS\n' > raced-after-completion-cas.txt
        "${realGit}" add raced-after-completion-cas.txt
        "${realGit}" commit -m "raced after completion CAS" >/dev/null
        "${realGit}" update-ref "$3" HEAD
      fi
      ;;
  esac
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && [ -n "$3" ] && [ -n "\${HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER:-}" ]; then
  case "$3" in
    refs/hasna/worktrees/*)
      count=0
      if [ -f "$HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER" ]; then
        count="$(cat "$HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER")"
      fi
      count=$((count + 1))
      printf '%s\n' "$count" > "$HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER"
      if [ "$count" = "3" ]; then
        if "${realGit}" update-ref "$3" "$HASNA_REPOS_TEST_BACKUP_LOCK_SHA" >/dev/null 2>&1; then
          printf 'advanced\n' > "$HASNA_REPOS_TEST_BACKUP_LOCK_RESULT"
        else
          printf 'blocked\n' > "$HASNA_REPOS_TEST_BACKUP_LOCK_RESULT"
        fi
      fi
      ;;
  esac
fi
if [ "$1" = "status" ] && [ -n "\${HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_URL:-}" ]; then
  if "${realGit}" remote set-url origin "$HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_URL" >/dev/null 2>&1; then
    printf 'changed\n' > "$HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_RESULT"
  else
    printf 'blocked\n' > "$HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_RESULT"
  fi
  exec "${realGit}" "$@"
fi
exec "${realGit}" "$@"
`);
  chmodSync(shim, 0o755);
  process.env["PATH"] = `${bin}:${originalPath}`;
  process.env["HASNA_REPOS_TEST_GIT_REMOTE"] = join(tempDir, "remote.git");
}

beforeEach(() => {
  tempDir = join(tmpdir(), `repos-worktrees-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  root = join(tempDir, "worktrees");
  mkdirSync(tempDir, { recursive: true });
  installGitTestShim();
  process.env["HASNA_REPOS_DB_PATH"] = join(tempDir, "repos.db");
  closeDb();
  source = createSourceRepo();
});

afterEach(() => {
  closeDb();
  delete process.env["HASNA_REPOS_DB_PATH"];
  delete process.env["HASNA_REPOS_TEST_GIT_REMOTE"];
  delete process.env["HASNA_REPOS_TEST_LS_REMOTE_FAIL"];
  delete process.env["HASNA_REPOS_TEST_LS_REMOTE_MALFORMED"];
  delete process.env["HASNA_REPOS_TEST_LS_REMOTE_SHA256_PROOF"];
  delete process.env["HASNA_REPOS_TEST_LS_REMOTE_OBJECT_ID"];
  delete process.env["HASNA_REPOS_TEST_REMOTE_OBJECT_ID"];
  delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_FAIL_AT"];
  delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"];
  delete process.env["HASNA_REPOS_TEST_WORKTREE_MOVE_FAIL_AFTER_MOVE"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_DB"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_PATH"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_LEASE"];
  delete process.env["HASNA_REPOS_TEST_REQUIRE_SANITIZED_TRANSPORT_ENV"];
  delete process.env["HASNA_REPOS_TEST_MUTATE_AFTER_WORKTREE_MOVE"];
  delete process.env["HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_HEAD_RACE_MARKER"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_WINNER_DB"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_WINNER_LEASE"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_RELEASE_LOCK_RESULT"];
  delete process.env["HASNA_REPOS_TEST_LOCAL_ORIGIN_RACE_URL"];
  delete process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_BRANCH"];
  delete process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_SHA"];
  delete process.env["HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER"];
  delete process.env["HASNA_REPOS_TEST_BACKUP_LOCK_SHA"];
  delete process.env["HASNA_REPOS_TEST_BACKUP_LOCK_RESULT"];
  delete process.env["HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_URL"];
  delete process.env["HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_RESULT"];
  delete process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_RESULT"];
  delete process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_SOURCE"];
  delete process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_BRANCH"];
  delete process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_ROOT"];
  delete process.env["HASNA_REPOS_TEST_WORKTREES_MODULE"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_RESULT"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_LEASE"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_GENERATION"];
  delete process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_FENCE"];
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_SSH"];
  delete process.env["GIT_SSH_COMMAND"];
  for (const key of transportEnvKeys) {
    const value = originalTransportEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env["PATH"] = originalPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("worktree control plane", () => {
  it("canonicalizes repo refs and idempotently claims a worktree", () => {
    expect(canonicalizeRepo("https://github.com/hasna/repos.git")).toBe("hasna/repos");
    expect(canonicalizeRepo("git@github.com:hasna/repos.git")).toBe("hasna/repos");
    expect(canonicalizeRepo("ssh://git@github.com/hasna/repos.git")).toBe("hasna/repos");
    expect(() => canonicalizeRepo("https://evil.example/hasna/repos.git")).toThrow();
    expect(() => canonicalizeRepo("ssh://git@evil.example/hasna/repos.git")).toThrow();

    const first = claim("task/idempotent");
    expect(first.ok).toBe(true);
    expect(first.lease?.status).toBe("active");
    expect(first.lease?.generation).toBe(1);
    expect(first.git?.is_git_worktree).toBe(true);
    expect(first.lease?.canonical_path).toBe(join(
      root,
      "machine-1",
      "repos-dd2673d92bfc",
      first.lease!.lease_id,
      "repo",
    ));

    const second = claim("task/idempotent");
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(second.lease?.lease_id).toBe(first.lease?.lease_id);
  });

  it("retries the same guard-compatible claim without an idempotency key", () => {
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-no-idempotency",
      runId: "run-no-idempotency",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
      baseRef: "origin/main",
    };
    const first = claimWorktree(options);
    const retry = claimWorktree(options);
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.idempotent).toBe(true);
    expect(retry.lease?.lease_id).toBe(first.lease?.lease_id);
  });

  it("derives a task branch when the guard-compatible claim omits one", () => {
    const branch = defaultWorktreeBranch({ taskId: "task-derived", runId: "run-derived" });
    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-derived",
      runId: "run-derived",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
      baseRef: "origin/main",
      idempotencyKey: "derived-branch",
    });
    expect(result.ok).toBe(true);
    expect(result.lease?.branch).toBe(branch);
    expect(result.git?.branch).toBe(branch);
  });

  it("uses the live default rather than the source checkout HEAD when base is omitted", () => {
    const mainHead = git(["rev-parse", "main"], source);
    git(["checkout", "-b", "unrelated-feature"], source);
    writeFileSync(join(source, "feature.txt"), "feature\n");
    git(["add", "feature.txt"], source);
    git(["commit", "-m", "feature"], source);
    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-default-base",
      runId: "run-default-base",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
    });
    expect(result.ok).toBe(true);
    expect(result.git?.head_sha).toBe(mainHead);
  });

  it("rejects the live repository default on claim and derives the base from that proof", () => {
    git(["checkout", "-b", "stable"], source);
    writeFileSync(join(source, "stable.txt"), "stable default\n");
    git(["add", "stable.txt"], source);
    git(["commit", "-m", "stable default"], source);
    publishBranch(source, "stable");
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/stable"], tempDir);
    const stableHead = git(["rev-parse", "HEAD"], source);

    const rejected = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-claim-default-stable",
      runId: "run-claim-default-stable",
      machineId: "machine-1",
      branch: "stable",
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-default-stable",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.code).toBe("protected_branch");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });

    const claimed = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-claim-stable-base",
      runId: "run-claim-stable-base",
      machineId: "machine-1",
      branch: "task/claim-stable-base",
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-stable-base",
    });
    expect(claimed.ok).toBe(true);
    expect(claimed.lease?.base_ref).toBe("stable");
    expect(claimed.lease?.head_sha).toBe(stableHead);
  });

  it("fails closed when claim cannot prove a well-formed live default branch", () => {
    for (const mode of ["failure", "malformed"] as const) {
      if (mode === "failure") process.env["HASNA_REPOS_TEST_LS_REMOTE_FAIL"] = "1";
      else process.env["HASNA_REPOS_TEST_LS_REMOTE_MALFORMED"] = "1";
      const result = claimWorktree({
        repo: "hasna/repos",
        source,
        taskId: `task-claim-default-${mode}`,
        runId: `run-claim-default-${mode}`,
        machineId: "machine-1",
        branch: `task/claim-default-${mode}`,
        owner: "pacuvius",
        root,
        idempotencyKey: `claim-default-${mode}`,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("remote_default_branch_unverified");
      delete process.env["HASNA_REPOS_TEST_LS_REMOTE_FAIL"];
      delete process.env["HASNA_REPOS_TEST_LS_REMOTE_MALFORMED"];
    }
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
    expect(existsSync(root)).toBe(false);
  });

  it("accepts a SHA-256 object id in a well-formed live-default proof", () => {
    process.env["HASNA_REPOS_TEST_LS_REMOTE_SHA256_PROOF"] = "1";
    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-claim-default-sha256-proof",
      runId: "run-claim-default-sha256-proof",
      machineId: "machine-1",
      branch: "task/claim-default-sha256-proof",
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-default-sha256-proof",
    });
    expect(result.ok).toBe(true);
    expect(result.lease?.base_ref).toBe("main");
  });

  it("rejects an intermediate-length object id in a live-default proof", () => {
    process.env["HASNA_REPOS_TEST_LS_REMOTE_OBJECT_ID"] = "a".repeat(48);
    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-claim-default-intermediate-proof",
      runId: "run-claim-default-intermediate-proof",
      machineId: "machine-1",
      branch: "task/claim-default-intermediate-proof",
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-default-intermediate-proof",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("remote_default_branch_unverified");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
  });

  it("re-proves the live default immediately before claim activation and can retry after recovery", () => {
    const branch = "task/claim-default-race";
    const mainHead = git(["rev-parse", "refs/heads/main"], source);
    git(["--git-dir", join(tempDir, "remote.git"), "update-ref", `refs/heads/${branch}`, mainHead], tempDir);
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"] = join(tempDir, "claim-default-probe-counter");
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"] = branch;

    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-claim-default-race",
      runId: "run-claim-default-race",
      machineId: "machine-1",
      branch,
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-default-race",
    };
    const claimed = claimWorktree(options);

    expect(claimed.ok).toBe(false);
    expect(claimed.code).toBe("protected_branch");
    expect(claimed.lease?.status).toBe("preparing");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases WHERE status = 'active'").get())
      .toEqual({ count: 0 });

    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"];
    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"];
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main"], tempDir);
    const recovered = claimWorktree(options);
    expect(recovered.ok).toBe(true);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.lease?.lease_id).toBe(claimed.lease?.lease_id);
  });

  it("keeps a claim retryable when its final live-default proof is unavailable", () => {
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-claim-default-reproof-failure",
      runId: "run-claim-default-reproof-failure",
      machineId: "machine-1",
      branch: "task/claim-default-reproof-failure",
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-default-reproof-failure",
    };
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"] = join(tempDir, "claim-default-failure-counter");
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_FAIL_AT"] = "2";

    const failed = claimWorktree(options);
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("remote_default_branch_unverified");
    expect(failed.lease?.status).toBe("preparing");

    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"];
    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_FAIL_AT"];
    const recovered = claimWorktree(options);
    expect(recovered.ok).toBe(true);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.lease?.lease_id).toBe(failed.lease?.lease_id);
  });

  it("retains the persisted base when retrying after the live default changes to another safe branch", () => {
    const branch = "task/claim-safe-default-race";
    const mainHead = git(["rev-parse", "refs/heads/main"], source);
    git(["--git-dir", join(tempDir, "remote.git"), "update-ref", "refs/heads/stable", mainHead], tempDir);
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"] = join(tempDir, "claim-safe-default-probe-counter");
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"] = "stable";

    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-claim-safe-default-race",
      runId: "run-claim-safe-default-race",
      machineId: "machine-1",
      branch,
      owner: "pacuvius",
      root,
      idempotencyKey: "claim-safe-default-race",
    };
    const changed = claimWorktree(options);

    expect(changed.ok).toBe(false);
    expect(changed.code).toBe("remote_default_branch_changed");
    expect(changed.lease?.status).toBe("preparing");
    expect(changed.lease?.base_ref).toBe("main");

    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"];
    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"];
    const recovered = claimWorktree(options);
    expect(recovered.ok).toBe(true);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.lease?.lease_id).toBe(changed.lease?.lease_id);
    expect(recovered.lease?.base_ref).toBe("main");
    expect(recovered.lease?.head_sha).toBe(mainHead);
  });

  it("replays an active omitted-base claim after a safe default change but rejects an explicit base change", () => {
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-active-safe-default-change",
      runId: "run-active-safe-default-change",
      machineId: "machine-1",
      branch: "task/active-safe-default-change",
      owner: "pacuvius",
      root,
      idempotencyKey: "active-safe-default-change",
    };
    const claimed = claimWorktree(options);
    expect(claimed.ok).toBe(true);
    expect(claimed.lease?.base_ref).toBe("main");

    const mainHead = git(["rev-parse", "refs/heads/main"], source);
    git(["--git-dir", join(tempDir, "remote.git"), "update-ref", "refs/heads/stable", mainHead], tempDir);
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/stable"], tempDir);

    const replayed = claimWorktree(options);
    expect(replayed.ok).toBe(true);
    expect(replayed.idempotent).toBe(true);
    expect(replayed.lease?.lease_id).toBe(claimed.lease?.lease_id);
    expect(replayed.lease?.base_ref).toBe("main");

    const explicitChange = claimWorktree({ ...options, baseRef: "stable" });
    expect(explicitChange.ok).toBe(false);
    expect(explicitChange.code).toBe("idempotency_key_conflict");
    expect(explicitChange.issues?.some((issue) => issue.ref === "main != stable")).toBe(true);

    git(["--git-dir", join(tempDir, "remote.git"), "update-ref", `refs/heads/${options.branch}`, mainHead], tempDir);
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", `refs/heads/${options.branch}`], tempDir);
    const becameDefault = claimWorktree(options);
    expect(becameDefault.ok).toBe(false);
    expect(becameDefault.code).toBe("protected_branch");
  });

  it("preserves a derived base on same-claim retries without an idempotency key", () => {
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-no-key-derived-base",
      runId: "run-no-key-derived-base",
      machineId: "machine-1",
      branch: "task/no-key-derived-base",
      owner: "pacuvius",
      root,
    };
    const claimed = claimWorktree(options);
    expect(claimed.ok).toBe(true);
    expect(claimed.lease?.base_ref).toBe("main");
    expect(claimed.lease?.metadata["claim_base_provenance"]).toBe("derived");

    const mainHead = git(["rev-parse", "refs/heads/main"], source);
    git(["--git-dir", join(tempDir, "remote.git"), "update-ref", "refs/heads/stable", mainHead], tempDir);
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/stable"], tempDir);

    const replayed = claimWorktree(options);
    expect(replayed.ok).toBe(true);
    expect(replayed.idempotent).toBe(true);
    expect(replayed.lease?.lease_id).toBe(claimed.lease?.lease_id);
    expect(replayed.lease?.base_ref).toBe("main");

    const explicitReplay = claimWorktree({ ...options, baseRef: "main" });
    expect(explicitReplay.ok).toBe(false);
    expect(explicitReplay.code).toBe("owner_collision");
    expect(explicitReplay.lease?.lease_id).toBe(claimed.lease?.lease_id);
  });

  it("binds claim replay to explicit versus derived base provenance even when values coincide", () => {
    const derivedOptions = {
      repo: "hasna/repos",
      source,
      taskId: "task-derived-base-provenance",
      runId: "run-derived-base-provenance",
      machineId: "machine-1",
      branch: "task/derived-base-provenance",
      owner: "pacuvius",
      root,
      idempotencyKey: "derived-base-provenance",
    };
    const derived = claimWorktree(derivedOptions);
    expect(derived.ok).toBe(true);
    expect(derived.lease?.base_ref).toBe("main");
    expect(derived.lease?.metadata["claim_base_provenance"]).toBe("derived");

    const explicitReplay = claimWorktree({ ...derivedOptions, baseRef: "main" });
    expect(explicitReplay.ok).toBe(false);
    expect(explicitReplay.code).toBe("idempotency_key_conflict");
    expect(explicitReplay.issues?.some((issue) => issue.ref === "derived != explicit")).toBe(true);

    const explicitOptions = {
      ...derivedOptions,
      taskId: "task-explicit-base-provenance",
      runId: "run-explicit-base-provenance",
      branch: "task/explicit-base-provenance",
      idempotencyKey: "explicit-base-provenance",
      baseRef: "main",
    };
    const explicit = claimWorktree(explicitOptions);
    expect(explicit.ok).toBe(true);
    expect(explicit.lease?.metadata["claim_base_provenance"]).toBe("explicit");

    const { baseRef: _omitted, ...omittedReplayOptions } = explicitOptions;
    const omittedReplay = claimWorktree(omittedReplayOptions);
    expect(omittedReplay.ok).toBe(false);
    expect(omittedReplay.code).toBe("idempotency_key_conflict");
    expect(omittedReplay.issues?.some((issue) => issue.ref === "explicit != derived")).toBe(true);
  });

  it("fails closed when a preexisting claim does not record base provenance", () => {
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-legacy-base-provenance",
      runId: "run-legacy-base-provenance",
      machineId: "machine-1",
      branch: "task/legacy-base-provenance",
      owner: "pacuvius",
      root,
      idempotencyKey: "legacy-base-provenance",
    };
    const claimed = claimWorktree(options);
    expect(claimed.ok).toBe(true);
    getDb().query(`UPDATE worktree_leases
      SET metadata_json = json_remove(metadata_json, '$.claim_base_provenance')
      WHERE lease_id = ?`).run(claimed.lease!.lease_id);

    const replay = claimWorktree(options);
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("idempotency_key_conflict");
    expect(replay.issues?.some((issue) => issue.ref === "unknown != derived")).toBe(true);
  });

  it("rejects an intermediate-length object id in an origin branch proof", () => {
    process.env["HASNA_REPOS_TEST_REMOTE_OBJECT_ID"] = "b".repeat(48);
    const result = claim("task/intermediate-origin-proof");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.message).toContain("remote_probe_invalid");
  });

  it("rejects a non-canonical uppercase object id in an origin branch proof", () => {
    process.env["HASNA_REPOS_TEST_REMOTE_OBJECT_ID"] = "B".repeat(40);
    const result = claim("task/uppercase-origin-proof");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.message).toContain("remote_probe_invalid");
  });

  it("rejects an unpushed local base that differs from validated origin", () => {
    writeFileSync(join(source, "unpushed-main.txt"), "unpushed main\n");
    git(["add", "unpushed-main.txt"], source);
    git(["commit", "-m", "unpushed main"], source);

    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-unpushed-local-base",
      runId: "run-unpushed-local-base",
      machineId: "machine-1",
      branch: "task/unpushed-local-base",
      owner: "pacuvius",
      root,
      baseRef: "main",
      idempotencyKey: "unpushed-local-base",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.message).toContain("validated origin base");
    expect(result.lease?.status).toBe("preparing");
  });

  it("rejects protected and base branch claims", () => {
    const main = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-protected-main",
      runId: "run-protected-main",
      machineId: "machine-1",
      branch: "main",
      owner: "pacuvius",
      root,
    });
    expect(main.ok).toBe(false);
    expect(main.code).toBe("protected_branch");

    const base = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-protected-base",
      runId: "run-protected-base",
      machineId: "machine-1",
      branch: "release/next",
      owner: "pacuvius",
      root,
      baseRef: "origin/release/next",
    });
    expect(base.ok).toBe(false);
    expect(base.code).toBe("protected_branch");
  });

  it("rejects idempotency key replay for a different request", () => {
    const first = claim("task/idempotency-conflict");
    expect(first.ok).toBe(true);

    const replay = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-2",
      runId: "run-1",
      machineId: "machine-1",
      branch: "task/idempotency-conflict-2",
      owner: "pacuvius",
      root,
      idempotencyKey: "task/idempotency-conflict",
    });
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("idempotency_key_conflict");
    expect(replay.issues?.map((issue) => issue.code)).toContain("idempotency_request_mismatch");
  });

  it("rejects a source whose repository identity does not match the claimed repo", () => {
    const result = claimWorktree({
      repo: "hasna/not-repos",
      source,
      taskId: "task-source-mismatch",
      runId: "run-source-mismatch",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("source_repo_mismatch");
  });

  it("rejects linked-worktree activation after shared origin drift", () => {
    process.env["HASNA_REPOS_TEST_LOCAL_ORIGIN_RACE_URL"] = "https://github.com/hasna/other.git";
    const result = claim("task/local-origin-race");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.message).toContain("validated origin identity");
    expect(result.lease?.status).toBe("preparing");
  });

  it("locks shared origin configuration through activation", () => {
    process.env["HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_URL"] = "https://github.com/hasna/other.git";
    process.env["HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_RESULT"] = join(tempDir, "post-validation-origin-result");
    const result = claim("task/origin-activation-lock");

    expect(result.ok).toBe(true);
    expect(result.lease?.status).toBe("active");
    expect(readFileSync(process.env["HASNA_REPOS_TEST_POST_VALIDATION_ORIGIN_RESULT"], "utf8").trim())
      .toBe("blocked");
    expect(git(["config", "--local", "--get", "remote.origin.url"], result.lease!.canonical_path))
      .toBe("https://github.com/hasna/repos.git");
  });

  it("rejects hostile source hosts and reads origin without insteadOf rewriting", () => {
    for (const [index, remote] of [
      "https://evil.example/hasna/repos.git",
      "ssh://git@evil.example/hasna/repos.git",
    ].entries()) {
      git(["remote", "set-url", "origin", remote], source);
      const result = claimWorktree({
        repo: "hasna/repos",
        source,
        taskId: `task-hostile-source-${index}`,
        runId: `run-hostile-source-${index}`,
        machineId: "machine-1",
        owner: "pacuvius",
        root,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("source_repo_mismatch");
    }

    git(["remote", "set-url", "origin", "https://evil.example/hasna/repos.git"], source);
    git(["config", "--local", "url.https://github.com/.insteadOf", "https://evil.example/"], source);
    expect(git(["remote", "get-url", "origin"], source)).toBe("https://github.com/hasna/repos.git");
    const rewritten = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-rewritten-source",
      runId: "run-rewritten-source",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
    });
    expect(rewritten.ok).toBe(false);
    expect(rewritten.code).toBe("source_repo_mismatch");

    git(["config", "--local", "--unset", "url.https://github.com/.insteadOf"], source);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], source);
    git(["remote", "set-url", "--add", "--push", "origin", "https://evil.example/hasna/repos.git"], source);
    const hostilePush = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-hostile-push-source",
      runId: "run-hostile-push-source",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
    });
    expect(hostilePush.ok).toBe(false);
    expect(hostilePush.code).toBe("source_repo_mismatch");

    git(["config", "--local", "--unset-all", "remote.origin.pushurl"], source);
    git(["config", "--local", "url.https://evil.example/.pushInsteadOf", "https://github.com/"], source);
    const rewrittenPush = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-rewritten-push-source",
      runId: "run-rewritten-push-source",
      machineId: "machine-1",
      owner: "pacuvius",
      root,
    });
    expect(rewrittenPush.ok).toBe(false);
    expect(rewrittenPush.code).toBe("source_repo_mismatch");
  });

  it("rejects a rewritten canonical URL before cloning or creating a lease", () => {
    const gitConfig = join(tempDir, "rewritten-url.gitconfig");
    writeFileSync(gitConfig, `[url "file://${join(tempDir, "remote.git")}"]
  insteadOf = https://github.com/hasna/repos.git
`);
    process.env["GIT_CONFIG_GLOBAL"] = gitConfig;

    const result = claimWorktree({
      repo: "hasna/repos",
      source: "https://github.com/hasna/repos.git",
      taskId: "task-rewritten-first-claim",
      runId: "run-rewritten-first-claim",
      machineId: "machine-1",
      branch: "task/rewritten-first-claim",
      owner: "pacuvius",
      root,
      idempotencyKey: "rewritten-first-claim",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("source_transport_rewritten");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
    expect(existsSync(root)).toBe(false);
  });

  it("rejects inherited SSH transport controls before creating a lease", () => {
    process.env["GIT_SSH_COMMAND"] = "/bin/false";
    const result = claimWorktree({
      repo: "hasna/repos",
      source: "git@github.com:hasna/repos.git",
      taskId: "task-ssh-transport-control",
      runId: "run-ssh-transport-control",
      machineId: "machine-1",
      branch: "task/ssh-transport-control",
      owner: "pacuvius",
      root,
      idempotencyKey: "ssh-transport-control",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("source_transport_unsafe");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
    expect(existsSync(root)).toBe(false);
  });

  it("rejects an active claim replay after raw origin host drift", () => {
    const first = claim("task/replay-host-drift");
    expect(first.ok).toBe(true);
    git(["worktree", "remove", "--force", first.lease!.canonical_path], source);
    git(["clone", source, first.lease!.canonical_path], tempDir);
    git(["checkout", "-b", first.lease!.branch, first.lease!.head_sha!], first.lease!.canonical_path);
    git(["remote", "set-url", "origin", "https://evil.example/hasna/repos.git"], first.lease!.canonical_path);
    git(["config", "--local", "url.https://github.com/.insteadOf", "https://evil.example/"], first.lease!.canonical_path);
    expect(git(["remote", "get-url", "origin"], first.lease!.canonical_path)).toBe("https://github.com/hasna/repos.git");

    const replay = claim("task/replay-host-drift");
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("active_lease_invalid");
    expect(replay.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
  });

  it("fails a same-claim replay when the active lease path disappeared", () => {
    const first = claim("task/replay-missing");
    expect(first.ok).toBe(true);
    git(["worktree", "remove", "--force", first.lease!.canonical_path], source);
    const replay = claim("task/replay-missing");
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("active_lease_invalid");
    expect(replay.issues?.map((issue) => issue.code)).toContain("path_missing");
  });

  it("rejects conflicting lease and path selectors", () => {
    const first = claim("task/selector-a");
    const second = claim("task/selector-b");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const release = releaseWorktree({
      leaseId: first.lease!.lease_id,
      path: second.lease!.canonical_path,
      generation: first.lease!.generation,
      fencingToken: first.lease!.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("conflicting_selector");
    expect(inspectWorktree({ leaseId: first.lease!.lease_id }).lease?.status).toBe("active");
  });

  it("rejects owner collisions and does not auto-steal expired leases", () => {
    const first = claim("task/collision");
    expect(first.ok).toBe(true);

    const collision = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-2",
      runId: "run-2",
      machineId: "machine-1",
      branch: "task/collision",
      owner: "other",
      root,
      idempotencyKey: "collision-other",
    });
    expect(collision.ok).toBe(false);
    expect(collision.code).toBe("owner_collision");

    getDb().query("UPDATE worktree_leases SET expires_at_ms = 1 WHERE lease_id = ?").run(first.lease!.lease_id);
    const stale = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-3",
      runId: "run-3",
      machineId: "machine-1",
      branch: "task/collision",
      owner: "other",
      root,
      idempotencyKey: "collision-stale",
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("stale_owner_rejected");
  });

  it("reserves ownership for unknown future nonterminal statuses", () => {
    const first = claim("task/future-status");
    expect(first.ok).toBe(true);
    getDb().query("UPDATE worktree_leases SET status = 'future_in_progress' WHERE lease_id = ?")
      .run(first.lease!.lease_id);

    const collision = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-future-status-competitor",
      runId: "run-future-status-competitor",
      machineId: "machine-1",
      branch: first.lease!.branch,
      owner: "competitor",
      root,
      idempotencyKey: "future-status-competitor",
    });

    expect(collision.ok).toBe(false);
    expect(collision.code).toBe("owner_collision");
    expect(collision.lease?.lease_id).toBe(first.lease?.lease_id);
  });

  it("blocks collisions while an existing lease is still preparing", () => {
    const branch = "task/preparing-collision";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, "wt_aaaaaaaaaaaaaaaa");
    const now = Date.now();
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path,
      branch, owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("lease-preparing", "hasna/repos", "task-1", "run-1", "machine-1", path,
        branch, "other-owner", "preparing", 1, "token-preparing", "other-key", source, "origin/main",
        now + 300_000, now, now, now, "{}");

    const collision = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-2",
      runId: "run-2",
      machineId: "machine-1",
      branch,
      owner: "pacuvius",
      root,
      idempotencyKey: "new-key",
    });
    expect(collision.ok).toBe(false);
    expect(collision.code).toBe("owner_collision");
    expect(collision.lease?.status).toBe("preparing");
  });

  it("reconciles a persisted preparing lease on idempotent retry", () => {
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, "lease-crash");
    const now = Date.now();
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "lease-crash",
      "hasna/repos",
      "task-crash",
      "run-crash",
      "machine-1",
      path,
      "task/crash",
      "pacuvius",
      "token-crash",
      "idem-crash",
      source,
      "origin/main",
      now + 60000,
      now,
      now,
      now,
      JSON.stringify({ worktree_root: root, claim_base_provenance: "explicit" }),
    );

    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-crash",
      runId: "run-crash",
      machineId: "machine-1",
      branch: "task/crash",
      owner: "pacuvius",
      root,
      baseRef: "origin/main",
      idempotencyKey: "idem-crash",
    });

    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.lease?.status).toBe("active");
    expect(result.git?.is_git_worktree).toBe(true);
  });

  it("excludes concurrent creation owners and resumes a stale owner", () => {
    const leaseId = "lease-creating";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, leaseId);
    const now = Date.now();
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leaseId,
      "hasna/repos",
      "task-creating",
      "run-creating",
      "machine-1",
      path,
      "task/creating",
      "pacuvius",
      "token-creating",
      "idem-creating",
      source,
      "origin/main",
      now + 60_000,
      now,
      now,
      now,
      JSON.stringify({
        worktree_root: root,
        claim_base_provenance: "explicit",
        preparing_completion_token: "other-owner",
        preparing_completion_started_at_ms: now,
      }),
    );
    const options = {
      repo: "hasna/repos",
      source,
      taskId: "task-creating",
      runId: "run-creating",
      machineId: "machine-1",
      branch: "task/creating",
      owner: "pacuvius",
      root,
      baseRef: "origin/main",
      idempotencyKey: "idem-creating",
    };

    const concurrent = claimWorktree(options);
    expect(concurrent.ok).toBe(false);
    expect(concurrent.code).toBe("claim_in_progress");
    expect(concurrent.lease?.status).toBe("creating");
    expect(existsSync(path)).toBe(false);

    getDb().query("UPDATE worktree_leases SET updated_at_ms = 0 WHERE lease_id = ?").run(leaseId);
    const resumed = claimWorktree(options);
    expect(resumed.ok).toBe(true);
    expect(resumed.lease?.status).toBe("active");
    expect(resumed.git?.is_git_worktree).toBe(true);
  });

  it("does not release a stale creating snapshot after a fresh owner takeover", () => {
    const leaseId = "lease-stale-creating-release";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, leaseId);
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, 'hasna/repos', 'task-stale-release', 'run-stale-release', 'machine-1', ?,
      'task/stale-release', 'pacuvius', 'creating', 1, 'token-stale-release',
      'idem-stale-release', ?, 'origin/main', 1, 1, 1, 0, ?)`).run(
      leaseId,
      path,
      source,
      JSON.stringify({
        worktree_root: root,
        preparing_completion_token: "stale-owner",
        preparing_completion_started_at_ms: 0,
      }),
    );
    getDb().query(`INSERT INTO automation_state (key, value, updated_at)
      VALUES ('worktree_leases.clock_ms', '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    getDb().query(`CREATE TRIGGER install_fresh_creating_owner
      AFTER UPDATE ON automation_state
      WHEN NEW.key = 'worktree_leases.clock_ms'
      BEGIN
        UPDATE worktree_leases
        SET updated_at_ms = CAST(NEW.value AS INTEGER),
            metadata_json = json_set(metadata_json,
              '$.preparing_completion_token', 'fresh-owner',
              '$.preparing_completion_started_at_ms', CAST(NEW.value AS INTEGER))
        WHERE lease_id = '${leaseId}';
      END`).run();

    const released = releaseWorktree({
      leaseId,
      generation: 1,
      fencingToken: "token-stale-release",
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("cas_transition_failed");
    expect(released.lease?.status).toBe("creating");
    expect(released.lease?.metadata["preparing_completion_token"]).toBe("fresh-owner");
  });

  it("keeps stale creator cancellation ownership-reserving before a late artifact appears", () => {
    const leaseId = "lease-stale-creator-cancel";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, leaseId);
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, 'hasna/repos', 'task-stale-cancel', 'run-stale-cancel', 'machine-1', ?,
      'task/stale-cancel', 'pacuvius', 'creating', 1, 'token-stale-cancel',
      'idem-stale-cancel', ?, 'origin/main', 1, 1, 1, 0, ?)`).run(
      leaseId,
      path,
      source,
      JSON.stringify({
        worktree_root: root,
        preparing_completion_token: "stale-owner",
        preparing_completion_started_at_ms: 0,
      }),
    );

    const released = releaseWorktree({
      leaseId,
      generation: 1,
      fencingToken: "token-stale-cancel",
    });
    expect(released.ok).toBe(true);
    expect(released.lease?.status).toBe("worktree_failed");
    expect(existsSync(path)).toBe(false);
    const competitor = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-stale-cancel-competitor",
      runId: "run-stale-cancel-competitor",
      machineId: "machine-1",
      branch: "task/stale-cancel",
      owner: "competitor",
      root,
      idempotencyKey: "stale-cancel-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("stale_owner_rejected");
  });

  it("rejects a preparing replay when the existing target has the wrong branch", () => {
    const leaseId = "wt_bbbbbbbbbbbbbbbb";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, leaseId);
    const now = Date.now();
    git(["worktree", "add", "-b", "wrong-branch", path, "origin/main"], source);
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leaseId,
      "hasna/repos",
      "task-wrong-branch",
      "run-wrong-branch",
      "machine-1",
      path,
      "task/right-branch",
      "pacuvius",
      "token-wrong-branch",
      "idem-wrong-branch",
      source,
      "origin/main",
      now + 60_000,
      now,
      now,
      now,
      JSON.stringify({ worktree_root: root, claim_base_provenance: "explicit" }),
    );

    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-wrong-branch",
      runId: "run-wrong-branch",
      machineId: "machine-1",
      branch: "task/right-branch",
      owner: "pacuvius",
      root,
      baseRef: "origin/main",
      idempotencyKey: "idem-wrong-branch",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.message).toContain("branch mismatch");
    expect(result.lease?.status).toBe("preparing");

    const abandoned = releaseWorktree({
      leaseId,
      generation: 1,
      fencingToken: "token-wrong-branch",
    });
    expect(abandoned.ok).toBe(true);
    expect(abandoned.lease?.status).toBe("worktree_failed");
    const competitor = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-wrong-branch-competitor",
      runId: "run-wrong-branch-competitor",
      machineId: "machine-1",
      branch: "task/right-branch",
      owner: "competitor",
      root,
      idempotencyKey: "wrong-branch-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
  });

  it("rejects a URL preparing retry whose clean target forged the requested base ref", () => {
    const leaseId = "wt_cccccccccccccccc";
    const branch = "task/url-preparing-retry";
    const path = defaultWorktreePath({ repo: "hasna/repos", machineId: "machine-1", root }, leaseId);
    git(["clone", source, path], tempDir);
    git(["config", "user.email", "test@example.com"], path);
    git(["config", "user.name", "Test User"], path);
    git(["checkout", "-b", branch, "origin/main"], path);
    writeFileSync(join(path, "forged.txt"), "forged local base\n");
    git(["add", "forged.txt"], path);
    git(["commit", "-m", "forged local base"], path);
    git(["update-ref", "refs/heads/main", "HEAD"], path);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], path);
    const now = Date.now();
    getDb().query(`INSERT INTO worktree_leases (
      lease_id, canonical_repo, task_id, run_id, machine_id, canonical_path, branch,
      owner, status, generation, fencing_token, idempotency_key, source, base_ref,
      expires_at_ms, heartbeat_at_ms, created_at_ms, updated_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leaseId,
      "hasna/repos",
      "task-url-preparing-retry",
      "run-url-preparing-retry",
      "machine-1",
      path,
      branch,
      "pacuvius",
      "token-url-preparing-retry",
      "url-preparing-retry",
      "https://github.com/hasna/repos.git",
      "main",
      now + 60_000,
      now,
      now,
      now,
      JSON.stringify({ worktree_root: root, claim_base_provenance: "explicit" }),
    );

    const result = claimWorktree({
      repo: "hasna/repos",
      source: "https://github.com/hasna/repos.git",
      taskId: "task-url-preparing-retry",
      runId: "run-url-preparing-retry",
      machineId: "machine-1",
      branch,
      owner: "pacuvius",
      root,
      baseRef: "main",
      idempotencyKey: "url-preparing-retry",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree_create_failed");
    expect(result.lease?.status).toBe("preparing");
    expect(result.message).toContain("validated origin");
  });

  it("honors an explicit base when cloning from a URL", () => {
    writeFileSync(join(source, "feature.txt"), "feature\n");
    git(["checkout", "-b", "feature-base"], source);
    git(["add", "feature.txt"], source);
    git(["commit", "-m", "feature base"], source);
    publishBranch(source, "feature-base");
    const expected = git(["rev-parse", "HEAD"], source);

    const result = claimWorktree({
      repo: "hasna/repos",
      source: `file://${join(tempDir, "remote.git")}`,
      taskId: "task-url-base",
      runId: "run-url-base",
      machineId: "machine-1",
      branch: "task/url-base",
      owner: "pacuvius",
      root,
      baseRef: "feature-base",
      idempotencyKey: "url-base",
    });
    expect(result.ok).toBe(true);
    expect(result.git?.head_sha).toBe(expected);
    expect(git(["config", "--local", "--get", "remote.origin.url"], result.lease!.canonical_path))
      .toBe("https://github.com/hasna/repos.git");
  });

  it("uses generation and fencing tokens for renewal and release", () => {
    const first = claim("task/fence");
    expect(first.ok).toBe(true);
    const lease = first.lease!;

    const renewed = renewWorktreeLease({ leaseId: lease.lease_id, generation: lease.generation, fencingToken: lease.fencing_token, ttlSeconds: 60 });
    expect(renewed.ok).toBe(true);
    expect(renewed.lease?.generation).toBe(2);
    expect(renewed.lease?.fencing_token).not.toBe(lease.fencing_token);

    const staleRelease = releaseWorktree({ leaseId: lease.lease_id, generation: lease.generation, fencingToken: lease.fencing_token });
    expect(staleRelease.ok).toBe(false);
    expect(staleRelease.code).toBe("stale_generation");
  });

  it("does not release when HEAD changes during the initial remote proof", () => {
    const result = claim("task/release-head-race");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_RELEASE_HEAD_RACE_MARKER"] = join(tempDir, "release-head-race-marker");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("release_failed");
    expect(released.lease?.status).toBe("worktree_failed");
    expect(released.message).toContain("remote_head_mismatch");
    const localHead = git(["rev-parse", "HEAD"], lease.canonical_path);
    const remoteHead = git(["ls-remote", process.env["HASNA_REPOS_TEST_GIT_REMOTE"]!, `refs/heads/${lease.branch}`], tempDir)
      .split(/\s+/)[0];
    expect(localHead).not.toBe(remoteHead);
    const competitor = importWorktree({
      repo: "hasna/repos",
      taskId: "task-release-head-race-competitor",
      runId: "run-release-head-race-competitor",
      machineId: "machine-1",
      branch: lease.branch,
      owner: "competitor",
      path: lease.canonical_path,
      root,
      idempotencyKey: "release-head-race-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
  });

  it("resumes a plain release that crashed after claiming the proof state", () => {
    const result = claim("task/release-resume");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const expectedHead = git(["rev-parse", "HEAD"], lease.canonical_path);
    getDb().query(`UPDATE worktree_leases
        SET status = 'releasing', head_sha = ?, metadata_json = ?
      WHERE lease_id = ?`).run(
        expectedHead,
        JSON.stringify({
          ...lease.metadata,
          release_expected_head_sha: expectedHead,
          release_finalized: false,
        }),
        lease.lease_id,
      );

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(resumed.ok).toBe(true);
    expect(resumed.lease?.status).toBe("released");
    expect(resumed.lease?.metadata["release_finalized"]).toBe(true);
    expect(resumed.lease?.metadata["release_verified_head_sha"]).toBe(expectedHead);
    getDb().query(`UPDATE worktree_leases
      SET metadata_json = json_remove(
        json_set(metadata_json, '$.release_finalized', json('false')),
        '$.release_finalized_at_ms'
      )
      WHERE lease_id = ?`).run(lease.lease_id);

    const replay = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(replay.ok).toBe(true);
    expect(replay.idempotent).toBe(true);
    expect(replay.lease?.metadata["release_finalized"]).toBe(true);
  });

  it("rejects an intermediate-length object id in a persisted release plan", () => {
    const result = claim("task/release-intermediate-object-id");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const intermediate = "c".repeat(48);
    getDb().query(`UPDATE worktree_leases
        SET status = 'releasing', head_sha = ?, metadata_json = ?
      WHERE lease_id = ?`).run(
        intermediate,
        JSON.stringify({
          ...lease.metadata,
          release_expected_head_sha: intermediate,
          release_finalized: false,
        }),
        lease.lease_id,
      );

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("release_plan_missing");
    expect(resumed.message).toContain("invalid object ID");
    expect(resumed.lease?.status).toBe("worktree_failed");
  });

  it("holds Git mutation locks through terminal release", () => {
    const result = claim("task/release-mutation-lock");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const head = git(["rev-parse", "HEAD"], lease.canonical_path);
    process.env["HASNA_REPOS_TEST_RELEASE_LOCK_COUNTER"] = join(tempDir, "release-lock-counter");
    process.env["HASNA_REPOS_TEST_RELEASE_LOCK_RESULT"] = join(tempDir, "release-lock-result");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(released.ok).toBe(true);
    expect(released.lease?.status).toBe("released");
    expect(readFileSync(process.env["HASNA_REPOS_TEST_RELEASE_LOCK_RESULT"], "utf8").trim()).toBe("blocked");
    expect(git(["rev-parse", "HEAD"], lease.canonical_path)).toBe(head);
  });

  it("keeps release ownership reserved when a terminal Git lock is busy", () => {
    const result = claim("task/release-lock-contention");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const commonDir = resolve(
      lease.canonical_path,
      git(["rev-parse", "--git-common-dir"], lease.canonical_path),
    );
    const refLock = join(commonDir, "refs", "heads", `${lease.branch}.lock`);
    mkdirSync(dirname(refLock), { recursive: true });
    writeFileSync(refLock, "held");

    const blocked = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("terminal_lock_busy");
    expect(blocked.lease?.status).toBe("release_committing");
    const competitor = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-release-lock-competitor",
      runId: "run-release-lock-competitor",
      machineId: "machine-1",
      branch: lease.branch,
      owner: "competitor",
      root,
      idempotencyKey: "release-lock-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
    rmSync(refLock, { force: true });

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.lease?.status).toBe("released");
  });

  it("recovers a control-plane Git lock whose owner process exited", () => {
    const result = claim("task/release-stale-owned-lock");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const commonDir = resolve(
      lease.canonical_path,
      git(["rev-parse", "--git-common-dir"], lease.canonical_path),
    );
    const refLock = join(commonDir, "refs", "heads", `${lease.branch}.lock`);
    mkdirSync(dirname(refLock), { recursive: true });
    const exited = spawnSync("true");
    writeFileSync(refLock, JSON.stringify({
      owner: "hasna-repos-worktree-control-plane",
      pid: exited.pid,
      created_at_ms: Date.now() - 60_000,
    }));
    const orphanedReclaim = `${refLock}.hasna-reclaim`;
    writeFileSync(orphanedReclaim, "orphaned old reclaim guard");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(released.ok).toBe(true);
    expect(released.lease?.status).toBe("released");
    expect(existsSync(refLock)).toBe(false);
    expect(existsSync(orphanedReclaim)).toBe(true);
    rmSync(orphanedReclaim, { force: true });
  });

  it("accepts a valid concurrent plain-release completion from the error path", () => {
    const result = claim("task/release-concurrent-winner");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_RELEASE_WINNER_COUNTER"] = join(tempDir, "release-winner-counter");
    process.env["HASNA_REPOS_TEST_RELEASE_WINNER_DB"] = process.env["HASNA_REPOS_DB_PATH"];
    process.env["HASNA_REPOS_TEST_RELEASE_WINNER_LEASE"] = lease.lease_id;

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(released.ok).toBe(true);
    expect(released.idempotent).toBe(true);
    expect(released.lease?.status).toBe("released");
    expect(released.lease?.metadata["release_finalized"]).toBe(true);
  });

  it("keeps dangling release artifacts ownership-reserving", () => {
    const result = claim("task/dangling-release-artifact");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    const dangling = join(root, "dangling-release-artifact");
    symlinkSync(join(root, "missing-release-target"), dangling);
    getDb().query(`UPDATE worktree_leases
      SET status = 'releasing', canonical_path = ?, worktree_path = ?, metadata_json = ?
      WHERE lease_id = ?`).run(
      dangling,
      dangling,
      JSON.stringify({
        ...lease.metadata,
        release_expected_head_sha: lease.head_sha,
        release_finalized: false,
      }),
      lease.lease_id,
    );

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });

    expect(released.ok).toBe(false);
    expect(released.lease?.status).toBe("worktree_failed");
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  });

  it("refuses dirty, untracked, and unknown-owner states", () => {
    const result = claim("task/safety");
    expect(result.ok).toBe(true);
    writeFileSync(join(result.lease!.canonical_path, "untracked.txt"), "unsafe\n");

    const verify = verifyWorktree({ leaseId: result.lease!.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("untracked_files");

    const release = releaseWorktree({
      leaseId: result.lease!.lease_id,
      generation: result.lease!.generation,
      fencingToken: result.lease!.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");

    const unknown = verifyWorktree({ path: source });
    expect(unknown.ok).toBe(false);
    expect(unknown.issues?.map((issue) => issue.code)).toContain("unknown_owner");
  });

  it("reports all release-blocking git safety states", () => {
    const staged = claim("task/staged");
    expect(staged.ok).toBe(true);
    writeFileSync(join(staged.lease!.canonical_path, "staged.txt"), "unsafe\n");
    git(["add", "staged.txt"], staged.lease!.canonical_path);
    expect(verifyWorktree({ leaseId: staged.lease!.lease_id }).issues?.map((issue) => issue.code)).toContain("staged_changes");

    const modified = claim("task/modified");
    expect(modified.ok).toBe(true);
    writeFileSync(join(modified.lease!.canonical_path, "README.md"), "changed\n");
    expect(verifyWorktree({ leaseId: modified.lease!.lease_id }).issues?.map((issue) => issue.code)).toContain("dirty_changes");

    const detached = claim("task/detached");
    expect(detached.ok).toBe(true);
    git(["checkout", "--detach", "HEAD"], detached.lease!.canonical_path);
    expect(verifyWorktree({ leaseId: detached.lease!.lease_id }).issues?.map((issue) => issue.code)).toContain("detached_head");

    const noUpstream = claim("task/no-upstream");
    expect(noUpstream.ok).toBe(true);
    publishBranch(noUpstream.lease!.canonical_path, noUpstream.lease!.branch);
    git(["branch", "--unset-upstream"], noUpstream.lease!.canonical_path);
    expect(verifyWorktree({ leaseId: noUpstream.lease!.lease_id }).issues?.map((issue) => issue.code)).toContain("no_upstream");

    const ahead = claim("task/ahead");
    expect(ahead.ok).toBe(true);
    publishBranch(ahead.lease!.canonical_path, ahead.lease!.branch);
    writeFileSync(join(ahead.lease!.canonical_path, "ahead.txt"), "ahead\n");
    git(["add", "ahead.txt"], ahead.lease!.canonical_path);
    git(["commit", "-m", "ahead"], ahead.lease!.canonical_path);
    const aheadCodes = verifyWorktree({ leaseId: ahead.lease!.lease_id }).issues?.map((issue) => issue.code);
    expect(aheadCodes).toContain("remote_head_mismatch");
    expect(aheadCodes).toContain("unique_commits");
  }, 10_000);

  it("fails closed when git cleanliness or the validated remote probe fails", () => {
    const unreadableIndex = claim("task/status-probe-failure");
    expect(unreadableIndex.ok).toBe(true);
    const indexPath = resolve(unreadableIndex.lease!.canonical_path, git(["rev-parse", "--git-path", "index"], unreadableIndex.lease!.canonical_path));
    writeFileSync(indexPath, "not a git index\n");
    const statusVerify = verifyWorktree({ leaseId: unreadableIndex.lease!.lease_id });
    expect(statusVerify.ok).toBe(false);
    expect(statusVerify.issues?.map((issue) => issue.code)).toContain("git_status_failed");
    const statusRelease = releaseWorktree({
      leaseId: unreadableIndex.lease!.lease_id,
      generation: unreadableIndex.lease!.generation,
      fencingToken: unreadableIndex.lease!.fencing_token,
    });
    expect(statusRelease.ok).toBe(false);
    expect(statusRelease.code).toBe("unsafe_release_refused");

    const remoteProbe = claim("task/remote-probe-failure");
    expect(remoteProbe.ok).toBe(true);
    publishBranch(remoteProbe.lease!.canonical_path, remoteProbe.lease!.branch);
    process.env["HASNA_REPOS_TEST_LS_REMOTE_FAIL"] = "1";
    const probeVerify = verifyWorktree({ leaseId: remoteProbe.lease!.lease_id });
    expect(probeVerify.ok).toBe(false);
    expect(probeVerify.issues?.map((issue) => issue.code)).toContain("remote_probe_failed");
  }, 10_000);

  it("rejects a forged tracking ref when the branch was never pushed", () => {
    const forged = claim("task/forged-tracking");
    expect(forged.ok).toBe(true);
    const forgedPath = forged.lease!.canonical_path;
    writeFileSync(join(forgedPath, "forged.txt"), "not pushed\n");
    git(["add", "forged.txt"], forgedPath);
    git(["commit", "-m", "forged local commit"], forgedPath);
    const forgedHead = git(["rev-parse", "HEAD"], forgedPath);
    git(["update-ref", `refs/remotes/origin/${forged.lease!.branch}`, forgedHead], forgedPath);
    git(["config", `branch.${forged.lease!.branch}.remote`, "origin"], forgedPath);
    git(["config", `branch.${forged.lease!.branch}.merge`, `refs/heads/${forged.lease!.branch}`], forgedPath);
    const forgedVerify = verifyWorktree({ leaseId: forged.lease!.lease_id });
    expect(forgedVerify.ok).toBe(false);
    expect(forgedVerify.issues?.map((issue) => issue.code)).toContain("remote_branch_missing");
  });

  it("accepts exact remote proof despite a corrupt local tracking ref", () => {
    const stale = claim("task/stale-tracking");
    expect(stale.ok).toBe(true);
    publishBranch(stale.lease!.canonical_path, stale.lease!.branch);
    writeFileSync(join(stale.lease!.canonical_path, "published.txt"), "published without tracking update\n");
    git(["add", "published.txt"], stale.lease!.canonical_path);
    git(["commit", "-m", "published with stale tracking"], stale.lease!.canonical_path);
    git(["push", "--force", join(tempDir, "remote.git"), `HEAD:refs/heads/${stale.lease!.branch}`], stale.lease!.canonical_path);
    const staleCommonDir = resolve(stale.lease!.canonical_path, git(["rev-parse", "--git-common-dir"], stale.lease!.canonical_path));
    const staleTrackingRef = join(staleCommonDir, "refs", "remotes", "origin", stale.lease!.branch);
    mkdirSync(dirname(staleTrackingRef), { recursive: true });
    writeFileSync(staleTrackingRef, `${"a".repeat(40)}\n`);
    const staleVerify = verifyWorktree({ leaseId: stale.lease!.lease_id });
    expect(staleVerify.ok).toBe(true);
  });

  it("rejects a remote force-push away from the exact leased HEAD", () => {
    const forcePushed = claim("task/force-pushed-away");
    expect(forcePushed.ok).toBe(true);
    publishBranch(forcePushed.lease!.canonical_path, forcePushed.lease!.branch);
    writeFileSync(join(source, "remote-replacement.txt"), "different remote head\n");
    git(["add", "remote-replacement.txt"], source);
    git(["commit", "-m", "different remote head"], source);
    git(["push", "--force", join(tempDir, "remote.git"), `HEAD:refs/heads/${forcePushed.lease!.branch}`], source);
    const forcePushedVerify = verifyWorktree({ leaseId: forcePushed.lease!.lease_id });
    expect(forcePushedVerify.ok).toBe(false);
    expect(forcePushedVerify.issues?.map((issue) => issue.code)).toContain("remote_head_mismatch");
  });

  it("rejects a deleted remote branch despite a stale tracking ref", () => {
    const deleted = claim("task/remote-deleted");
    expect(deleted.ok).toBe(true);
    publishBranch(deleted.lease!.canonical_path, deleted.lease!.branch);
    git(["push", join(tempDir, "remote.git"), `:refs/heads/${deleted.lease!.branch}`], deleted.lease!.canonical_path);
    const deletedVerify = verifyWorktree({ leaseId: deleted.lease!.lease_id });
    expect(deletedVerify.ok).toBe(false);
    expect(deletedVerify.issues?.map((issue) => issue.code)).toContain("remote_branch_missing");
  });

  it("rejects a non-origin configured upstream", () => {
    const nonOrigin = claim("task/non-origin-upstream");
    expect(nonOrigin.ok).toBe(true);
    publishBranch(nonOrigin.lease!.canonical_path, nonOrigin.lease!.branch);
    git(["remote", "add", "backup", join(tempDir, "remote.git")], nonOrigin.lease!.canonical_path);
    git(["update-ref", `refs/remotes/backup/${nonOrigin.lease!.branch}`, nonOrigin.lease!.head_sha!], nonOrigin.lease!.canonical_path);
    git(["config", `branch.${nonOrigin.lease!.branch}.remote`, "backup"], nonOrigin.lease!.canonical_path);
    const nonOriginVerify = verifyWorktree({ leaseId: nonOrigin.lease!.lease_id });
    expect(nonOriginVerify.ok).toBe(false);
    expect(nonOriginVerify.issues?.map((issue) => issue.code)).toContain("non_origin_upstream");
  });

  it("rejects import branch mismatch and lease branch drift", () => {
    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-import",
      runId: "run-import",
      machineId: "machine-1",
      branch: "not-main",
      owner: "pacuvius",
      path: source,
      root: tempDir,
      idempotencyKey: "import-mismatch",
    });
    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("branch_mismatch");

    const result = claim("task/branch-drift");
    expect(result.ok).toBe(true);
    git(["switch", "-c", "other-branch"], result.lease!.canonical_path);

    const verify = verifyWorktree({ leaseId: result.lease!.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("branch_mismatch");
  });

  it("rejects an imported worktree whose origin does not match the requested repo", () => {
    const importedPath = join(root, "wrong-repo");
    git(["clone", source, importedPath], tempDir);
    git(["checkout", "-b", "task/import-wrong-repo", "--track", "origin/main"], importedPath);
    git(["remote", "set-url", "origin", "ssh://git@evil.example/hasna/repos.git"], importedPath);
    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-import-wrong-repo",
      runId: "run-import-wrong-repo",
      machineId: "machine-1",
      branch: "task/import-wrong-repo",
      owner: "pacuvius",
      path: importedPath,
      root,
    });
    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("repo_mismatch");
  });

  it("blocks verify and release after repository identity drift", () => {
    const result = claim("task/repo-drift");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    git(["remote", "set-url", "origin", "https://evil.example/hasna/repos.git"], lease.canonical_path);
    git(["config", "--local", "url.https://github.com/.insteadOf", "https://evil.example/"], lease.canonical_path);
    expect(git(["remote", "get-url", "origin"], lease.canonical_path)).toBe("https://github.com/hasna/repos.git");
    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");
  });

  it("blocks verify and release after raw push URL drift", () => {
    const result = claim("task/push-url-drift");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    git(["remote", "set-url", "--add", "--push", "origin", "ssh://git@evil.example/hasna/repos.git"], lease.canonical_path);
    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");
  });

  it("blocks verify and release when origin has a custom upload-pack command", () => {
    const result = claim("task/custom-upload-pack");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    git(["config", "--local", "remote.origin.uploadpack", "/bin/false"], lease.canonical_path);

    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");
  });

  it("blocks verify and release when the repository sets core.sshCommand", () => {
    const result = claim("task/local-ssh-command");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    git(["config", "--local", "core.sshCommand", "/bin/false"], lease.canonical_path);

    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");
  });

  it("rejects transport controls inherited through local Git includes", () => {
    const included = join(tempDir, "included-transport.config");
    writeFileSync(included, `[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/\n`);
    git(["config", "--local", "include.path", included], source);
    expect(git(["remote", "get-url", "origin"], source)).toBe("ssh://git@github.com/hasna/repos.git");

    const result = claim("task/included-transport");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("source_repo_mismatch");
    expect(getDb().query("SELECT count(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
  });

  it("blocks verify and release after an included transport command is added", () => {
    const result = claim("task/included-transport-after-claim");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const included = join(tempDir, "included-upload-pack.config");
    writeFileSync(included, `[remote "origin"]\n\tuploadpack = /bin/false\n`);
    git(["config", "--local", "include.path", included], lease.canonical_path);

    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_release_refused");
  });

  it("rejects per-worktree transport controls and remote helpers", () => {
    const result = claim("task/worktree-transport-config");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    git(["config", "extensions.worktreeConfig", "true"], lease.canonical_path);
    git(["config", "--worktree", "core.sshCommand", "/bin/false"], lease.canonical_path);

    const sshVerify = verifyWorktree({ leaseId: lease.lease_id });
    expect(sshVerify.ok).toBe(false);
    expect(sshVerify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");

    git(["config", "--worktree", "--unset", "core.sshCommand"], lease.canonical_path);
    git(["config", "--worktree", "remote.origin.vcs", "untrusted-helper"], lease.canonical_path);
    const helperVerify = verifyWorktree({ leaseId: lease.lease_id });
    expect(helperVerify.ok).toBe(false);
    expect(helperVerify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
  });

  it("rejects repository HTTP transport overrides", () => {
    const result = claim("task/http-transport-config");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    git(["config", "extensions.worktreeConfig", "true"], lease.canonical_path);
    git(["config", "--worktree", "http.curloptResolve", "github.com:443:127.0.0.1"], lease.canonical_path);

    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(false);
    expect(verify.issues?.map((issue) => issue.code)).toContain("repo_mismatch");
  });

  it("removes inherited proxy and CA controls from network Git probes", () => {
    const result = claim("task/sanitized-transport-environment");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    for (const key of transportEnvKeys) process.env[key] = `${key.toLowerCase()}-must-not-reach-git`;
    process.env["HASNA_REPOS_TEST_REQUIRE_SANITIZED_TRANSPORT_ENV"] = "1";

    const verify = verifyWorktree({ leaseId: lease.lease_id });
    expect(verify.ok).toBe(true);
  });

  it("rejects included and per-worktree non-origin upstream overrides", () => {
    for (const scope of ["included", "worktree"] as const) {
      const result = claim(`task/${scope}-upstream`);
      expect(result.ok).toBe(true);
      const lease = result.lease!;
      const backupRemote = `backup-${scope}`;
      publishBranch(lease.canonical_path, lease.branch);
      git(["remote", "add", backupRemote, join(tempDir, "remote.git")], lease.canonical_path);
      git(["update-ref", `refs/remotes/${backupRemote}/${lease.branch}`, lease.head_sha!], lease.canonical_path);
      if (scope === "included") {
        const included = join(tempDir, `${scope}-upstream.config`);
        writeFileSync(included, `[branch "${lease.branch}"]\n\tremote = ${backupRemote}\n\tmerge = refs/heads/${lease.branch}\n`);
        git(["config", "--local", "include.path", included], lease.canonical_path);
      } else {
        git(["config", "extensions.worktreeConfig", "true"], lease.canonical_path);
        git(["config", "--worktree", `branch.${lease.branch}.remote`, backupRemote], lease.canonical_path);
        git(["config", "--worktree", `branch.${lease.branch}.merge`, `refs/heads/${lease.branch}`], lease.canonical_path);
      }
      expect(git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], lease.canonical_path))
        .toBe(`${backupRemote}/${lease.branch}`);

      const verify = verifyWorktree({ leaseId: lease.lease_id });
      expect(verify.ok).toBe(false);
      expect(verify.issues?.map((issue) => issue.code)).toContain("non_origin_upstream");
    }
  });

  it("rejects protected branch imports", () => {
    const importedPath = join(root, "protected-import");
    git(["clone", source, importedPath], tempDir);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], importedPath);
    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-protected-import",
      runId: "run-protected-import",
      machineId: "machine-1",
      branch: "main",
      owner: "pacuvius",
      path: importedPath,
      root,
    });
    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("protected_branch");
  });

  it("rejects blank import identity fields and paths before resolving or persisting them", () => {
    const base = {
      repo: "hasna/repos",
      taskId: "task-import-required",
      runId: "run-import-required",
      machineId: "machine-1",
      branch: "task/import-required",
      owner: "pacuvius",
      path: join(root, "required-import"),
      root,
    };
    for (const field of ["taskId", "runId", "machineId", "owner"] as const) {
      const imported = importWorktree({ ...base, [field]: " \t " });
      expect(imported.ok).toBe(false);
      expect(imported.code).toBe("missing_required_key");
    }
    const blankPath = importWorktree({ ...base, path: " \t " });
    expect(blankPath.ok).toBe(false);
    expect(blankPath.code).toBe("missing_required_path");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases").get()).toEqual({ count: 0 });
    expect(existsSync(root)).toBe(false);
  });

  it("rejects the live repository default branch even when its name is not statically protected", () => {
    const importedPath = join(root, "protected-default-import");
    git(["clone", source, importedPath], tempDir);
    git(["checkout", "-b", "stable", "--track", "origin/main"], importedPath);
    git(["push", join(tempDir, "remote.git"), "HEAD:refs/heads/stable"], importedPath);
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/stable"], tempDir);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], importedPath);

    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-protected-default-import",
      runId: "run-protected-default-import",
      machineId: "machine-1",
      branch: "stable",
      owner: "pacuvius",
      path: importedPath,
      root,
    });

    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("protected_branch");
  });

  it("fails closed when origin HEAD cannot prove the live repository default branch", () => {
    const importedPath = join(root, "unverified-default-import");
    git(["clone", source, importedPath], tempDir);
    git(["checkout", "-b", "task/import-unverified-default", "--track", "origin/main"], importedPath);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], importedPath);
    process.env["HASNA_REPOS_TEST_LS_REMOTE_FAIL"] = "1";

    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-unverified-default-import",
      runId: "run-unverified-default-import",
      machineId: "machine-1",
      branch: "task/import-unverified-default",
      owner: "pacuvius",
      path: importedPath,
      root,
    });

    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("remote_default_branch_unverified");
  });

  it("re-proves the live default immediately before import activation and can retry after recovery", () => {
    const importedPath = join(root, "default-race-import");
    const branch = "task/import-default-race";
    git(["clone", source, importedPath], tempDir);
    git(["checkout", "-b", branch, "--track", "origin/main"], importedPath);
    git(["push", join(tempDir, "remote.git"), `HEAD:refs/heads/${branch}`], importedPath);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], importedPath);
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"] = join(tempDir, "import-default-probe-counter");
    process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"] = branch;

    const options = {
      repo: "hasna/repos",
      taskId: "task-import-default-race",
      runId: "run-import-default-race",
      machineId: "machine-1",
      branch,
      owner: "pacuvius",
      path: importedPath,
      root,
      idempotencyKey: "import-default-race",
    };
    const imported = importWorktree(options);

    expect(imported.ok).toBe(false);
    expect(imported.code).toBe("protected_branch");
    expect(imported.lease?.status).toBe("preparing");
    expect(getDb().query("SELECT COUNT(*) AS count FROM worktree_leases WHERE status = 'active'").get())
      .toEqual({ count: 0 });

    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_COUNTER"];
    delete process.env["HASNA_REPOS_TEST_DEFAULT_PROBE_SWITCH_BRANCH"];
    git(["--git-dir", join(tempDir, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main"], tempDir);
    const recovered = importWorktree(options);
    expect(recovered.ok).toBe(true);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.lease?.lease_id).toBe(imported.lease?.lease_id);
  });

  it("imports an existing safe worktree idempotently and includes it in inventory", () => {
    const importedPath = join(root, "imported-main");
    git(["clone", source, importedPath], tempDir);
    git(["checkout", "-b", "task/import-safe", "--track", "origin/main"], importedPath);
    git(["remote", "set-url", "origin", "https://github.com/hasna/repos.git"], importedPath);

    const imported = importWorktree({
      repo: "hasna/repos",
      taskId: "task-import-safe",
      runId: "run-import-safe",
      machineId: "machine-1",
      branch: "task/import-safe",
      owner: "pacuvius",
      path: importedPath,
      root,
      idempotencyKey: "import-safe",
    });
    expect(imported.ok).toBe(true);
    expect(imported.lease?.canonical_path).toBe(importedPath);
    expect(imported.lease?.metadata["created_by"]).toBe("repos.worktrees.import");
    getDb().query("UPDATE worktree_leases SET status = 'preparing', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...imported.lease!.metadata, created_by: "repos.worktrees.claim" }), imported.lease!.lease_id);

    const replay = importWorktree({
      repo: "hasna/repos",
      taskId: "task-import-safe",
      runId: "run-import-safe",
      machineId: "machine-1",
      branch: "task/import-safe",
      owner: "pacuvius",
      path: importedPath,
      root,
      idempotencyKey: "import-safe",
    });
    expect(replay.ok).toBe(true);
    expect(replay.idempotent).toBe(true);
    expect(replay.lease?.lease_id).toBe(imported.lease?.lease_id);
    expect(replay.lease?.status).toBe("active");
    expect(replay.lease?.metadata["created_by"]).toBe("repos.worktrees.import");

    const inventory = inventoryWorktrees({ root });
    expect(inventory.discovered.map((entry) => entry.path)).toContain(importedPath);
    expect(inventory.leases.map((lease) => lease?.lease_id)).toContain(imported.lease?.lease_id);
    publishBranch(importedPath, imported.lease!.branch);

    const quarantined = releaseWorktree({
      leaseId: imported.lease!.lease_id,
      generation: imported.lease!.generation,
      fencingToken: imported.lease!.fencing_token,
      cleanup: "quarantine",
    });
    expect(quarantined.ok).toBe(true);
    expect(String(quarantined.lease?.canonical_path).startsWith(`${join(root, ".quarantine")}/`)).toBe(true);
  }, 10_000);

  it("refuses quarantine cleanup for a migrated legacy-layout lease", () => {
    const result = claim("task/legacy-layout");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    getDb().query("UPDATE worktree_leases SET metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, legacy_layout: true }), lease.lease_id);

    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("legacy_layout_cleanup_refused");
    expect(release.lease?.status).toBe("active");
  });

  it("quarantines a clean released worktree and records a backup ref", () => {
    const result = claim("task/quarantine");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);

    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(release).toEqual(expect.objectContaining({ ok: true }));
    expect(release.lease?.status).toBe("quarantined");
    const backupRef = release.lease?.metadata["backup_ref"];
    const quarantinePath = release.lease?.metadata["quarantine_path"];
    expect(typeof backupRef).toBe("string");
    expect(typeof quarantinePath).toBe("string");
    expect(String(quarantinePath).startsWith(`${join(root, ".quarantine")}/`)).toBe(true);
    expect(String(quarantinePath).startsWith(`${lease.canonical_path}/`)).toBe(false);
    expect(() => git(["show-ref", "--verify", String(backupRef)], String(quarantinePath))).not.toThrow();
    const registered = git(["worktree", "list", "--porcelain"], source);
    expect(registered).toContain(`worktree ${String(quarantinePath)}`);
    expect(registered).not.toContain(`worktree ${lease.canonical_path}\n`);
    getDb().query(`UPDATE worktree_leases
      SET metadata_json = json_remove(
        json_set(metadata_json, '$.quarantine_finalized', json('false')),
        '$.quarantine_finalized_at_ms'
      )
      WHERE lease_id = ?`).run(lease.lease_id);
    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.idempotent).toBe(true);
    expect(resumed.lease?.metadata["quarantine_finalized"]).toBe(true);
  });

  it("locks the canonical backup ref through terminal quarantine success", () => {
    const result = claim("task/quarantine-backup-lock");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    writeFileSync(join(source, "backup-lock-race.txt"), "backup lock race\n");
    git(["add", "backup-lock-race.txt"], source);
    git(["commit", "-m", "backup lock race"], source);
    const replacement = git(["rev-parse", "HEAD"], source);
    process.env["HASNA_REPOS_TEST_BACKUP_LOCK_COUNTER"] = join(tempDir, "backup-lock-counter");
    process.env["HASNA_REPOS_TEST_BACKUP_LOCK_SHA"] = replacement;
    process.env["HASNA_REPOS_TEST_BACKUP_LOCK_RESULT"] = join(tempDir, "backup-lock-result");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(released.ok).toBe(true);
    expect(released.lease?.status).toBe("quarantined");
    expect(readFileSync(process.env["HASNA_REPOS_TEST_BACKUP_LOCK_RESULT"], "utf8").trim()).toBe("blocked");
    expect(git(["rev-parse", String(released.lease!.metadata["backup_ref"])], source))
      .toBe(released.lease?.head_sha);
  });

  it("compensates when the remote branch moves during post-terminal quarantine proof", () => {
    const result = claim("task/quarantine-post-terminal-remote");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    writeFileSync(join(source, "remote-race.txt"), "remote race\n");
    git(["add", "remote-race.txt"], source);
    git(["commit", "-m", "remote race"], source);
    const replacement = git(["rev-parse", "HEAD"], source);
    git(["push", process.env["HASNA_REPOS_TEST_GIT_REMOTE"]!, "main"], source);
    process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER"] = join(tempDir, "post-terminal-remote-counter");
    process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_BRANCH"] = lease.branch;
    process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_SHA"] = replacement;

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(readFileSync(process.env["HASNA_REPOS_TEST_POST_TERMINAL_REMOTE_COUNTER"], "utf8").trim()).toBe("4");
    const remoteAfter = git([
      "ls-remote",
      process.env["HASNA_REPOS_TEST_GIT_REMOTE"]!,
      `refs/heads/${lease.branch}`,
    ], tempDir).split(/\s+/)[0];
    expect(remoteAfter).toBe(replacement);
    expect(released.ok).toBe(false);
    expect(released.code).toBe("quarantine_failed");
    expect(released.lease?.status).toBe("quarantine_failed");
    expect(remoteAfter).toBe(replacement);
  }, 10_000);

  it("resumes quarantine after a crash between the filesystem move and database completion", () => {
    const result = claim("task/quarantine-resume");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "crash-test",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    mkdirSync(join(planned, ".."), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.lease?.status).toBe("quarantined");
    expect(resumed.lease?.canonical_path).toBe(planned);
    expect(resumed.lease?.metadata["backup_ref"]).toBe(plannedRef);
  });

  it("resumes a proved quarantine that crashed during finalization", () => {
    const result = claim("task/quarantine-finalizing-resume");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "finalizing-resume",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    const provedHead = git(["rev-parse", "HEAD"], planned);
    git(["update-ref", plannedRef, provedHead], planned);
    getDb().query(`UPDATE worktree_leases
        SET status = 'quarantine_finalizing', head_sha = ?, metadata_json = ?
      WHERE lease_id = ?`).run(
        provedHead,
        JSON.stringify({
          ...lease.metadata,
          planned_quarantine_path: planned,
          planned_backup_ref: plannedRef,
          backup_ref: plannedRef,
          quarantine_path: planned,
          verified_head_sha: provedHead,
          quarantine_finalized: false,
        }),
        lease.lease_id,
      );

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(true);
    expect(resumed.lease?.status).toBe("quarantined");
    expect(resumed.lease?.canonical_path).toBe(planned);
    expect(resumed.lease?.metadata["quarantine_finalized"]).toBe(true);
  });

  it("revalidates release safety before completing a moved quarantine retry", () => {
    const result = claim("task/quarantine-resume-drift");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "resume-drift",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    writeFileSync(join(planned, "unpushed.txt"), "not published\n");
    git(["add", "unpushed.txt"], planned);
    git(["commit", "-m", "unpushed after quarantine lock"], planned);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.message).toContain("remote_head_mismatch");
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(existsSync(lease.canonical_path)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("rolls back a worktree move that reports failure after moving", () => {
    const result = claim("task/quarantine-move-report-failure");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_WORKTREE_MOVE_FAIL_AFTER_MOVE"] = "1";

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("quarantine_failed");
    expect(released.message).toContain("simulated failure after worktree move");
    expect(released.lease?.status).toBe("active");
    expect(existsSync(lease.canonical_path)).toBe(true);
    const planned = String(released.lease?.metadata["planned_quarantine_path"]);
    expect(planned.startsWith(`${join(root, ".quarantine")}/`)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("revalidates safety at the quarantine path after moving", () => {
    const result = claim("task/quarantine-post-move-race");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_MUTATE_AFTER_WORKTREE_MOVE"] = "1";

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("quarantine_failed");
    expect(released.message).toContain("untracked_files");
    expect(released.lease?.status).toBe("quarantine_failed");
    expect(existsSync(lease.canonical_path)).toBe(true);
  });

  it("keeps uniqueness reserved while quarantine rollback is in progress", () => {
    const result = claim("task/quarantine-rollback-claim-race");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const competitorResultPath = join(tempDir, "rollback-competitor-result.json");
    process.env["HASNA_REPOS_TEST_MUTATE_AFTER_WORKTREE_MOVE"] = "1";
    process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_RESULT"] = competitorResultPath;
    process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_SOURCE"] = source;
    process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_BRANCH"] = lease.branch;
    process.env["HASNA_REPOS_TEST_ROLLBACK_CLAIM_ROOT"] = root;
    process.env["HASNA_REPOS_TEST_WORKTREES_MODULE"] = join(import.meta.dir, "worktrees.ts");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    const competitor = JSON.parse(readFileSync(competitorResultPath, "utf8")) as {
      ok: boolean;
      code?: string;
    };
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
    expect(getDb().query("SELECT count(*) AS count FROM worktree_leases WHERE lease_id != ?").get(lease.lease_id))
      .toEqual({ count: 0 });
    expect(released.ok).toBe(false);
    expect(released.lease?.status).toBe("quarantine_failed");
    expect(existsSync(lease.canonical_path)).toBe(true);
    const after = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-after-quarantine-failure",
      runId: "run-after-quarantine-failure",
      machineId: "machine-1",
      branch: lease.branch,
      owner: "competitor",
      root,
      idempotencyKey: "after-quarantine-failure",
    });
    expect(after.ok).toBe(false);
    expect(after.code).toBe("owner_collision");
    expect(after.lease?.lease_id).toBe(lease.lease_id);
  });

  it("serializes a concurrent quarantine retry across the filesystem move", () => {
    const result = claim("task/quarantine-concurrent-retry");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const retryResultPath = join(tempDir, "quarantine-retry-result.json");
    process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_RESULT"] = retryResultPath;
    process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_LEASE"] = lease.lease_id;
    process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_GENERATION"] = String(lease.generation);
    process.env["HASNA_REPOS_TEST_QUARANTINE_RETRY_FENCE"] = lease.fencing_token;
    process.env["HASNA_REPOS_TEST_WORKTREES_MODULE"] = join(import.meta.dir, "worktrees.ts");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    const retry = JSON.parse(readFileSync(retryResultPath, "utf8")) as {
      ok: boolean;
      code?: string;
    };

    expect(retry.ok).toBe(false);
    expect(retry.code).toBe("terminal_lock_busy");
    expect(released.ok).toBe(true);
    expect(released.lease?.status).toBe("quarantined");
  });

  it("resumes quarantine compensation after a crash before rollback", () => {
    const result = claim("task/quarantine-compensation-resume");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "compensation-resume",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    getDb().query("UPDATE worktree_leases SET status = 'quarantine_compensating', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({
        ...lease.metadata,
        planned_quarantine_path: planned,
        planned_backup_ref: plannedRef,
        quarantine_error: "simulated crash before rollback",
        quarantine_finalization_claimed: false,
      }), lease.lease_id);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("active");
    expect(existsSync(lease.canonical_path)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("serializes a direct quarantine compensation retry before rollback and CAS", () => {
    const result = claim("task/quarantine-compensation-lock");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "compensation-lock",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    getDb().query("UPDATE worktree_leases SET status = 'quarantine_compensating', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({
        ...lease.metadata,
        planned_quarantine_path: planned,
        planned_backup_ref: plannedRef,
        quarantine_error: "simulated crash before locked rollback",
        quarantine_finalization_claimed: false,
      }), lease.lease_id);
    const operationLock = join(
      root,
      ".control-plane-locks",
      `quarantine-${lease.lease_id}-${lease.generation}.lock`,
    );
    mkdirSync(dirname(operationLock), { recursive: true });
    writeFileSync(operationLock, JSON.stringify({
      owner: "hasna-repos-worktree-control-plane",
      pid: process.pid,
      created_at_ms: Date.now(),
    }));

    const blocked = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("terminal_lock_busy");
    expect(blocked.lease?.status).toBe("quarantine_compensating");
    expect(existsSync(lease.canonical_path)).toBe(false);
    expect(existsSync(planned)).toBe(true);

    rmSync(operationLock, { force: true });
    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("active");
    expect(existsSync(lease.canonical_path)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("binds backup creation to the exact post-move proved HEAD", () => {
    const result = claim("task/quarantine-backup-head-race");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_BACKUP_HEAD_COUNTER"] = join(tempDir, "backup-head-counter");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("quarantine_failed");
    expect(released.message).toContain("HEAD changed after quarantine safety proof");
    expect(released.lease?.status).toBe("quarantine_failed");
    expect(existsSync(lease.canonical_path)).toBe(true);
    const backupRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    expect(() => git(["show-ref", "--verify", backupRef], lease.canonical_path)).toThrow();
  });

  it("compensates when the quarantine proof changes after the completion CAS", () => {
    const result = claim("task/quarantine-post-cas-race");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    process.env["HASNA_REPOS_TEST_POST_CAS_PROOF_COUNTER"] = join(tempDir, "post-cas-proof-counter");

    const released = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(released.ok).toBe(false);
    expect(released.code).toBe("quarantine_failed");
    expect(released.message).toContain("quarantine proof changed after finalization CAS");
    expect(released.lease?.status).toBe("quarantine_failed");
    expect(released.lease?.canonical_path).toBe(lease.canonical_path);
    expect(existsSync(lease.canonical_path)).toBe(true);
  });

  it("does not report an unfinalized competing quarantine as success", () => {
    const result = claim("task/quarantine-competing-completion");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "competing-completion",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_DB"] = process.env["HASNA_REPOS_DB_PATH"];
    process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_PATH"] = planned;
    process.env["HASNA_REPOS_TEST_QUARANTINE_WINNER_LEASE"] = lease.lease_id;

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("cas_transition_failed");
    expect(resumed.lease?.status).toBe("quarantined");
    expect(resumed.lease?.canonical_path).toBe(planned);
    expect(existsSync(planned)).toBe(true);
    expect(existsSync(lease.canonical_path)).toBe(false);
  });

  it("marks a quarantining lease with no recovery plan as failed", () => {
    const result = claim("task/quarantine-plan-missing");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ worktree_root: root }), lease.lease_id);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_plan_missing");
    expect(resumed.lease?.status).toBe("worktree_failed");
    const competitor = importWorktree({
      repo: "hasna/repos",
      taskId: "task-missing-plan-competitor",
      runId: "run-missing-plan-competitor",
      machineId: "machine-1",
      branch: lease.branch,
      owner: "competitor",
      path: lease.canonical_path,
      root,
      idempotencyKey: "missing-plan-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
  });

  it("rejects a recovery path outside the lease-specific quarantine shape", () => {
    const result = claim("task/quarantine-wrong-lease-path");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const wrongLeasePath = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      "wt_not_this_lease",
      "wrong-lease",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({
        ...lease.metadata,
        planned_quarantine_path: wrongLeasePath,
        planned_backup_ref: plannedRef,
      }), lease.lease_id);
    mkdirSync(dirname(wrongLeasePath), { recursive: true });
    git(["worktree", "move", lease.canonical_path, wrongLeasePath], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(existsSync(wrongLeasePath)).toBe(true);
    expect(existsSync(lease.canonical_path)).toBe(false);
    const competitor = importWorktree({
      repo: "hasna/repos",
      taskId: "task-wrong-lease-path-competitor",
      runId: "run-wrong-lease-path-competitor",
      machineId: "machine-1",
      branch: lease.branch,
      owner: "competitor",
      path: wrongLeasePath,
      root,
      idempotencyKey: "wrong-lease-path-competitor",
    });
    expect(competitor.ok).toBe(false);
    expect(competitor.code).toBe("owner_collision");
    expect(competitor.lease?.lease_id).toBe(lease.lease_id);
  });

  it("never trusts quarantine metadata to overwrite a protected branch ref", () => {
    const result = claim("task/quarantine-protected-ref");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    const mainBefore = git(["rev-parse", "refs/heads/main"], source);
    writeFileSync(join(lease.canonical_path, "unique.txt"), "unique quarantine head\n");
    git(["add", "unique.txt"], lease.canonical_path);
    git(["commit", "-m", "unique quarantine head"], lease.canonical_path);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "protected-ref",
      "repo",
    );
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({
        ...lease.metadata,
        planned_quarantine_path: planned,
        planned_backup_ref: "refs/heads/main",
      }), lease.lease_id);
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(resumed.message).toContain("backup ref");
    expect(git(["rev-parse", "refs/heads/main"], source)).toBe(mainBefore);
  });

  it("does not overwrite a conflicting canonical quarantine backup ref", () => {
    const result = claim("task/quarantine-backup-ref-cas");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    const preservedHead = git(["rev-parse", "refs/heads/main"], source);
    writeFileSync(join(lease.canonical_path, "unique-cas.txt"), "unique quarantine CAS head\n");
    git(["add", "unique-cas.txt"], lease.canonical_path);
    git(["commit", "-m", "unique quarantine CAS head"], lease.canonical_path);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "backup-ref-cas",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    git(["update-ref", plannedRef, preservedHead], source);
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(git(["rev-parse", plannedRef], source)).toBe(preservedHead);
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(existsSync(lease.canonical_path)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("rejects a symbolic canonical quarantine backup ref", () => {
    const result = claim("task/quarantine-symbolic-backup-ref");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "symbolic-backup-ref",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    git(["symbolic-ref", plannedRef, "refs/heads/main"], source);
    mkdirSync(dirname(planned), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.message).toContain("symbolic");
    expect(git(["symbolic-ref", "--no-recurse", plannedRef], source)).toBe("refs/heads/main");
    expect(resumed.lease?.status).toBe("active");
    expect(existsSync(lease.canonical_path)).toBe(true);
    expect(existsSync(planned)).toBe(false);
  });

  it("rejects a provisional quarantine backup-ref path escape before locking", () => {
    const result = claim("task/quarantine-lock-path-escape");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const quarantined = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(quarantined.ok).toBe(true);
    getDb().query(`UPDATE worktree_leases
      SET metadata_json = json_remove(
        json_set(
          metadata_json,
          '$.quarantine_finalized', json('false'),
          '$.backup_ref', '../../escape/probe'
        ),
        '$.quarantine_finalized_at_ms'
      )
      WHERE lease_id = ?`).run(lease.lease_id);
    const commonDir = resolve(
      quarantined.lease!.canonical_path,
      git(["rev-parse", "--git-common-dir"], quarantined.lease!.canonical_path),
    );
    const escapedLock = resolve(commonDir, "../../escape/probe.lock");

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(existsSync(escapedLock)).toBe(false);
  });

  it("keeps both-missing quarantine recovery terminally failed", () => {
    const result = claim("task/quarantine-both-missing");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "both-missing",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    git(["worktree", "remove", "--force", lease.canonical_path], source);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("failed");
    expect(inspectWorktree({ leaseId: lease.lease_id }).lease?.status).toBe("failed");
  });

  it("fails quarantine recovery when the moved target has the wrong repository identity", () => {
    const result = claim("task/quarantine-identity-drift");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const planned = join(
      root,
      ".quarantine",
      "machine-1",
      "repos-dd2673d92bfc",
      lease.lease_id,
      "identity-drift",
      "repo",
    );
    const plannedRef = `refs/hasna/worktrees/${lease.lease_id}/${lease.generation}`;
    getDb().query("UPDATE worktree_leases SET status = 'quarantining', metadata_json = ? WHERE lease_id = ?")
      .run(JSON.stringify({ ...lease.metadata, planned_quarantine_path: planned, planned_backup_ref: plannedRef }), lease.lease_id);
    mkdirSync(join(planned, ".."), { recursive: true });
    git(["worktree", "move", lease.canonical_path, planned], source);
    git(["remote", "set-url", "origin", "https://github.com/hasna/other.git"], planned);

    const resumed = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.code).toBe("quarantine_failed");
    expect(resumed.lease?.status).toBe("quarantine_failed");
    expect(resumed.message).toContain("repo_mismatch");
    expect(() => git(["rev-parse", "--show-toplevel"], planned)).not.toThrow();
  });

  it("refuses quarantine when an ancestor redirects outside the trusted root", () => {
    const result = claim("task/quarantine-symlink");
    expect(result.ok).toBe(true);
    const lease = result.lease!;
    publishBranch(lease.canonical_path, lease.branch);
    const outside = join(tempDir, "outside-quarantine");
    mkdirSync(join(root, ".quarantine"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, ".quarantine", "machine-1"));

    const release = releaseWorktree({
      leaseId: lease.lease_id,
      generation: lease.generation,
      fencingToken: lease.fencing_token,
      cleanup: "quarantine",
    });
    expect(release.ok).toBe(false);
    expect(release.code).toBe("unsafe_quarantine_root");
    expect(release.lease?.status).toBe("active");
  });

  it("rejects symlink path escapes before creating a lease", () => {
    const link = join(root, "link");
    mkdirSync(root, { recursive: true });
    symlinkSync(tempDir, link);

    const result = claimWorktree({
      repo: "hasna/repos",
      source,
      taskId: "task-symlink",
      runId: "run-symlink",
      machineId: "machine-1",
      branch: "task/symlink",
      owner: "pacuvius",
      root: link,
      idempotencyKey: "symlink",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("claim_failed");
    expect(result.message).toContain("symlink");
  });
});
