import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_PROVENANCE_SCHEMA } from "./provenance.js";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

const packageRecord = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  name: string;
  version: string;
};
const executablePath = resolve("dist/cli/index.js");
const executable = readFileSync(executablePath);
const sourceStatus = git("status", "--porcelain", "--untracked-files=all");
if (sourceStatus !== "") {
  throw new Error("refusing to write release provenance from a dirty source tree");
}
const provenance = {
  schema: RELEASE_PROVENANCE_SCHEMA,
  exact_commit: git("rev-parse", "HEAD"),
  exact_tree: git("rev-parse", "HEAD^{tree}"),
  source_clean: true,
  package_name: packageRecord.name,
  package_version: packageRecord.version,
  executable_path: "dist/cli/index.js",
  executable_sha256: createHash("sha256").update(executable).digest("hex"),
};
writeFileSync(resolve("dist/release-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", {
  mode: 0o644,
});
