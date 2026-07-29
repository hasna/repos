#!/usr/bin/env bun
import { verifyReleaseProvenance } from "./provenance.js";
import { getCliVersion } from "../cli/version.js";

function handleCliFlags(argv: string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`Usage: repos-verify-release [options]\n\nVerify a packaged repos executable against reviewed source and artifact identities.\n\nRequired options:\n  --expected-commit <object-id>       Reviewed source commit\n  --expected-tree <object-id>         Reviewed source tree\n  --expected-package-sha256 <sha256>  Reviewed package tarball digest\n  --expected-executable-sha256 <sha256>\n                                      Reviewed executable digest\n  --package <path>                    Exact package tarball\n  --executable <path>                 Exact repos executable\n\nOptions:\n  -h, --help                          display help\n  -V, --version                       display version\n`);
    return true;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${getCliVersion()}\n`);
    return true;
  }
  return false;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error("missing required option " + name);
  return value;
}

if (handleCliFlags(process.argv.slice(2))) {
  process.exit(0);
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
