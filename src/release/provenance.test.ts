import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  RELEASE_PROVENANCE_SCHEMA,
  verifyReleaseProvenance,
  type ReleaseArtifactReader,
} from "./provenance.js";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("release provenance verifier", () => {
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const packageBytes = Buffer.from("package-bytes");
  const executableBytes = Buffer.from("executable-bytes");
  const provenanceBytes = Buffer.from(JSON.stringify({
    schema: RELEASE_PROVENANCE_SCHEMA,
    exact_commit: commit,
    exact_tree: tree,
    source_clean: true,
    package_name: "@hasna/repos",
    package_version: "0.1.34",
    executable_path: "dist/cli/index.js",
    executable_sha256: digest(executableBytes),
  }));
  const reader: ReleaseArtifactReader = {
    readFile(path) {
      return path === "release.tgz" ? packageBytes : executableBytes;
    },
    readArchiveEntry(_path, entry) {
      return entry.endsWith("release-provenance.json") ? provenanceBytes : executableBytes;
    },
  };
  const options = {
    expectedCommit: commit,
    expectedTree: tree,
    expectedPackageSha256: digest(packageBytes),
    expectedExecutableSha256: digest(executableBytes),
    packagePath: "release.tgz",
    executablePath: "repos",
  };

  it("binds exact source, package, and executable bytes in one receipt", () => {
    expect(verifyReleaseProvenance(options, reader)).toMatchObject({
      exact_commit: commit,
      exact_tree: tree,
      package_sha256: digest(packageBytes),
      executable_sha256: digest(executableBytes),
    });
  });

  it("rejects package, source, and executable mismatches", () => {
    expect(() => verifyReleaseProvenance({
      ...options,
      expectedPackageSha256: "c".repeat(64),
    }, reader)).toThrow("package digest mismatch");
    expect(() => verifyReleaseProvenance({ ...options, expectedCommit: "d".repeat(40) }, reader))
      .toThrow("source identity mismatch");
    expect(() => verifyReleaseProvenance({
      ...options,
      expectedExecutableSha256: "e".repeat(64),
    }, reader)).toThrow("executable digest mismatch");
  });
});
