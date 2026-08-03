import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseVerificationReceipt } from "./provenance.js";

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

  let executablePath = join(packageDir, "dist", "cli", "index.js");
  let installedCommit: string | null = null;
  const provenancePath = join(packageDir, "dist", "release-provenance.json");
  if (existsSync(provenancePath)) {
    try {
      const record = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
      if (typeof record["exact_commit"] === "string") installedCommit = record["exact_commit"];
      if (typeof record["executable_path"] === "string") {
        executablePath = join(packageDir, ...record["executable_path"].split("/"));
      }
    } catch {
      return rung("UNKNOWN", `not asked: ${provenancePath} is present but unreadable as JSON`);
    }
  }

  if (!existsSync(executablePath)) {
    return rung("FAIL", `${options.packageName} is installed but ${executablePath} is missing`);
  }
  const installedSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
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
      : evaluateInstalledRung({
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
