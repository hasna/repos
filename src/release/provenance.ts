import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const RELEASE_PROVENANCE_SCHEMA = "open-repos.release-provenance.v1" as const;
export const RELEASE_VERIFICATION_SCHEMA = "open-repos.release-verification.v1" as const;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ReleaseProvenance {
  schema: typeof RELEASE_PROVENANCE_SCHEMA;
  exact_commit: string;
  exact_tree: string;
  source_clean: true;
  package_name: string;
  package_version: string;
  executable_path: string;
  executable_sha256: string;
}

export interface VerifyReleaseProvenanceOptions {
  expectedCommit: string;
  expectedTree: string;
  expectedPackageSha256: string;
  expectedExecutableSha256: string;
  packagePath: string;
  executablePath: string;
}

export interface ReleaseVerificationReceipt {
  schema: typeof RELEASE_VERIFICATION_SCHEMA;
  exact_commit: string;
  exact_tree: string;
  package_name: string;
  package_version: string;
  package_sha256: string;
  executable_sha256: string;
  provenance_sha256: string;
}

export interface ReleaseArtifactReader {
  readFile(path: string): Buffer;
  readArchiveEntry(path: string, entry: string): Buffer;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function releaseFailure(message: string): never {
  throw new Error("release provenance verification failed: " + message);
}

function parseProvenance(bytes: Buffer): ReleaseProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    releaseFailure("invalid provenance record");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    releaseFailure("invalid provenance record");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "exact_commit",
    "exact_tree",
    "executable_path",
    "executable_sha256",
    "package_name",
    "package_version",
    "schema",
    "source_clean",
  ].sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || record["schema"] !== RELEASE_PROVENANCE_SCHEMA
    || !OBJECT_ID.test(String(record["exact_commit"] ?? ""))
    || !OBJECT_ID.test(String(record["exact_tree"] ?? ""))
    || record["source_clean"] !== true
    || typeof record["package_name"] !== "string"
    || record["package_name"].length === 0
    || typeof record["package_version"] !== "string"
    || record["package_version"].length === 0
    || record["executable_path"] !== "dist/cli/index.js"
    || !SHA256.test(String(record["executable_sha256"] ?? ""))
  ) releaseFailure("invalid provenance record");
  return record as unknown as ReleaseProvenance;
}

const defaultReader: ReleaseArtifactReader = {
  readFile: (path) => readFileSync(path),
  readArchiveEntry: (path, entry) => execFileSync("tar", ["-xOf", path, entry], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 128 * 1024 * 1024,
  }),
};

export function verifyReleaseProvenance(
  options: VerifyReleaseProvenanceOptions,
  reader: ReleaseArtifactReader = defaultReader,
): ReleaseVerificationReceipt {
  if (
    !OBJECT_ID.test(options.expectedCommit)
    || !OBJECT_ID.test(options.expectedTree)
    || !SHA256.test(options.expectedPackageSha256)
    || !SHA256.test(options.expectedExecutableSha256)
  ) releaseFailure("invalid expected identity");

  // Bind the outer package bytes first. No archive content or registry state is
  // consulted until the caller-supplied release digest is proven exact.
  const packageBytes = reader.readFile(options.packagePath);
  const packageSha256 = sha256(packageBytes);
  if (packageSha256 !== options.expectedPackageSha256) releaseFailure("package digest mismatch");

  const provenanceBytes = reader.readArchiveEntry(
    options.packagePath,
    "package/dist/release-provenance.json",
  );
  const provenance = parseProvenance(provenanceBytes);
  if (
    provenance.exact_commit !== options.expectedCommit
    || provenance.exact_tree !== options.expectedTree
  ) releaseFailure("source identity mismatch");

  const executableBytes = reader.readFile(options.executablePath);
  const packagedExecutable = reader.readArchiveEntry(
    options.packagePath,
    "package/" + provenance.executable_path,
  );
  const executableSha256 = sha256(executableBytes);
  if (
    executableSha256 !== options.expectedExecutableSha256
    || executableSha256 !== provenance.executable_sha256
    || sha256(packagedExecutable) !== executableSha256
  ) releaseFailure("executable digest mismatch");

  return {
    schema: RELEASE_VERIFICATION_SCHEMA,
    exact_commit: provenance.exact_commit,
    exact_tree: provenance.exact_tree,
    package_name: provenance.package_name,
    package_version: provenance.package_version,
    package_sha256: packageSha256,
    executable_sha256: executableSha256,
    provenance_sha256: sha256(provenanceBytes),
  };
}
