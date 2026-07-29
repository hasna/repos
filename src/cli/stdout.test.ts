import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { printError, printJson, writeAllSync, writeStdout, type SyncWriter } from "./stdout.js";

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

  test("printError completes an error line through the supplied writer", () => {
    const sink = recordingWriter((chunk) => Math.min(chunk.length, 37));
    const payload = "refusal ".repeat(100);
    expect(printError(payload, sink.writer)).toBe("complete");
    expect(sink.text()).toBe(`${payload}\n`);
    expect(sink.calls).toBeGreaterThan(1);
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

  /**
   * `bash`, explicitly, and never `sh`.
   *
   * `/bin/sh` is dash on Debian and Ubuntu, and dash has no `set -o pipefail` —
   * it answers `set: Illegal option -o pipefail` at rc=2 and runs nothing. A pipe
   * test that quietly degrades to dash measures nothing at all. `pipefail` is the
   * point of using a shell here: without it the pipeline reports `cat`'s status,
   * so a producer that died mid-document would still read as success, which is
   * the exact class of lie this file exists to catch.
   */
  function pipeline(script: string, dbPath: string) {
    return Bun.spawnSync({
      cmd: ["bash", "-c", `set -o pipefail; ${script}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_REPOS_DB_PATH: dbPath, HASNA_REPOS_AUTO_BOOTSTRAP: "0" },
    });
  }

  test("delivers every row through a real shell pipeline, not one pipe buffer", () => {
    const { dir, dbPath } = seedIndex();
    try {
      const result = pipeline(`bun run src/cli/index.tsx repos --json -n ${REPO_ROWS} | cat`, dbPath);
      // With pipefail this is the *producer's* status, not `cat`'s.
      expect(result.exitCode).toBe(0);
      // Measure BYTES. `String.length` counts UTF-16 code units, and 65536 is a
      // byte boundary — a pipe buffer. On multi-byte content the two diverge in
      // the direction that hides truncation, because a 65536-byte truncated
      // document can report a code-unit length above 65536 and pass. The raw
      // `stdout` buffer is the honest measurement; decoding first and measuring
      // after would also re-encode a replacement character over any partial
      // multi-byte sequence at the cut.
      expect(result.stdout.byteLength).toBeGreaterThan(65536);
      const output = new TextDecoder().decode(result.stdout);
      // Parse as well as size it, so a *valid* short answer still fails.
      const parsed = JSON.parse(output) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(REPO_ROWS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ends cleanly when the reader closes the pipe, without an unhandled EPIPE", () => {
    // The reader-closed path was only ever exercised against an injected
    // `SyncWriter`. The real binary happens to behave, but nothing asserted it,
    // so deleting the EPIPE branch from `writeAllSync` would regress silently:
    // `writeSync` would throw, Bun would print an uncaught `EPIPE` and a stack,
    // and `repos repos --json | head` — an ordinary shell pipeline — would become
    // a crash.
    //
    // A closed reader means a SHORT document is the correct outcome here; that is
    // the difference from the test above, where the pipe stays open and short is
    // the defect. Both a clean rc=0 stop and a deliberate non-zero producer exit
    // satisfy the contract, so the exit code itself is not asserted — what is
    // asserted is that the process terminated, emitted no unhandled failure, and
    // still produced the beginning of the real document.
    const { dir, dbPath } = seedIndex();
    try {
      const result = pipeline(`bun run src/cli/index.tsx repos --json -n ${REPO_ROWS} | head -1`, dbPath);
      // A hang is caught by the suite timeout; this asserts it exited rather than
      // being left for the runner to reap.
      expect(result.exitCode).not.toBeNull();
      const stderr = result.stderr.toString();
      expect(stderr).not.toContain("EPIPE");
      expect(stderr).not.toContain("ERR_STREAM_DESTROYED");
      // `printJson` pretty-prints, so the first line of a repo list is the array
      // opening. Getting it proves the producer wrote before the reader left,
      // rather than dying on startup and passing this test by writing nothing.
      expect(new TextDecoder().decode(result.stdout).trim()).toBe("[");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A writer module does nothing for a call site that bypasses it.
 *
 * This is not hypothetical. The 64 KiB truncation was fixed by routing every
 * `--json` surface through `printJson`, and it came straight back on a *new*
 * surface: `registry prune --json` was added with two fresh
 * `console.log(JSON.stringify(...))` call sites, and its dry-run plan measured
 * 126829 bytes to a file against exactly 65536 bytes through `bash -c
 * 'set -o pipefail; ... | cat'` at exit code 0, with the JSON unparseable. The
 * document cut in half there is a PRUNE PLAN — the record of which registry
 * rows a deletion primitive intends to remove — so the surface that reopened the
 * defect was the worst one available.
 *
 * `console.log` is the wrong tool for a machine-readable document on any fd that
 * can be a pipe, so no amount of care at review time substitutes for a check
 * that fails. This guard is the check: it makes reintroducing the bypass a red
 * test rather than a defect discovered later by whatever consumed the truncated
 * output.
 */
describe("no --json surface bypasses the completing writer", () => {
  const SRC_ROOT = join(import.meta.dir, "..");
  // `console.log` hands a fully-serialized document to an async, unflushed
  // stdout path. Any JSON.stringify inside a console.log argument list is the
  // defect, whatever the surrounding formatting.
  const BYPASS = /console\.log\s*\(\s*JSON\.stringify/;

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        sourceFiles(full, found);
      } else if (/\.tsx?$/.test(entry.name) && full !== import.meta.path) {
        found.push(full);
      }
    }
    return found;
  }

  test("no console.log(JSON.stringify(...)) remains anywhere under src/", () => {
    const files = sourceFiles(SRC_ROOT);
    // Guard the guard: if the walk finds nothing, an empty offender list would
    // pass vacuously.
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (BYPASS.test(line)) offenders.push(`${relative(SRC_ROOT, file)}:${i + 1}`);
      });
    }
    // Named in the failure so the fix is obvious: replace it with printJson /
    // printJsonLine / printLine from src/cli/stdout.ts.
    expect(offenders).toEqual([]);
  });
});
