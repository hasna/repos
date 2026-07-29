/**
 * Deliver CLI output to stdout so that it cannot be silently lost.
 *
 * `console.log` on a pipe is not a completed write. Measured on this repo at
 * 836539a with Bun 1.3.14: `repos repos --json -n 400` against a 400-row index
 * writes 204365 bytes when stdout is a file and exactly 65536 bytes — one pipe
 * buffer — when stdout is a pipe, both at exit code 0. The overflow is queued
 * for an async flush that never happens, because nothing keeps the process
 * alive long enough to drain it. The result is invalid JSON reported as success:
 *
 *     repos repos --json -n 3000 | jq .
 *     # JSONDecodeError at char 65536, and the shell saw rc=0
 *
 * Whether the payload survives is a race, which is why it reproduces on the
 * full CLI but not on a small script that imports the same query layer: the
 * more work the process does before writing, the more reliably it loses the
 * tail. A truncation that depends on module-load timing is worse than one that
 * always happens, because it reads as success on small workspaces and starts
 * corrupting data as the index grows.
 *
 * So the CLI writes with `writeSync` in a loop instead. A synchronous write to
 * fd 1 either returns bytes accepted or fails; there is no queue left behind at
 * exit. Three cases have to be handled explicitly, and each of them is a real
 * failure mode rather than defensive padding:
 *
 *   - **Partial writes.** `write(2)` on a pipe is allowed to accept fewer bytes
 *     than offered, and does so for anything past the buffer capacity. A single
 *     unchecked `writeSync` call is the 64 KiB bug with extra steps.
 *   - **EAGAIN.** Bun may leave fd 1 in non-blocking mode, so a full pipe
 *     raises EAGAIN rather than blocking until the reader drains. That is
 *     back-pressure, not an error, and the write has to be retried.
 *   - **EPIPE.** `repos repos --json | head` closes the reader early. That is
 *     the reader's choice and the normal end of a shell pipeline, so writing
 *     stops quietly instead of raising — otherwise adding a pager to a working
 *     command would turn it into a crash.
 */
import { writeSync } from "node:fs";

/** Bytes accepted per attempt, and whether the reader is still there. */
export interface SyncWriter {
  (chunk: Uint8Array): number;
}

const BACKPRESSURE_WAIT_MS = 1;
const backpressureWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Sleep without spinning a core while a full pipe drains. */
function awaitDrain(): void {
  Atomics.wait(backpressureWait, 0, 0, BACKPRESSURE_WAIT_MS);
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export type StdoutWriteOutcome = "complete" | "reader-closed";

/**
 * Write every byte of `text`, or stop because the reader closed the pipe.
 *
 * `writer` is injectable so the partial-write, back-pressure and reader-closed
 * paths can be exercised without needing a real full pipe, which is not
 * reproducible in a test.
 */
export function writeAllSync(text: string, writer: SyncWriter): StdoutWriteOutcome {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    let accepted: number;
    try {
      accepted = writer(buffer.subarray(offset));
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        awaitDrain();
        continue;
      }
      // EPIPE (reader closed) and ERR_STREAM_DESTROYED (the same condition
      // surfaced by a stream wrapper) end the pipeline; anything else is a real
      // I/O failure and must not be swallowed into a short write.
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return "reader-closed";
      throw error;
    }
    if (accepted <= 0) {
      // A zero-byte accept with no error means the descriptor took nothing and
      // raised nothing. Retrying immediately would spin, so wait like EAGAIN.
      awaitDrain();
      continue;
    }
    offset += accepted;
  }
  return "complete";
}

const fdWriter = (fd: number): SyncWriter => (chunk) => writeSync(fd, chunk);

/** Write `text` to stdout, completing the write before returning. */
export function writeStdout(text: string, writer: SyncWriter = fdWriter(1)): StdoutWriteOutcome {
  return writeAllSync(text, writer);
}

/** Write `text` plus a newline to stdout, completing the write before returning. */
export function printLine(text: string, writer: SyncWriter = fdWriter(1)): StdoutWriteOutcome {
  return writeStdout(`${text}\n`, writer);
}

/** Write `text` plus a newline to stderr, completing the write before returning. */
export function printError(text: string, writer: SyncWriter = fdWriter(2)): StdoutWriteOutcome {
  return writeAllSync(`${text}\n`, writer);
}

/**
 * Emit a machine-readable JSON document on stdout.
 *
 * Every `--json` surface goes through here rather than `console.log`, because
 * any of them can exceed a pipe buffer once an index grows: the repo list, the
 * PR surface, the loop-producer envelopes and the ops reports are all unbounded
 * in the number of rows they serialize.
 */
export function printJson(value: unknown, writer: SyncWriter = fdWriter(1)): StdoutWriteOutcome {
  return printLine(JSON.stringify(value, null, 2), writer);
}

/** Single-line JSON, for streams where one record per line is the contract. */
export function printJsonLine(value: unknown, writer: SyncWriter = fdWriter(1)): StdoutWriteOutcome {
  return printLine(JSON.stringify(value), writer);
}
