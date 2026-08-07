import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const writer = new URL("./write-provenance.ts", import.meta.url).pathname;

function fixture(dirty: boolean): {
  root: string;
  provenancePath: string;
  result: ReturnType<typeof spawnSync>;
} {
  const root = mkdtempSync(join(tmpdir(), "write-provenance-"));
  const bin = join(root, "bin");
  const provenancePath = join(root, "dist", "release-provenance.json");
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@hasna/repos",
    version: "9.9.9",
  }));
  writeFileSync(join(root, "dist", "cli", "index.js"), "fixture executable");

  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh
case "$1:$2" in
  rev-parse:HEAD) printf '%s\\n' '${"a".repeat(40)}' ;;
  rev-parse:HEAD^{tree}) printf '%s\\n' '${"b".repeat(40)}' ;;
  status:--porcelain) printf '%s' "\${FAKE_GIT_STATUS:-}" ;;
  *) printf '%s\\n' "unexpected git invocation: $*" >&2; exit 64 ;;
esac
`);
  chmodSync(fakeGit, 0o755);

  const result = spawnSync(process.execPath, [writer], {
    cwd: root,
    encoding: "utf8",
    timeout: 3_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      FAKE_GIT_STATUS: dirty ? " M src/release/write-provenance.ts" : "",
    },
  });
  return { root, provenancePath, result };
}

describe("release provenance writer", () => {
  it("writes a truthful source_clean=true record for a clean source tree", () => {
    const { provenancePath, result } = fixture(false);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(existsSync(provenancePath)).toBe(true);
    const record = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      source_clean?: unknown;
    };
    expect(record.source_clean).toBe(true);
  });

  it("refuses a dirty source tree before writing a provenance record", () => {
    const { provenancePath, result } = fixture(true);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to write release provenance from a dirty source tree");
    expect(existsSync(provenancePath)).toBe(false);
  });
});
