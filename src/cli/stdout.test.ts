import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { printJson, writeAllSync, writeStdout, type SyncWriter } from "./stdout.js";

/** Collect everything a writer is handed, with a scriptable accept policy. */
function recordingWriter(policy: (chunk: Uint8Array, call: number) => number | Error) {
  const chunks: Uint8Array[] = [];
  let calls = 0;
  const writer: SyncWriter = (chunk) => {
    const outcome = policy(chunk, calls++);
    if (outcome instanceof Error) throw outcome;
    chunks.push(chunk.slice(0, outcome));
    return outcome;
  };
  return {
    writer,
    get calls() { return calls; },
    text() { return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"); },
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("writeAllSync", () => {
  test("keeps writing until every byte is accepted, not just the first chunk", () => {
    // A pipe accepts a bounded number of bytes per call. One unchecked
    // writeSync is exactly the 64 KiB truncation defect, so a short accept must
    // be followed up rather than treated as done.
    const payload = "x".repeat(5000);
    const sink = recordingWriter((chunk) => Math.min(chunk.length, 97));
    expect(writeAllSync(payload, sink.writer)).toBe("complete");
    expect(sink.text()).toBe(payload);
    expect(sink.calls).toBeGreaterThan(1);
  });

  test("retries on EAGAIN instead of losing the remainder", () => {
    // Bun may leave fd 1 non-blocking, so a full pipe raises EAGAIN rather than
    // blocking. EAGAIN is back-pressure; treating it as an error would drop the
    // tail exactly like the original bug.
    const payload = "abcdefghij".repeat(20);
    let raised = 0;
    const sink = recordingWriter((chunk, call) => {
      if (call % 2 === 1 && raised < 4) { raised++; return errno("EAGAIN"); }
      return Math.min(chunk.length, 31);
    });
    expect(writeAllSync(payload, sink.writer)).toBe("complete");
    expect(sink.text()).toBe(payload);
    expect(raised).toBe(4);
  });

  test("retries when the descriptor accepts zero bytes without raising", () => {
    const payload = "y".repeat(300);
    let stalls = 0;
    const sink = recordingWriter((chunk, call) => {
      if (call % 2 === 0 && stalls < 3) { stalls++; return 0; }
      return Math.min(chunk.length, 64);
    });
    expect(writeAllSync(payload, sink.writer)).toBe("complete");
    expect(sink.text()).toBe(payload);
  });

  test("stops quietly when the reader closes the pipe", () => {
    // `repos repos --json | head` is a normal shell pipeline. Raising EPIPE here
    // would turn adding a pager onto a working command into a crash.
    const sink = recordingWriter((chunk, call) => (call === 0 ? Math.min(chunk.length, 10) : errno("EPIPE")));
    expect(writeAllSync("z".repeat(500), sink.writer)).toBe("reader-closed");
    expect(sink.text()).toBe("z".repeat(10));
  });

  test("propagates a genuine I/O error rather than reporting a short write as done", () => {
    const sink = recordingWriter(() => errno("EIO"));
    expect(() => writeAllSync("payload", sink.writer)).toThrow("EIO");
  });

  test("printJson emits one parseable document terminated by a newline", () => {
    const sink = recordingWriter((chunk) => chunk.length);
    printJson({ ok: true, rows: [1, 2, 3] }, sink.writer);
    const text = sink.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ ok: true, rows: [1, 2, 3] });
  });

  test("writeStdout of an empty string does not call the writer", () => {
    const sink = recordingWriter(() => 0);
    expect(writeStdout("", sink.writer)).toBe("complete");
    expect(sink.calls).toBe(0);
  });
});

/**
 * The regression the unit tests above cannot prove: that the *CLI process* does
 * not lose its tail when stdout is a pipe. This is the measured defect —
 * 65536 bytes over a pipe versus 204365 to a file, both at exit code 0 — and it
 * only reproduces against the real binary, because whether the queued flush
 * survives depends on how much work the process did before writing.
 *
 * It has to run through a real shell pipeline. Measured on the unfixed CLI with
 * an identical 400-row fixture:
 *
 *     sh -c 'repos repos --json -n 400 | cat'   ->  65536 bytes   (truncated)
 *     Bun.spawnSync({ stdout: "pipe" })         -> 204365 bytes   (intact)
 *
 * `Bun.spawnSync`'s own capture pipe does not reproduce it. That is why this
 * defect survived a test suite that already spawns the CLI in several places:
 * every existing harness uses the one pipe flavour that is blind to it. A test
 * written the convenient way here would pass against the bug.
 */
describe("repos --json over a pipe", () => {
  const REPO_ROWS = 400;

  function seedIndex(): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "repos-json-pipe-"));
    const dbPath = join(dir, "repos.db");
    // Let the CLI create and migrate the schema, so the fixture cannot drift
    // from the real one.
    const boot = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli/index.tsx", "repos", "--json", "-n", "1"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_REPOS_DB_PATH: dbPath, HASNA_REPOS_AUTO_BOOTSTRAP: "0" },
    });
    expect(boot.exitCode).toBe(0);
    const db = new Database(dbPath);
    const insert = db.prepare(
      "INSERT INTO repos (name, path, org, remote_url, default_branch, description) VALUES (?, ?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < REPO_ROWS; i++) {
      insert.run(
        `fixture-repo-${i}`,
        join(dir, "checkouts", `dir-${i}`),
        "hasna",
        `github.com/hasna/fixture-${i}`,
        "main",
        "d".repeat(120),
      );
    }
    db.exec("COMMIT");
    db.close();
    return { dir, dbPath };
  }

  test("delivers every row through a real shell pipeline, not one pipe buffer", () => {
    const { dir, dbPath } = seedIndex();
    try {
      const result = Bun.spawnSync({
        cmd: ["sh", "-c", `bun run src/cli/index.tsx repos --json -n ${REPO_ROWS} | cat`],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HASNA_REPOS_DB_PATH: dbPath, HASNA_REPOS_AUTO_BOOTSTRAP: "0" },
      });
      expect(result.exitCode).toBe(0);
      const output = new TextDecoder().decode(result.stdout);
      // The defect delivered exactly one pipe buffer at exit code 0. Assert on
      // the boundary itself so a regression cannot hide behind a payload that
      // happens to fit, and parse it so a *valid* short answer still fails.
      expect(output.length).toBeGreaterThan(65536);
      const parsed = JSON.parse(output) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(REPO_ROWS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
