/**
 * Dependent detection that requires an exact dependency edge in a manifest.
 *
 * Same root cause as the registry divergence false positive: naive matching.
 * GitHub code search is substring matching, and during the 2026-07 OSS cleanup
 * wave it produced dependents that had to be discarded one by one by hand:
 *
 *   - `hasna/clip` (declares `@hasna/clip`) and `hasnaxyz/iapp-clips`
 *     (declares `@hasna/clips`) both matched a search for `"@hasna/cli"`;
 *   - `identities-mcp` / `identities-serve` matched `entities-mcp` /
 *     `entities-serve`;
 *   - `hasna/browserplan`'s Chromium *identity API* code matched `entity_get`.
 *
 * A text hit is a place to look, never a finding. Anything automated must
 * confirm the edge in a manifest: an exact key in a dependency map, or an exact
 * element of a bundled-dependency array.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Dependency maps npm resolves package names through, keyed by exact name. */
export const MANIFEST_DEPENDENCY_MAP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
] as const;

/** Dependency fields that are arrays of exact package names. */
export const MANIFEST_DEPENDENCY_LIST_FIELDS = [
  "bundleDependencies",
  "bundledDependencies",
] as const;

export type ManifestDependencyField =
  | (typeof MANIFEST_DEPENDENCY_MAP_FIELDS)[number]
  | (typeof MANIFEST_DEPENDENCY_LIST_FIELDS)[number];

export interface ManifestDependencyEdge {
  field: ManifestDependencyField;
  /** The declared range, or null for list-shaped fields that carry no range. */
  range: string | null;
}

export type DependentRejectionReason =
  | "no-manifest"
  | "unparseable-manifest"
  | "substring-only-match"
  | "no-dependency-edge";

export interface ManifestDependentEdge extends ManifestDependencyEdge {
  manifest: string;
}

export interface ManifestDependentFinding {
  /** Caller's identifier for the candidate: repo path, full name, whatever. */
  candidate: string;
  confirmed: boolean;
  edges: ManifestDependentEdge[];
  rejection: DependentRejectionReason | null;
  /**
   * Names the candidate declares that *contain* the queried name without being
   * it. Recorded rather than dropped, because these are exactly the hits a
   * substring search would have reported as dependents.
   */
  near_miss_names: string[];
  /** Manifests that were present but could not be parsed. */
  unparseable: string[];
}

export interface ManifestInput {
  path: string;
  /** Parsed manifest, or raw JSON text to parse. */
  json?: unknown;
  text?: string;
}

export interface DependentCandidateInput {
  candidate: string;
  manifests: ManifestInput[];
}

/**
 * Exact package-name equality.
 *
 * The whole module exists because `includes` was used where this belongs.
 * npm package names are case-sensitive in practice for scoped names, so this is
 * a plain trimmed equality — no lowercasing, no prefix logic.
 */
export function dependencyNamesMatch(declared: unknown, packageName: string): boolean {
  return typeof declared === "string" && declared.trim() === packageName.trim();
}

/**
 * True when `declaredName` would satisfy a substring search for `packageName`
 * without being a dependency on it — `@hasna/clip` against `@hasna/cli`.
 *
 * Exposed so callers can report what a naive search would have claimed instead
 * of silently discarding it.
 */
export function isSubstringOnlyMatch(declaredName: unknown, packageName: string): boolean {
  if (typeof declaredName !== "string") return false;
  const declared = declaredName.trim();
  const wanted = packageName.trim();
  if (declared.length === 0 || wanted.length === 0) return false;
  return declared !== wanted && (declared.includes(wanted) || wanted.includes(declared));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Every exact dependency edge a single manifest declares on `packageName`.
 *
 * Uses own-property lookup, not iteration with a text test, so a manifest that
 * declares `@hasna/cli-helper` cannot produce an edge on `@hasna/cli`.
 */
export function manifestDependencyEdges(manifest: unknown, packageName: string): ManifestDependencyEdge[] {
  const pkg = asRecord(manifest);
  if (!pkg) return [];
  const wanted = packageName.trim();
  if (wanted.length === 0) return [];
  const edges: ManifestDependencyEdge[] = [];

  for (const field of MANIFEST_DEPENDENCY_MAP_FIELDS) {
    const map = asRecord(pkg[field]);
    if (!map) continue;
    if (!Object.prototype.hasOwnProperty.call(map, wanted)) continue;
    const declared = map[wanted];
    edges.push({ field, range: typeof declared === "string" ? declared : null });
  }

  for (const field of MANIFEST_DEPENDENCY_LIST_FIELDS) {
    const list = pkg[field];
    if (!Array.isArray(list)) continue;
    if (!list.some((entry) => dependencyNamesMatch(entry, wanted))) continue;
    edges.push({ field, range: null });
  }

  return edges;
}

/** Every dependency name a manifest declares, across all dependency fields. */
export function manifestDependencyNames(manifest: unknown): string[] {
  const pkg = asRecord(manifest);
  if (!pkg) return [];
  const names = new Set<string>();
  for (const field of MANIFEST_DEPENDENCY_MAP_FIELDS) {
    const map = asRecord(pkg[field]);
    if (!map) continue;
    for (const name of Object.keys(map)) names.add(name);
  }
  for (const field of MANIFEST_DEPENDENCY_LIST_FIELDS) {
    const list = pkg[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (typeof entry === "string") names.add(entry);
  }
  // The candidate's own name is what made `hasna/clip` and `iapp-clips` look
  // like dependents of `@hasna/cli`, so it counts as a near-miss source.
  if (typeof pkg["name"] === "string") names.add(pkg["name"]);
  return [...names];
}

export interface ManifestDependentsResult {
  package_name: string;
  confirmed: ManifestDependentFinding[];
  rejected: ManifestDependentFinding[];
  summary: {
    candidates: number;
    confirmed: number;
    rejected: number;
    /** Candidates rejected specifically because the hit was substring-only. */
    substring_only: number;
  };
}

/**
 * Confirm or reject dependent candidates against their manifests.
 *
 * Candidates come from wherever — a code search, a local scan, a registry
 * query. This function is the gate they have to pass, and it never consults the
 * candidate's name or path to decide.
 */
export function confirmManifestDependents(opts: {
  packageName: string;
  candidates: DependentCandidateInput[];
}): ManifestDependentsResult {
  const packageName = opts.packageName.trim();
  const confirmed: ManifestDependentFinding[] = [];
  const rejected: ManifestDependentFinding[] = [];

  for (const candidate of opts.candidates) {
    const edges: ManifestDependentEdge[] = [];
    const nearMisses = new Set<string>();
    const unparseable: string[] = [];
    let parsedAny = false;

    for (const manifest of candidate.manifests) {
      let json: unknown = manifest.json;
      if (json === undefined) {
        if (typeof manifest.text !== "string") continue;
        try {
          json = JSON.parse(manifest.text);
        } catch {
          unparseable.push(manifest.path);
          continue;
        }
      }
      parsedAny = true;
      for (const edge of manifestDependencyEdges(json, packageName)) {
        edges.push({ manifest: manifest.path, ...edge });
      }
      for (const name of manifestDependencyNames(json)) {
        if (isSubstringOnlyMatch(name, packageName)) nearMisses.add(name);
      }
    }

    const near_miss_names = [...nearMisses].sort();
    if (edges.length > 0) {
      confirmed.push({ candidate: candidate.candidate, confirmed: true, edges, rejection: null, near_miss_names, unparseable });
      continue;
    }

    const rejection: DependentRejectionReason = !parsedAny
      ? unparseable.length > 0
        ? "unparseable-manifest"
        : "no-manifest"
      : near_miss_names.length > 0
        ? "substring-only-match"
        : "no-dependency-edge";
    rejected.push({ candidate: candidate.candidate, confirmed: false, edges: [], rejection, near_miss_names, unparseable });
  }

  return {
    package_name: packageName,
    confirmed,
    rejected,
    summary: {
      candidates: opts.candidates.length,
      confirmed: confirmed.length,
      rejected: rejected.length,
      substring_only: rejected.filter((finding) => finding.rejection === "substring-only-match").length,
    },
  };
}

/** Directories that never hold a first-party manifest worth confirming. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".output",
  "coverage",
  "vendor",
  "target",
  ".venv",
]);

/**
 * Collect first-party `package.json` files under a repo root.
 *
 * Walks into workspace packages, because a monorepo's dependency edge usually
 * lives in a workspace member and a root-only read would reject a real
 * dependent. `node_modules` is skipped: a transitive copy of the package inside
 * an install tree is not a declared edge.
 */
export function collectRepoManifests(
  repoRoot: string,
  opts: { maxDepth?: number; maxManifests?: number } = {},
): ManifestInput[] {
  const maxDepth = Math.max(0, opts.maxDepth ?? 4);
  const maxManifests = Math.max(1, opts.maxManifests ?? 200);
  const manifests: ManifestInput[] = [];

  const walk = (dir: string, depth: number): void => {
    if (manifests.length >= maxManifests) return;
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        manifests.push({ path: relative(repoRoot, manifestPath) || "package.json", text: readFileSync(manifestPath, "utf-8") });
      } catch {
        // Unreadable manifests are reported as absent rather than guessed at.
      }
    }
    if (depth >= maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (SKIP_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, depth + 1);
      if (manifests.length >= maxManifests) return;
    }
  };

  walk(repoRoot, 0);
  return manifests;
}
