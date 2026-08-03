import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  RELEASE_EXECUTABLE_PATH,
  parseReleaseProvenance,
  type ReleaseVerificationReceipt,
} from "./provenance.js";

export const SHIP_CHAIN_SCHEMA = "open-repos.ship-chain-report.v1" as const;

/**
 * The four rungs of the ship chain. Merged is not published, published is not
 * installed, installed is not running. A rung that was never asked is UNKNOWN;
 * it is never omitted and never silently PASS, because an omitted rung is
 * indistinguishable from a passing one and that is how a security fix gets
 * announced as resolved while it runs nowhere.
 */
export const RUNG_NAMES = ["MERGED", "PUBLISHED", "INSTALLED", "RUNNING"] as const;
export type RungName = (typeof RUNG_NAMES)[number];
export type RungStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface Rung {
  rung: RungName;
  status: RungStatus;
  detail: string;
}

export interface ShipChainReport {
  schema: typeof SHIP_CHAIN_SCHEMA;
  verified: boolean;
  rungs: Rung[];
  receipt: ReleaseVerificationReceipt | null;
}

const UNASKED_RUNNING =
  "not asked: no process probe mechanism is defined, so no running artefact was checked";

export interface InstalledRungOptions {
  /** Package name to resolve on disk, e.g. "@hasna/repos". */
  packageName: string;
  expectedCommit: string;
  expectedExecutableSha256: string;
  /** node_modules root to resolve in. Defaults to the global bun install root. */
  installRoot?: string;
}

export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  const bunInstall = env["BUN_INSTALL"] ?? (env["HOME"] ? join(env["HOME"], ".bun") : undefined);
  if (!bunInstall) return "";
  return join(bunInstall, "install", "global", "node_modules");
}

/**
 * The ONE way this file touches an installed file. Every read the INSTALLED
 * rung performs goes through here, because the defect this guards against is
 * exactly two reads in one function disagreeing about what is safe: a bare
 * path-based readFileSync on a FIFO blocks forever, and the surrounding
 * try/catch cannot rescue the report, because a hang is not an exception.
 */
function readInstalledFile(path: string):
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string } {
  let descriptor: number | undefined;
  try {
    // O_NONBLOCK keeps a FIFO or device from turning verification into an
    // indefinite wait. Inspect and read through the same descriptor so a path
    // swap between validation and reading cannot substitute another object.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) {
      return { ok: false, reason: "unreadable (not a regular file)" };
    }
    return { ok: true, bytes: readFileSync(descriptor) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown I/O error";
    return { ok: false, reason: `unreadable (${code})` };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Closing cannot change the bytes already read, and must not suppress
        // the four-rung report.
      }
    }
  }
}

function digestInstalledExecutable(path: string):
  | { ok: true; sha256: string }
  | { ok: false; reason: string } {
  const read = readInstalledFile(path);
  if (!read.ok) return read;
  return {
    ok: true,
    sha256: createHash("sha256").update(read.bytes).digest("hex"),
  };
}

/**
 * The INSTALLED rung: is the reviewed artefact actually on this host's disk?
 * Published is not installed. This reads the ON-DISK bytes and digests them; it
 * never trusts a version string or a lockfile, because a receipt is not an
 * artefact.
 */
export function evaluateInstalledRung(options: InstalledRungOptions): Rung {
  const rung = (status: RungStatus, detail: string): Rung => ({ rung: "INSTALLED", status, detail });
  const root = options.installRoot ?? defaultInstallRoot();
  if (!root) {
    return rung("UNKNOWN", "not asked: no install root could be resolved (set BUN_INSTALL or --install-root)");
  }
  const packageDir = join(root, ...options.packageName.split("/"));
  if (!existsSync(packageDir)) {
    return rung("FAIL", `${options.packageName} is not installed under ${root}`);
  }

  // PINNED, and never re-derived from the record under test. The installed
  // package does not get to name the bytes we digest: join() collapses "..", so
  // a record naming "../../../pristine-copy.js" would point the digest at a
  // clean file kept anywhere on disk while the file that actually runs is never
  // opened -- satisfying the rung whose entire purpose is to detect exactly that.
  const executablePath = join(packageDir, ...RELEASE_EXECUTABLE_PATH.split("/"));
  let installedCommit: string | null = null;
  const provenancePath = join(packageDir, "dist", "release-provenance.json");
  if (existsSync(provenancePath)) {
    // Same guard as the executable read below. existsSync() is true for a FIFO,
    // so an unguarded read here hangs the whole report and prints ZERO rungs --
    // verbatim the silence this command exists to end. A provenance record we
    // cannot read is no more proven than one we cannot parse, so it lands on
    // the same UNKNOWN as the malformed case, never on a hang and never on a
    // throw.
    const provenanceFile = readInstalledFile(provenancePath);
    if (!provenanceFile.ok) {
      return rung(
        "UNKNOWN",
        `not asked: ${provenancePath} is present but ${provenanceFile.reason}, so it is not a readable provenance record`,
      );
    }
    try {
      const record = parseReleaseProvenance(provenanceFile.bytes);
      installedCommit = record.exact_commit;
      if (record.executable_path !== RELEASE_EXECUTABLE_PATH) {
        return rung(
          "FAIL",
          `installed provenance declares executable_path ${JSON.stringify(record.executable_path)}, expected ${JSON.stringify(RELEASE_EXECUTABLE_PATH)}`,
        );
      }
      if (record.package_name !== options.packageName) {
        return rung(
          "FAIL",
          `installed provenance reports package ${record.package_name}, expected ${options.packageName}`,
        );
      }
      if (record.executable_sha256 !== options.expectedExecutableSha256) {
        return rung(
          "FAIL",
          `installed provenance reports executable sha256 ${record.executable_sha256}, expected ${options.expectedExecutableSha256}`,
        );
      }
    } catch {
      return rung("UNKNOWN", `not asked: ${provenancePath} is present but is not a valid provenance record`);
    }
  }

  if (!existsSync(executablePath)) {
    return rung("FAIL", `${options.packageName} is installed but ${executablePath} is missing`);
  }
  // An unreadable or non-regular executable (EISDIR / EACCES / ELOOP / FIFO)
  // is a verification failure, not an exception or an indefinite wait.
  const installedExecutable = digestInstalledExecutable(executablePath);
  if (!installedExecutable.ok) {
    return rung("FAIL", `installed executable ${executablePath} is ${installedExecutable.reason}, so its bytes are unverified`);
  }
  const installedSha256 = installedExecutable.sha256;
  if (installedSha256 !== options.expectedExecutableSha256) {
    return rung(
      "FAIL",
      `installed executable ${executablePath} is sha256 ${installedSha256}, expected ${options.expectedExecutableSha256}`,
    );
  }
  if (installedCommit === null) {
    return rung(
      "UNKNOWN",
      `installed executable digest matches, but ${provenancePath} is absent so its source commit is unproven`,
    );
  }
  if (installedCommit !== options.expectedCommit) {
    return rung(
      "FAIL",
      `installed artefact reports commit ${installedCommit}, expected ${options.expectedCommit}`,
    );
  }
  return rung(
    "PASS",
    `${packageDir} carries commit ${installedCommit} and executable sha256 ${installedSha256}`,
  );
}

/**
 * Classify a provenance failure onto the rung it actually belongs to.
 * verifyReleaseProvenance binds the package bytes first, then the source
 * identity, then the executable digest, so the failure message tells us how far
 * the chain got. Anything we cannot place stays UNKNOWN rather than FAIL.
 */
function classifyProvenanceFailure(message: string): { merged: Rung; published: Rung } {
  const merged = (status: RungStatus, detail: string): Rung => ({ rung: "MERGED", status, detail });
  const published = (status: RungStatus, detail: string): Rung => ({ rung: "PUBLISHED", status, detail });

  if (message.includes("source identity mismatch")) {
    return {
      merged: merged("FAIL", "packaged artefact does not descend from the expected commit/tree"),
      published: published(
        "PASS",
        "package digest matched the expected release digest (but it carries different source)",
      ),
    };
  }
  if (message.includes("package digest mismatch")) {
    return {
      merged: merged("UNKNOWN", "not asked: package digest failed first, so source identity was never compared"),
      published: published("FAIL", "package digest does not match the expected release digest"),
    };
  }
  if (message.includes("executable digest mismatch")) {
    return {
      merged: merged("PASS", "packaged provenance record matches the expected commit and tree"),
      published: published("FAIL", "published executable digest does not match the packaged/expected digest"),
    };
  }
  if (message.includes("invalid expected identity")) {
    return {
      merged: merged("UNKNOWN", "not asked: expected commit/tree/digest arguments are malformed"),
      published: published("UNKNOWN", "not asked: expected commit/tree/digest arguments are malformed"),
    };
  }
  return {
    merged: merged("UNKNOWN", "not asked: " + message),
    published: published("UNKNOWN", "not asked: " + message),
  };
}

/**
 * No filesystem surprise may cost the operator the report. Whatever happens
 * under the INSTALLED rung, four rungs get printed; an exception that escaped
 * here would print none at all.
 */
function safeInstalledRung(options: InstalledRungOptions): Rung {
  try {
    return evaluateInstalledRung(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rung: "INSTALLED", status: "FAIL", detail: `install could not be inspected: ${message}` };
  }
}

export function unaskedReport(reason: string): ShipChainReport {
  return finish([
    { rung: "MERGED", status: "UNKNOWN", detail: "not asked: " + reason },
    { rung: "PUBLISHED", status: "UNKNOWN", detail: "not asked: " + reason },
    { rung: "INSTALLED", status: "UNKNOWN", detail: "not asked: " + reason },
    { rung: "RUNNING", status: "UNKNOWN", detail: UNASKED_RUNNING },
  ], null);
}

export interface InstalledContext {
  /** Explicit --installed-package; falls back to the verified receipt's name. */
  packageName?: string;
  expectedCommit: string;
  expectedExecutableSha256: string;
  installRoot?: string;
}

export function buildShipChainReport(
  run: () => ReleaseVerificationReceipt,
  installed?: InstalledContext,
): ShipChainReport {
  let receipt: ReleaseVerificationReceipt | null = null;
  let merged: Rung;
  let published: Rung;
  try {
    receipt = run();
    merged = {
      rung: "MERGED",
      status: "PASS",
      detail: `artefact descends from commit ${receipt.exact_commit} tree ${receipt.exact_tree}`,
    };
    published = {
      rung: "PUBLISHED",
      status: "PASS",
      detail: `${receipt.package_name}@${receipt.package_version} package sha256 ${receipt.package_sha256} binds that source`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "release provenance verification failed";
    ({ merged, published } = classifyProvenanceFailure(message));
  }
  const packageName = installed?.packageName ?? receipt?.package_name;
  const installedRung: Rung = !installed
    ? { rung: "INSTALLED", status: "UNKNOWN", detail: "not asked: no install context was supplied" }
    : !packageName
      ? {
        rung: "INSTALLED",
        status: "UNKNOWN",
        detail: "not asked: package name unknown (provenance failed before it was read; pass --installed-package)",
      }
      : safeInstalledRung({
        packageName,
        expectedCommit: installed.expectedCommit,
        expectedExecutableSha256: installed.expectedExecutableSha256,
        installRoot: installed.installRoot,
      });

  return finish([
    merged,
    published,
    installedRung,
    { rung: "RUNNING", status: "UNKNOWN", detail: UNASKED_RUNNING },
  ], receipt);
}

function finish(rungs: Rung[], receipt: ReleaseVerificationReceipt | null): ShipChainReport {
  return {
    schema: SHIP_CHAIN_SCHEMA,
    // A rung that is not PASS — FAIL or UNKNOWN alike — means the chain is not
    // verified. Silence must not read as success.
    verified: rungs.every((entry) => entry.status === "PASS"),
    rungs,
    receipt,
  };
}

export function formatShipChainReport(report: ShipChainReport): string {
  const width = Math.max(...RUNG_NAMES.map((name) => name.length));
  const lines = report.rungs.map(
    (entry) => `${entry.rung.padEnd(width)}  ${entry.status.padEnd(7)}  ${entry.detail}`,
  );
  const failed = report.rungs.filter((entry) => entry.status === "FAIL").length;
  const unknown = report.rungs.filter((entry) => entry.status === "UNKNOWN").length;
  const verdict = report.verified
    ? "VERIFIED: all four rungs PASS"
    : `NOT VERIFIED: ${failed} FAIL, ${unknown} UNKNOWN — an unasked rung is not a passing rung`;
  return ["ship chain (merged -> published -> installed -> running):", ...lines, verdict, ""].join("\n");
}
