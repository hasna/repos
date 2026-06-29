import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const FALLBACK_CLI_VERSION = "0.0.0";
const PACKAGE_NAME = "@hasna/repos";

export function parseVersionFromPackageJson(raw: string, fallback = FALLBACK_CLI_VERSION): string {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // ignore parse errors and use fallback
  }

  return fallback;
}

function readVersionFromPackageJson(packageJsonPath: string): string {
  try {
    const raw = readFileSync(packageJsonPath, "utf-8");
    return parseVersionFromPackageJson(raw);
  } catch {
    return FALLBACK_CLI_VERSION;
  }
}

export function getCliVersionFromDir(startDir: string): string {
  let current = resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const raw = readFileSync(packageJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (parsed.name === PACKAGE_NAME) {
          return parseVersionFromPackageJson(raw);
        }
      } catch {
        // Keep walking upward; malformed parent package metadata should not break version flags.
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return FALLBACK_CLI_VERSION;
}

export function getCliVersion(packageJsonPath?: string): string {
  if (packageJsonPath) return readVersionFromPackageJson(packageJsonPath);
  return getCliVersionFromDir(import.meta.dir);
}
