#!/usr/bin/env bun
import { verifyReleaseProvenance } from "./provenance.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error("missing required option " + name);
  return value;
}

try {
  const receipt = verifyReleaseProvenance({
    expectedCommit: option("--expected-commit"),
    expectedTree: option("--expected-tree"),
    expectedPackageSha256: option("--expected-package-sha256"),
    expectedExecutableSha256: option("--expected-executable-sha256"),
    packagePath: option("--package"),
    executablePath: option("--executable"),
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "release provenance verification failed") + "\n");
  process.exitCode = 1;
}
