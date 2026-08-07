import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
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
  "not asked: no install context was supplied, so no running artefact was checked";
const RELEASE_CLI_BIN_NAME = "repos";

export interface InstalledRungOptions {
  /** Package name to resolve on disk, e.g. "@hasna/repos". */
  packageName: string;
  expectedCommit: string;
  expectedExecutableSha256: string;
  /** node_modules root to resolve in. Defaults to the global bun install root. */
  installRoot?: string;
}

export interface RunningRungOptions extends InstalledRungOptions {
  /** Version the exact installed CLI must report from a fresh --version probe. */
  expectedPackageVersion?: string;
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

function digestOpenedExecutable(descriptor: number):
  | { ok: true; sha256: string }
  | { ok: false; reason: string } {
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) return { ok: false, reason: "unreadable (not a regular file)" };
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position,
      );
      if (count === 0) {
        return { ok: false, reason: "changed while its opened descriptor was being digested" };
      }
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size) {
      return { ok: false, reason: "changed size while its opened descriptor was being digested" };
    }
    return { ok: true, sha256: hash.digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown I/O error";
    return { ok: false, reason: `unreadable (${code})` };
  }
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

function runningProbeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // A version probe needs no credentials. Pass only the runtime/config values
  // Bun needs instead of giving an installed executable every secret inherited
  // by the verifier process.
  const result: NodeJS.ProcessEnv = {
    HASNA_REPOS_AUTO_BOOTSTRAP: "0",
    NO_COLOR: "1",
  };
  for (const name of ["HOME", "PATH", "BUN_INSTALL", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * The RUNNING rung for a one-shot CLI. "Running" cannot mean a resident
 * process here: repos starts, answers, and exits. It means this verification
 * call successfully launched the exact installed executable on this host.
 *
 * The installed identity is checked first, the pinned path is launched through
 * the same Bun runtime as the verifier with the side-effect-free --version
 * path, and the bytes are digested again afterwards. A path swap or mutation
 * during the probe therefore cannot turn a different build into PASS.
 */
export function evaluateRunningRung(options: RunningRungOptions): Rung {
  const rung = (status: RungStatus, detail: string): Rung => ({ rung: "RUNNING", status, detail });
  const installed = evaluateInstalledRung(options);
  if (installed.status !== "PASS") {
    const prefix = installed.status === "UNKNOWN" ? "not asked" : "not run";
    return rung(installed.status, `${prefix}: installed artefact is not verified: ${installed.detail}`);
  }
  if (!options.expectedPackageVersion) {
    return rung("UNKNOWN", "not asked: the verified package version is unavailable");
  }

  const root = options.installRoot ?? defaultInstallRoot();
  if (!root) {
    return rung("UNKNOWN", "not asked: no install root could be resolved (set BUN_INSTALL or --install-root)");
  }
  const packageDir = join(root, ...options.packageName.split("/"));
  const executablePath = join(packageDir, ...RELEASE_EXECUTABLE_PATH.split("/"));
  const binPath = join(root, ".bin", RELEASE_CLI_BIN_NAME);
  const descriptorPath = process.platform === "linux"
    ? "/proc/self/fd/3"
    : process.platform === "darwin"
      ? "/dev/fd/3"
      : null;
  if (!descriptorPath) {
    return rung("UNKNOWN", `not asked: descriptor-bound CLI execution is unsupported on ${process.platform}`);
  }

  let executableDescriptor: number | undefined;
  let binDescriptor: number | undefined;
  try {
    let resolvedExecutable: string;
    let resolvedBin: string;
    try {
      resolvedExecutable = realpathSync(executablePath);
      resolvedBin = realpathSync(binPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown I/O error";
      return rung("FAIL", `installed ${RELEASE_CLI_BIN_NAME} entrypoint could not be resolved (${code})`);
    }
    if (resolvedBin !== resolvedExecutable) {
      return rung(
        "FAIL",
        `installed entrypoint ${binPath} resolves to ${resolvedBin}, expected ${resolvedExecutable}`,
      );
    }

    executableDescriptor = openSync(executablePath, constants.O_RDONLY | constants.O_NONBLOCK);
    binDescriptor = openSync(binPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const executableStat = fstatSync(executableDescriptor);
    const binStat = fstatSync(binDescriptor);
    if (!binStat.isFile()) {
      return rung("FAIL", `installed entrypoint ${binPath} is not a regular file`);
    }
    if (binStat.dev !== executableStat.dev || binStat.ino !== executableStat.ino) {
      return rung("FAIL", `installed entrypoint ${binPath} did not open the pinned executable ${executablePath}`);
    }
    if ((binStat.mode & 0o111) === 0) {
      return rung("FAIL", `installed entrypoint ${binPath} is not executable`);
    }

    const before = digestOpenedExecutable(binDescriptor);
    if (!before.ok) {
      return rung("FAIL", `installed entrypoint ${binPath} is ${before.reason} before the run probe`);
    }
    if (before.sha256 !== options.expectedExecutableSha256) {
      return rung(
        "FAIL",
        `installed entrypoint ${binPath} changed before the run probe: sha256 ${before.sha256}, expected ${options.expectedExecutableSha256}`,
      );
    }

    const probe = spawnSync(descriptorPath, ["--version"], {
      cwd: packageDir,
      encoding: "utf8",
      env: runningProbeEnvironment(),
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe", binDescriptor],
    });

    const after = digestOpenedExecutable(binDescriptor);
    if (!after.ok) {
      return rung("FAIL", `installed entrypoint ${binPath} is ${after.reason} after the run probe`);
    }
    if (after.sha256 !== options.expectedExecutableSha256 || after.sha256 !== before.sha256) {
      return rung(
        "FAIL",
        `opened installed executable changed during the run probe: before ${before.sha256}, after ${after.sha256}, expected ${options.expectedExecutableSha256}`,
      );
    }

    let resolvedBinAfter: string;
    try {
      resolvedBinAfter = realpathSync(binPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown I/O error";
      return rung("FAIL", `installed ${RELEASE_CLI_BIN_NAME} entrypoint changed during the run probe (${code})`);
    }
    if (resolvedBinAfter !== resolvedExecutable) {
      return rung(
        "FAIL",
        `installed entrypoint changed during the run probe: ${binPath} now resolves to ${resolvedBinAfter}`,
      );
    }

    if (probe.error) {
      const code = (probe.error as NodeJS.ErrnoException).code ?? probe.error.name;
      return rung("FAIL", `exact installed CLI could not complete the bounded --version probe (${code})`);
    }
    if (probe.status !== 0) {
      const outcome = probe.signal ? `signal ${probe.signal}` : `status ${String(probe.status)}`;
      return rung("FAIL", `exact installed CLI --version probe exited with ${outcome}`);
    }
    const actualVersion = String(probe.stdout ?? "").trim();
    if (actualVersion !== options.expectedPackageVersion) {
      return rung(
        "FAIL",
        `exact installed CLI reported version ${JSON.stringify(actualVersion)}, expected ${JSON.stringify(options.expectedPackageVersion)}`,
      );
    }

    return rung(
      "PASS",
      `${hostname()} launched ${binPath} through its verified descriptor with --version: exit 0, version ${actualVersion}, executable sha256 ${after.sha256} before and after`,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return rung("FAIL", `installed entrypoint could not be opened for the run probe: ${code ?? message}`);
  } finally {
    for (const descriptor of [binDescriptor, executableDescriptor]) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // A close error cannot change the already classified probe result.
        }
      }
    }
  }
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

function safeRunningRung(options: RunningRungOptions): Rung {
  try {
    return evaluateRunningRung(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rung: "RUNNING", status: "FAIL", detail: `run probe could not be completed: ${message}` };
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
  const runningRung: Rung = !installed
    ? { rung: "RUNNING", status: "UNKNOWN", detail: UNASKED_RUNNING }
    : !packageName
      ? {
        rung: "RUNNING",
        status: "UNKNOWN",
        detail: "not asked: package name unknown (pass --installed-package to probe a failed provenance candidate)",
      }
      : safeRunningRung({
        packageName,
        expectedCommit: installed.expectedCommit,
        expectedExecutableSha256: installed.expectedExecutableSha256,
        expectedPackageVersion: receipt?.package_version,
        installRoot: installed.installRoot,
      });

  return finish([
    merged,
    published,
    installedRung,
    runningRung,
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
