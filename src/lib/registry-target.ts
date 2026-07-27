/**
 * Registry targeting and artifact provenance for repo-vs-registry audits.
 *
 * Two audit surfaces — `buildReleaseCandidates` (ops-producers.ts) and
 * `getReleasePipelineParity` (repo-ops.ts) — compared a repo's declared version
 * against npmjs unconditionally. That produced a live false positive that came
 * within one review of a real incident: hasna/cli `main` 0.2.0 was reported
 * "DIVERGED" against npmjs `@hasna/cli` 0.1.0 and a publish was queued, even
 * though
 *
 *   (a) the repo declares `publishConfig.registry` `npm.pkg.github.com` with
 *       `access: "restricted"` and `tag: "internal"` — npmjs is not its
 *       registry at all;
 *   (b) its `package.json` is `UNLICENSED`, so publishing it to a public
 *       registry would have disclosed proprietary code;
 *   (c) npmjs `@hasna/cli@0.1.0` is a live deprecation redirect
 *       ("Renamed to @hasna/agency") that a publish would have overwritten; and
 *   (d) that artifact carries `gitHead`
 *       `207800eaf5bc582999b227a2ef7393b5e0991a4e`, a commit that does not
 *       exist in hasna/cli at all. The two artifacts were never related. It was
 *       a *different package that happens to share a name*, reported as a stale
 *       version.
 *
 * So the audit needs three things this module supplies, and none of them may be
 * keyed on a package name or repo name:
 *
 *   1. the registry to compare against, resolved from `publishConfig.registry`;
 *   2. a scope decision, so packages that do not publish to npmjs anonymously
 *      are classified separately rather than measured against the wrong
 *      registry (and rather than silently dropped — a dropped package is never
 *      audited by anybody);
 *   3. provenance: whether the registry artifact's `gitHead` is a commit in
 *      this repo. `gitHead` has three states, not two — reachable, absent from
 *      the repo, and *not published at all* — and the third must not collapse
 *      into either of the others.
 */

/** The public npm registry. Only an exact host match counts as npmjs. */
export const NPMJS_REGISTRY_URL = "https://registry.npmjs.org" as const;
export const NPMJS_REGISTRY_HOST = "registry.npmjs.org" as const;

/**
 * The subset of `package.json` that decides where a package publishes and
 * whether it may be published at all.
 */
export interface PublishManifest {
  name?: string | null;
  version?: string | null;
  private?: boolean | null;
  license?: string | null;
  publishConfig?: Record<string, unknown> | null;
}

export type RegistryScope =
  /** Publishes to npmjs with default (public) access — anonymously auditable. */
  | "npmjs-public"
  /** Publishes to npmjs but `access: "restricted"` — not anonymously readable. */
  | "npmjs-restricted"
  /** `publishConfig.registry` names something other than npmjs. */
  | "non-npmjs-registry"
  /** `private: true` — npm itself refuses to publish it. */
  | "private-manifest"
  /** No package name to look up. */
  | "unnamed";

/**
 * Why an audit must not propose a publish. These are manifest-derived policy
 * refusals; they do not depend on what the registry currently holds.
 */
export type PublishRefusal =
  | "unlicensed-package"
  | "private-registry"
  | "private-manifest";

export interface RegistryTarget {
  package_name: string | null;
  /** The registry an audit must compare against for this package. */
  registry_url: string;
  registry_host: string | null;
  /** Where `registry_url` came from. npmjs is a *default*, never an assumption. */
  registry_source: "publishConfig.registry" | "default-npmjs";
  is_npmjs: boolean;
  /** `publishConfig.access`, verbatim and lowercased; null when undeclared. */
  access: string | null;
  /** `publishConfig.tag`, verbatim; null when undeclared. */
  dist_tag: string | null;
  license: string | null;
  unlicensed: boolean;
  private_manifest: boolean;
  scope: RegistryScope;
  /**
   * True only when an anonymous npmjs read is a valid measurement of this
   * package's published state. False packages are *classified*, not dropped.
   */
  in_npmjs_divergence_scope: boolean;
  out_of_scope_reasons: string[];
  publish_allowed: boolean;
  publish_refusals: PublishRefusal[];
}

/** Three-valued, because "we could not tell" is not "it is not there". */
export type GitHeadReachability = "reachable" | "absent" | "unknown";

/**
 * How authoritative the manifest `name` is as the *published* name.
 *
 * hasna/aicopilot was audited as "nothing published to npm" because the audit
 * looked up `@hasna/aicopilot` and `@aicopilot/*` (all 404) while the real
 * published artifacts are unscoped names (`aicopilot-ai`, `aicopilot-linux-x64`,
 * …) synthesised by a publish script at publish time. When the publish path
 * rewrites the name, a 404 on the manifest name proves nothing.
 */
export type PackageNameAuthority = "manifest" | "publish-script";

export interface RegistryArtifactState {
  /** The registry answered at all (not offline, not auth-walled). */
  readable: boolean;
  /** The registry holds an artifact under this name. */
  published: boolean;
  version: string | null;
  /** `gitHead` from the registry manifest; null when the publisher omitted it. */
  git_head: string | null;
  git_head_reachability: GitHeadReachability;
}

export type RegistryDivergenceClassification =
  /** Repo version and registry version agree, on shared lineage. */
  | "IN-SYNC"
  /** Genuinely stale registry artifact from *this* repo's history. */
  | "DIVERGED"
  /** Registry artifact's commit is not in this repo — a name collision. */
  | "UNRELATED-NAME"
  /** No usable `gitHead`, or reachability could not be established. */
  | "PROVENANCE-UNVERIFIED"
  /** This package does not publish to npmjs anonymously; not measured here. */
  | "OUT-OF-NPMJS-SCOPE"
  /** Registry did not answer; nothing was measured. */
  | "REGISTRY-UNREADABLE"
  /** Registry has no such artifact, and the manifest name is authoritative. */
  | "NOT-PUBLISHED"
  /** Registry has no such artifact, but the publish path renames the package. */
  | "NOT-PUBLISHED-NAME-UNVERIFIED";

export interface RegistryDivergence {
  classification: RegistryDivergenceClassification;
  /** True only for `DIVERGED`. Never inferred from a version string alone. */
  divergent: boolean;
  /** True only when proposing a release/publish action is defensible. */
  publish_allowed: boolean;
  publish_refusals: string[];
  reasons: string[];
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn a `publishConfig.registry` value into an absolute URL.
 *
 * npm accepts `//npm.pkg.github.com/`, `npm.pkg.github.com`, and
 * `https://npm.pkg.github.com` for the same registry, so all three must resolve
 * to the same host — otherwise a scheme-less declaration would fall through to
 * the npmjs default and reintroduce the bug.
 */
export function normalizeRegistryUrl(value: unknown): string | null {
  const raw = trimmedString(value);
  if (!raw) return null;
  const withScheme = raw.startsWith("//")
    ? `https:${raw}`
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    // Registry URLs are compared by host, so keep the pathname (GitHub
    // Packages and Artifactory both use one) but drop a trailing slash so
    // equal registries compare equal.
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

/** Host of a normalized registry URL, lowercased; null when unparseable. */
export function registryHostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Exact host equality only.
 *
 * A substring or suffix test here would be the same defect this module exists
 * to fix: `registry.npmjs.org.example.com` ends with nothing useful and
 * `includes("registry.npmjs.org")` would accept it.
 */
export function isNpmjsRegistryHost(host: string | null): boolean {
  return host === NPMJS_REGISTRY_HOST;
}

/** `license: "UNLICENSED"` is npm's marker for "do not publish this". */
export function isUnlicensed(license: unknown): boolean {
  const value = trimmedString(license);
  return value !== null && value.toUpperCase() === "UNLICENSED";
}

/**
 * Resolve the registry an audit must compare against, plus the policy that
 * decides whether a publish may ever be proposed for this manifest.
 */
export function resolveRegistryTarget(manifest: PublishManifest | null | undefined): RegistryTarget {
  const publishConfig = manifest?.publishConfig ?? null;
  const declaredRegistry = normalizeRegistryUrl(publishConfig?.["registry"]);
  const registryUrl = declaredRegistry ?? NPMJS_REGISTRY_URL;
  const registryHost = registryHostOf(registryUrl);
  const isNpmjs = isNpmjsRegistryHost(registryHost);
  const packageName = trimmedString(manifest?.name);
  const access = trimmedString(publishConfig?.["access"])?.toLowerCase() ?? null;
  const distTag = trimmedString(publishConfig?.["tag"]);
  const license = trimmedString(manifest?.license);
  const unlicensed = isUnlicensed(manifest?.license);
  const privateManifest = manifest?.private === true;

  const outOfScopeReasons: string[] = [];
  let scope: RegistryScope;
  if (!packageName) {
    scope = "unnamed";
    outOfScopeReasons.push("package.json declares no name; there is nothing to look up");
  } else if (privateManifest) {
    scope = "private-manifest";
    outOfScopeReasons.push("package.json sets private: true; npm refuses to publish it");
  } else if (!isNpmjs) {
    scope = "non-npmjs-registry";
    outOfScopeReasons.push(
      `publishConfig.registry targets ${registryHost ?? registryUrl}, not ${NPMJS_REGISTRY_HOST}; an npmjs comparison measures a different package`,
    );
  } else if (access === "restricted") {
    scope = "npmjs-restricted";
    outOfScopeReasons.push(
      "publishConfig.access is restricted; the npmjs artifact is not anonymously readable, so an anonymous lookup cannot measure it",
    );
  } else {
    scope = "npmjs-public";
  }

  const publishRefusals: PublishRefusal[] = [];
  if (unlicensed) publishRefusals.push("unlicensed-package");
  if (!isNpmjs && declaredRegistry) publishRefusals.push("private-registry");
  if (privateManifest) publishRefusals.push("private-manifest");

  return {
    package_name: packageName,
    registry_url: registryUrl,
    registry_host: registryHost,
    registry_source: declaredRegistry ? "publishConfig.registry" : "default-npmjs",
    is_npmjs: isNpmjs,
    access,
    dist_tag: distTag,
    license,
    unlicensed,
    private_manifest: privateManifest,
    scope,
    in_npmjs_divergence_scope: scope === "npmjs-public",
    out_of_scope_reasons: outOfScopeReasons,
    publish_allowed: publishRefusals.length === 0,
    publish_refusals: publishRefusals,
  };
}

/** Human-readable form of a refusal, for gate messages and task bodies. */
export function describePublishRefusal(refusal: PublishRefusal, target: RegistryTarget): string {
  switch (refusal) {
    case "unlicensed-package":
      return "package.json license is UNLICENSED; publishing it would disclose proprietary code";
    case "private-registry":
      return `publishConfig.registry targets ${target.registry_host ?? target.registry_url}, a registry this audit does not publish to`;
    case "private-manifest":
      return "package.json sets private: true";
  }
}

/** A 7-40 char hex object name. Anything else is not a probeable commit id. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * `git cat-file -e <sha>^{commit}` — the probe both audit surfaces run.
 *
 * Shared so the two callers cannot drift into asking different questions. The
 * `^{commit}` peel matters: a tree or blob object that happens to share the id
 * prefix is not the published commit.
 */
export function gitHeadProbeArgs(gitHead: string): string[] {
  return ["cat-file", "-e", `${gitHead}^{commit}`];
}

/**
 * Errors that mean *the probe did not run*, as opposed to *the object is not
 * here*. Misreading the first as the second would label an unrelated-name
 * collision on every non-repo path.
 */
const PROBE_INFRASTRUCTURE_ERRORS = [
  "not a git repository",
  "dubious ownership",
  "detected dubious",
  "permission denied",
  "unable to read",
  "cannot open",
  "no such file or directory",
  "index file open failed",
  "bad object HEAD",
];

export interface GitHeadProbeResult {
  status: number | null;
  stderr?: string;
}

/**
 * Decide reachability of a registry artifact's `gitHead` in this repo.
 *
 * Deliberately three-valued. `absent` and `unknown` both refuse a publish, so a
 * mistake between them mislabels but cannot cause the incident this guards
 * against; collapsing either into `reachable` is what caused it.
 *
 * A shallow clone is never evidence of absence — the commit may simply not have
 * been fetched — so shallow repos return `unknown`.
 */
export function probeGitHeadReachability(opts: {
  gitHead: string | null | undefined;
  isGitRepo: boolean;
  isShallow?: boolean;
  runProbe: (gitHead: string) => GitHeadProbeResult;
}): GitHeadReachability {
  const gitHead = trimmedString(opts.gitHead);
  if (!gitHead || !SHA_PATTERN.test(gitHead)) return "unknown";
  if (!opts.isGitRepo) return "unknown";
  if (opts.isShallow === true) return "unknown";

  const probe = opts.runProbe(gitHead);
  if (probe.status === 0) return "reachable";
  const stderr = (probe.stderr ?? "").toLowerCase();
  if (PROBE_INFRASTRUCTURE_ERRORS.some((pattern) => stderr.includes(pattern))) return "unknown";
  return "absent";
}

/**
 * Classify a repo version against a registry artifact.
 *
 * The ordering is the safety property: scope and readability are settled before
 * any version string is compared, and provenance is settled before the word
 * "diverged" can be produced. `DIVERGED` is reachable only from
 * `git_head_reachability === "reachable"`.
 */
export function classifyRegistryDivergence(input: {
  target: RegistryTarget;
  repoVersion: string | null;
  artifact: RegistryArtifactState;
  nameAuthority?: PackageNameAuthority;
}): RegistryDivergence {
  const { target, artifact } = input;
  const repoVersion = trimmedString(input.repoVersion);
  const nameAuthority = input.nameAuthority ?? "manifest";
  const reasons: string[] = [];

  const refuse = (classification: RegistryDivergenceClassification): RegistryDivergence => ({
    classification,
    divergent: false,
    publish_allowed: false,
    publish_refusals: [...target.publish_refusals.map((refusal) => describePublishRefusal(refusal, target)), ...reasons],
    reasons,
  });

  if (!target.in_npmjs_divergence_scope) {
    reasons.push(...target.out_of_scope_reasons);
    return refuse("OUT-OF-NPMJS-SCOPE");
  }
  if (!artifact.readable) {
    reasons.push(`${target.registry_host ?? target.registry_url} did not answer; no comparison was made`);
    return refuse("REGISTRY-UNREADABLE");
  }
  if (!artifact.published) {
    if (nameAuthority === "publish-script") {
      reasons.push(
        `the publish path rewrites the package name, so a 404 for ${target.package_name ?? "this package"} does not establish that nothing is published`,
      );
      return refuse("NOT-PUBLISHED-NAME-UNVERIFIED");
    }
    reasons.push(`${target.registry_host ?? target.registry_url} holds no artifact under ${target.package_name ?? "this name"}`);
    // A genuinely unpublished, publishable package is the one case where the
    // audit may still propose a first release — subject to manifest policy.
    return {
      classification: "NOT-PUBLISHED",
      divergent: false,
      publish_allowed: target.publish_allowed,
      publish_refusals: target.publish_refusals.map((refusal) => describePublishRefusal(refusal, target)),
      reasons,
    };
  }
  if (artifact.git_head === null) {
    reasons.push(
      `registry artifact ${target.package_name ?? "?"}@${artifact.version ?? "?"} carries no gitHead, so it cannot be tied to this repo's history`,
    );
    return refuse("PROVENANCE-UNVERIFIED");
  }
  if (artifact.git_head_reachability === "absent") {
    reasons.push(
      `registry artifact ${target.package_name ?? "?"}@${artifact.version ?? "?"} was published from ${artifact.git_head}, which is not a commit in this repo — a different package sharing this name, not a stale version`,
    );
    return refuse("UNRELATED-NAME");
  }
  if (artifact.git_head_reachability === "unknown") {
    reasons.push(
      `could not establish whether ${artifact.git_head} is a commit in this repo, so shared lineage is unproven`,
    );
    return refuse("PROVENANCE-UNVERIFIED");
  }

  if (repoVersion && artifact.version && repoVersion === artifact.version) {
    reasons.push(`repo and ${target.registry_host} both hold ${artifact.version}`);
    return {
      classification: "IN-SYNC",
      divergent: false,
      publish_allowed: false,
      publish_refusals: [...target.publish_refusals.map((refusal) => describePublishRefusal(refusal, target)), "registry already holds this version"],
      reasons,
    };
  }
  if (!repoVersion) {
    reasons.push("repo declares no version to compare");
    return refuse("PROVENANCE-UNVERIFIED");
  }

  reasons.push(
    `repo ${repoVersion} differs from ${target.registry_host} ${artifact.version ?? "?"}, and ${artifact.git_head} is a commit in this repo`,
  );
  return {
    classification: "DIVERGED",
    divergent: true,
    publish_allowed: target.publish_allowed,
    publish_refusals: target.publish_refusals.map((refusal) => describePublishRefusal(refusal, target)),
    reasons,
  };
}

/**
 * Does the publish path rewrite the package name before publishing?
 *
 * Evidence-driven on purpose: it reads the manifest's own scripts and the
 * publish workflow text rather than carrying a list of repos that do this. A
 * hardcoded `aicopilot` special case would fix one repo and leave the next one
 * reported as "nothing published to npm".
 */
const NAME_REWRITE_PATTERNS = [
  // `pkg.name = ...`, `manifest["name"] = ...`, `json.name=...`
  /\.\s*name\s*=\s*[^=]/,
  /\[\s*["']name["']\s*\]\s*=\s*[^=]/,
  // `npm pkg set name=...`
  /npm\s+pkg\s+set\s+[^\n]*\bname\s*=/,
  // `jq '.name = ...'` / `jq ".name=..."` over a package.json
  /jq\s[^\n]*\.name\s*(=|\|=)/,
  // `--package-name <x>` / `--pkg-name <x>` style publish drivers
  /--(package|pkg)-name\b/,
];

export function detectPackageNameAuthority(sources: Array<string | null | undefined>): PackageNameAuthority {
  for (const source of sources) {
    if (typeof source !== "string" || source.length === 0) continue;
    if (NAME_REWRITE_PATTERNS.some((pattern) => pattern.test(source))) return "publish-script";
  }
  return "manifest";
}
