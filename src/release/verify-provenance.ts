#!/usr/bin/env bun
import { verifyReleaseProvenance } from "./provenance.js";
import { getCliVersion } from "../cli/version.js";
import {
  buildShipChainReport,
  formatShipChainReport,
  unaskedReport,
  type ShipChainReport,
} from "./rungs.js";

const USAGE = `Usage: repos-verify-release [options]

Report the ship chain for a repos release from artefacts, one line per rung:

  MERGED     the packaged artefact descends from the reviewed commit and tree
  PUBLISHED  the published package and executable digests bind that source
  INSTALLED  the artefact is actually on this host's disk, digested from the
             installed bytes - not read off a version string
  RUNNING    the artefact is the one actually running (NOT IMPLEMENTED - reports UNKNOWN)

Every invocation prints all four rungs as PASS, FAIL or UNKNOWN. The command
exits non-zero if ANY rung is FAIL *or* UNKNOWN: merged is not published,
published is not installed, installed is not running, and a rung that was never
asked must not read as green.

Required options:
  --expected-commit <object-id>       Reviewed source commit
  --expected-tree <object-id>         Reviewed source tree
  --expected-package-sha256 <sha256>  Reviewed package tarball digest
  --expected-executable-sha256 <sha256>
                                      Reviewed executable digest
  --package <path>                    Exact package tarball
  --executable <path>                 Exact repos executable

Options:
  --installed-package <name>          Package to resolve for the INSTALLED rung
                                      (defaults to the verified package name)
  --install-root <path>               node_modules root for the INSTALLED rung
                                      (defaults to the global bun install root)
  --json                              Emit the machine-readable report
  -h, --help                          display help
  -V, --version                       display version

Exit codes:
  0  every rung PASS
  1  any rung FAIL or UNKNOWN (including rungs this build cannot ask)
`;

function handleCliFlags(argv: string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return true;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${getCliVersion()}\n`);
    return true;
  }
  return false;
}

const argv = process.argv.slice(2);

if (handleCliFlags(argv)) {
  process.exit(0);
}

function option(name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error("missing required option " + name);
  return value;
}

function emit(report: ShipChainReport): never {
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatShipChainReport(report));
  }
  // Non-zero for FAIL *and* for UNKNOWN. This inversion is the point of the
  // command: before it, an unasked rung was silent and silence read as success.
  process.exit(report.verified ? 0 : 1);
}

let options;
try {
  options = {
    expectedCommit: option("--expected-commit"),
    expectedTree: option("--expected-tree"),
    expectedPackageSha256: option("--expected-package-sha256"),
    expectedExecutableSha256: option("--expected-executable-sha256"),
    packagePath: option("--package"),
    executablePath: option("--executable"),
  };
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid arguments";
  process.stderr.write(message + " (run --help for usage)\n");
  emit(unaskedReport(message));
}

function optionalOption(name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return !value || value.startsWith("--") ? undefined : value;
}

emit(buildShipChainReport(() => verifyReleaseProvenance(options), {
  packageName: optionalOption("--installed-package"),
  expectedCommit: options.expectedCommit,
  expectedExecutableSha256: options.expectedExecutableSha256,
  installRoot: optionalOption("--install-root"),
}));
