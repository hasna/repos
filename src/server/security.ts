import { resolve } from "node:path";
import { getWorkspaceRoots } from "../lib/config.js";

export const SERVER_HOSTNAME = "127.0.0.1";
export const SCAN_REQUEST_HEADER = "X-Repos-Scan";
export const SCAN_REQUEST_HEADER_VALUE = "1";

export function isTrustedScanRequest(req: Request): boolean {
  if (req.headers.get(SCAN_REQUEST_HEADER) !== SCAN_REQUEST_HEADER_VALUE) return false;

  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}

export function resolveConfiguredScanRoots(value: unknown): string[] {
  const configuredRoots = getWorkspaceRoots();
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return configuredRoots;
  }
  if (!Array.isArray(value) || value.some((root) => typeof root !== "string" || root.length === 0)) {
    throw new TypeError("roots must be an array of non-empty paths");
  }

  const allowedRoots = new Set(configuredRoots);
  const requestedRoots = [...new Set(value.map((root) => resolve(root)))];
  if (requestedRoots.some((root) => !allowedRoots.has(root))) {
    throw new RangeError("roots must be selected from the configured workspace roots");
  }
  return requestedRoots;
}
