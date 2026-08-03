import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNG_NAMES,
  buildShipChainReport,
  evaluateInstalledRung,
  unaskedReport,
  type Rung,
  type ShipChainReport,
} from "./rungs.js";
import { RELEASE_PROVENANCE_SCHEMA, type ReleaseVerificationReceipt } from "./provenance.js";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const receipt: ReleaseVerificationReceipt = {
  schema: "open-repos.release-verification.v1",
  exact_commit: commit,
  exact_tree: tree,
  package_name: "@hasna/repos",
  package_version: "9.9.9",
  package_sha256: "c".repeat(64),
  executable_sha256: "d".repeat(64),
  provenance_sha256: "e".repeat(64),
};

const rung = (report: ShipChainReport, name: string): Rung =>
  report.rungs.find((entry) => entry.rung === name)!;

function installTree(options: { commit?: string; executable: Buffer; withProvenance?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "rungs-"));
  const packageDir = join(root, "@hasna", "repos");
  mkdirSync(join(packageDir, "dist", "cli"), { recursive: true });
  writeFileSync(join(packageDir, "dist", "cli", "index.js"), options.executable);
  if (options.withProvenance !== false) {
    writeFileSync(join(packageDir, "dist", "release-provenance.json"), JSON.stringify({
      schema: RELEASE_PROVENANCE_SCHEMA,
      exact_commit: options.commit ?? commit,
      exact_tree: tree,
      source_clean: true,
      package_name: "@hasna/repos",
      package_version: "9.9.9",
      executable_path: "dist/cli/index.js",
      executable_sha256: digest(options.executable),
    }));
  }
  return root;
}

describe("ship chain report", () => {
  it("never omits a rung, whatever happened", () => {
    for (const report of [
      unaskedReport("no arguments"),
      buildShipChainReport(() => receipt),
      buildShipChainReport(() => { throw new Error("release provenance verification failed: package digest mismatch"); }),
    ]) {
      expect(report.rungs.map((entry) => entry.rung)).toEqual([...RUNG_NAMES]);
    }
  });

  it("is NOT verified when a rung is merely UNKNOWN, so silence cannot read as success", () => {
    const report = buildShipChainReport(() => receipt);
    expect(rung(report, "MERGED").status).toBe("PASS");
    expect(rung(report, "PUBLISHED").status).toBe("PASS");
    // RUNNING has no probe mechanism, so the whole chain must stay unverified.
    expect(rung(report, "RUNNING").status).toBe("UNKNOWN");
    expect(report.verified).toBe(false);
  });

  it("blames a package digest failure on PUBLISHED and leaves MERGED UNKNOWN, not PASS", () => {
    const report = buildShipChainReport(() => {
      throw new Error("release provenance verification failed: package digest mismatch");
    });
    expect(rung(report, "PUBLISHED").status).toBe("FAIL");
    expect(rung(report, "MERGED").status).toBe("UNKNOWN");
    expect(report.verified).toBe(false);
  });

  it("blames a source identity failure on MERGED while PUBLISHED still passed", () => {
    const report = buildShipChainReport(() => {
      throw new Error("release provenance verification failed: source identity mismatch");
    });
    expect(rung(report, "MERGED").status).toBe("FAIL");
    expect(rung(report, "PUBLISHED").status).toBe("PASS");
  });
});

describe("installed rung", () => {
  const executable = Buffer.from("installed-executable-bytes");

  it("passes only when the on-disk bytes AND the recorded commit match", () => {
    const installRoot = installTree({ executable });
    expect(evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    }).status).toBe("PASS");
  });

  it("FAILs a commit that was never deployed to this host", () => {
    const installRoot = installTree({ executable });
    const result = evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: "f".repeat(40),
      expectedExecutableSha256: digest(executable),
      installRoot,
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("expected " + "f".repeat(40));
  });

  it("FAILs when the installed bytes differ, even if the version says otherwise", () => {
    const installRoot = installTree({ executable: Buffer.from("some-other-build") });
    expect(evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    }).status).toBe("FAIL");
  });

  it("FAILs when the package is not installed at all", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-empty-"));
    expect(evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    }).status).toBe("FAIL");
  });

  it("is UNKNOWN, not PASS, when the digest matches but no provenance record proves the commit", () => {
    const installRoot = installTree({ executable, withProvenance: false });
    expect(evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    }).status).toBe("UNKNOWN");
  });

  it("never follows an unvalidated provenance path away from the installed CLI", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-redirect-"));
    const packageDir = join(installRoot, "@hasna", "repos");
    const reviewedExecutable = Buffer.from("reviewed-executable-bytes");
    mkdirSync(join(packageDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageDir, "dist", "cli", "index.js"), Buffer.from("stale-installed-cli"));
    writeFileSync(join(packageDir, "dist", "reviewed-copy.js"), reviewedExecutable);
    writeFileSync(join(packageDir, "dist", "release-provenance.json"), JSON.stringify({
      schema: RELEASE_PROVENANCE_SCHEMA,
      exact_commit: commit,
      exact_tree: tree,
      source_clean: true,
      package_name: "@hasna/repos",
      package_version: "9.9.9",
      executable_path: "dist/reviewed-copy.js",
      executable_sha256: digest(reviewedExecutable),
    }));

    expect(evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(reviewedExecutable),
      installRoot,
    }).status).not.toBe("PASS");
  });

  it("never escapes the package directory when the record's executable_path traverses upward", () => {
    // The attack: keep a pristine copy anywhere on disk, point executable_path
    // at it with "..", and the tampered dist/cli/index.js is never opened.
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-traversal-"));
    const packageDir = join(installRoot, "@hasna", "repos");
    const pristine = Buffer.from("pristine-reviewed-bytes");
    mkdirSync(join(packageDir, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageDir, "dist", "cli", "index.js"), Buffer.from("TAMPERED-CLI"));
    writeFileSync(join(installRoot, "decoy.js"), pristine);
    writeFileSync(join(packageDir, "dist", "release-provenance.json"), JSON.stringify({
      schema: RELEASE_PROVENANCE_SCHEMA,
      exact_commit: commit,
      exact_tree: tree,
      source_clean: true,
      package_name: "@hasna/repos",
      package_version: "9.9.9",
      executable_path: "../../decoy.js",
      executable_sha256: digest(pristine),
    }));

    const result = evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      // the digest of the file the ATTACKER wants compared, not of the real CLI
      expectedExecutableSha256: digest(pristine),
      installRoot,
    });
    expect(result.status).not.toBe("PASS");
    expect(result.detail).not.toContain("decoy.js");
  });

  it("FAILs rather than throwing when the executable cannot be read (EISDIR)", () => {
    // A directory where the executable should be: readFileSync throws EISDIR.
    // Unguarded, that escapes the report and prints ZERO rungs.
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-eisdir-"));
    const packageDir = join(installRoot, "@hasna", "repos");
    mkdirSync(join(packageDir, "dist", "cli", "index.js"), { recursive: true });

    const result = evaluateInstalledRung({
      packageName: "@hasna/repos",
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("unreadable");
  });

  it("still prints all four rungs when the install is unreadable", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-eisdir-report-"));
    mkdirSync(join(installRoot, "@hasna", "repos", "dist", "cli", "index.js"), { recursive: true });

    const report = buildShipChainReport(() => receipt, {
      expectedCommit: commit,
      expectedExecutableSha256: digest(executable),
      installRoot,
    });
    expect(report.rungs.map((entry) => entry.rung)).toEqual([...RUNG_NAMES]);
    expect(rung(report, "INSTALLED").status).toBe("FAIL");
    expect(report.verified).toBe(false);
  });

  it("FAILs promptly and still reports four rungs when the executable is a FIFO", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "rungs-fifo-report-"));
    const executablePath = join(installRoot, "@hasna", "repos", "dist", "cli", "index.js");
    mkdirSync(join(executablePath, ".."), { recursive: true });
    execFileSync("mkfifo", [executablePath]);

    // Run the blocking-risk path in a bounded child. Before the fix,
    // readFileSync waits forever for a FIFO writer and this child times out.
    const child = spawnSync(process.execPath, ["--eval", `
      import { buildShipChainReport } from ${JSON.stringify(new URL("./rungs.ts", import.meta.url).href)};
      const report = buildShipChainReport(() => (${JSON.stringify(receipt)}), {
        expectedCommit: ${JSON.stringify(commit)},
        expectedExecutableSha256: ${JSON.stringify(digest(executable))},
        installRoot: ${JSON.stringify(installRoot)},
      });
      process.stdout.write(JSON.stringify(report));
    `], { encoding: "utf8", timeout: 3_000 });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout) as ShipChainReport;
    expect(report.rungs.map((entry) => entry.rung)).toEqual([...RUNG_NAMES]);
    expect(rung(report, "INSTALLED").status).toBe("FAIL");
    expect(rung(report, "INSTALLED").detail).toContain("not a regular file");
    expect(report.verified).toBe(false);
  });
});
