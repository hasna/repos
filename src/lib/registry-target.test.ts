import { describe, expect, test } from "bun:test";
import {
  classifyRegistryDivergence,
  detectPackageNameAuthority,
  gitHeadProbeArgs,
  isNpmjsRegistryHost,
  isUnlicensed,
  normalizeRegistryUrl,
  probeGitHeadReachability,
  registryHostOf,
  resolveRegistryTarget,
  type RegistryArtifactState,
} from "./registry-target.js";

/**
 * The fixture is the live false positive, not a synthetic one.
 *
 * hasna/cli `main` was 0.2.0; npmjs `@hasna/cli` dist-tags.latest was 0.1.0
 * with gitHead 207800eaf5bc582999b227a2ef7393b5e0991a4e — a commit that does
 * not exist in hasna/cli — and a deprecation redirect body ("Renamed to
 * @hasna/agency"). The repo manifest is UNLICENSED and publishes to
 * npm.pkg.github.com with access=restricted and tag=internal.
 *
 * Verified against the registry on 2026-07-27:
 *   curl -fsS https://registry.npmjs.org/@hasna%2Fcli
 *     -> dist-tags.latest = 0.1.0
 *     -> versions["0.1.0"].gitHead = 207800eaf5bc582999b227a2ef7393b5e0991a4e
 *     -> versions["0.1.0"].deprecated = "Renamed to @hasna/agency — ..."
 */
const HASNA_CLI_MANIFEST = {
  name: "@hasna/cli",
  version: "0.2.0",
  license: "UNLICENSED",
  publishConfig: {
    registry: "https://npm.pkg.github.com",
    access: "restricted",
    tag: "internal",
  },
} as const;

const HASNA_CLI_NPMJS_ARTIFACT: RegistryArtifactState = {
  readable: true,
  published: true,
  version: "0.1.0",
  git_head: "207800eaf5bc582999b227a2ef7393b5e0991a4e",
  git_head_reachability: "absent",
};

describe("registry url resolution", () => {
  test("resolves the comparison registry from publishConfig.registry", () => {
    const target = resolveRegistryTarget(HASNA_CLI_MANIFEST);

    expect(target.registry_url).toBe("https://npm.pkg.github.com");
    expect(target.registry_host).toBe("npm.pkg.github.com");
    expect(target.registry_source).toBe("publishConfig.registry");
    expect(target.is_npmjs).toBe(false);
  });

  test("defaults to npmjs only when publishConfig.registry is unset", () => {
    const target = resolveRegistryTarget({ name: "@hasna/repos", version: "0.1.36" });

    expect(target.registry_url).toBe("https://registry.npmjs.org");
    expect(target.registry_source).toBe("default-npmjs");
    expect(target.is_npmjs).toBe(true);
    expect(target.in_npmjs_divergence_scope).toBe(true);
  });

  test("normalizes the scheme-less and protocol-relative forms npm accepts", () => {
    // All three are the same registry to npm. If any of them fell through to
    // the npmjs default, the audit would compare against the wrong registry.
    for (const declared of ["npm.pkg.github.com", "//npm.pkg.github.com/", "https://npm.pkg.github.com/"]) {
      const target = resolveRegistryTarget({ name: "@x/y", publishConfig: { registry: declared } });
      expect(target.registry_host).toBe("npm.pkg.github.com");
      expect(target.is_npmjs).toBe(false);
      expect(target.registry_source).toBe("publishConfig.registry");
    }
  });

  test("keeps a registry path segment and drops only the trailing slash", () => {
    expect(normalizeRegistryUrl("https://artifactory.example.com/api/npm/npm-local/"))
      .toBe("https://artifactory.example.com/api/npm/npm-local");
    expect(registryHostOf("https://artifactory.example.com/api/npm/npm-local")).toBe("artifactory.example.com");
  });

  test("treats an unparseable registry declaration as undeclared", () => {
    const target = resolveRegistryTarget({ name: "@x/y", publishConfig: { registry: "   " } });
    expect(target.registry_source).toBe("default-npmjs");
  });

  test("matches the npmjs host exactly, never by substring", () => {
    expect(isNpmjsRegistryHost("registry.npmjs.org")).toBe(true);
    // A lookalike host must not be accepted as npmjs — that is the same
    // substring defect this work exists to remove.
    expect(isNpmjsRegistryHost("registry.npmjs.org.evil.example.com")).toBe(false);
    expect(isNpmjsRegistryHost("my-registry.npmjs.org")).toBe(false);
    expect(isNpmjsRegistryHost(null)).toBe(false);
    const spoof = resolveRegistryTarget({ name: "@x/y", publishConfig: { registry: "https://registry.npmjs.org.evil.example.com" } });
    expect(spoof.is_npmjs).toBe(false);
    expect(spoof.in_npmjs_divergence_scope).toBe(false);
  });
});

describe("scope classification", () => {
  test("classifies a non-npmjs registry out of npmjs scope with a stated reason", () => {
    const target = resolveRegistryTarget(HASNA_CLI_MANIFEST);

    expect(target.scope).toBe("non-npmjs-registry");
    expect(target.in_npmjs_divergence_scope).toBe(false);
    // Separately classified, not silently dropped: the reason has to travel
    // with the finding or nobody ever audits these packages.
    expect(target.out_of_scope_reasons.join(" ")).toContain("npm.pkg.github.com");
  });

  test("classifies access=restricted on npmjs separately from public npmjs", () => {
    const target = resolveRegistryTarget({
      name: "@hasnaxyz/internal-thing",
      version: "1.2.3",
      publishConfig: { access: "restricted" },
    });

    expect(target.is_npmjs).toBe(true);
    expect(target.scope).toBe("npmjs-restricted");
    expect(target.in_npmjs_divergence_scope).toBe(false);
    expect(target.out_of_scope_reasons.join(" ")).toContain("restricted");
    // Restricted access is not a publish refusal — @hasnaxyz packages do
    // legitimately publish to npmjs. It only means an anonymous read cannot
    // measure them.
    expect(target.publish_allowed).toBe(true);
  });

  test("classifies private: true and unnamed manifests out of scope", () => {
    expect(resolveRegistryTarget({ name: "@x/y", private: true }).scope).toBe("private-manifest");
    expect(resolveRegistryTarget({ version: "1.0.0" }).scope).toBe("unnamed");
    expect(resolveRegistryTarget(null).in_npmjs_divergence_scope).toBe(false);
  });
});

describe("publish refusal", () => {
  test("refuses a publish for the UNLICENSED private-registry fixture", () => {
    const target = resolveRegistryTarget(HASNA_CLI_MANIFEST);

    expect(target.unlicensed).toBe(true);
    expect(target.publish_allowed).toBe(false);
    expect(target.publish_refusals).toEqual(expect.arrayContaining(["unlicensed-package", "private-registry"]));
  });

  test("refuses on UNLICENSED alone, even on public npmjs", () => {
    const target = resolveRegistryTarget({ name: "@x/y", version: "1.0.0", license: "UNLICENSED" });

    expect(target.in_npmjs_divergence_scope).toBe(true);
    expect(target.publish_allowed).toBe(false);
    expect(target.publish_refusals).toEqual(["unlicensed-package"]);
  });

  test("recognizes UNLICENSED regardless of case and padding", () => {
    expect(isUnlicensed(" unlicensed ")).toBe(true);
    expect(isUnlicensed("UNLICENSED")).toBe(true);
    // "Unlicense" is a real permissive licence and is NOT "UNLICENSED".
    expect(isUnlicensed("Unlicense")).toBe(false);
    expect(isUnlicensed("Apache-2.0")).toBe(false);
    expect(isUnlicensed(undefined)).toBe(false);
  });

  test("allows a publish for a plain licensed public npmjs package", () => {
    const target = resolveRegistryTarget({ name: "@hasna/repos", version: "0.1.36", license: "Apache-2.0" });

    expect(target.publish_allowed).toBe(true);
    expect(target.publish_refusals).toEqual([]);
  });
});

describe("gitHead reachability probe", () => {
  test("asks git for the peeled commit object", () => {
    expect(gitHeadProbeArgs("207800eaf5bc582999b227a2ef7393b5e0991a4e"))
      .toEqual(["cat-file", "-e", "207800eaf5bc582999b227a2ef7393b5e0991a4e^{commit}"]);
  });

  test("reports reachable on exit 0", () => {
    const seen: string[] = [];
    const reachability = probeGitHeadReachability({
      gitHead: "207800eaf5bc582999b227a2ef7393b5e0991a4e",
      isGitRepo: true,
      runProbe: (sha) => {
        seen.push(sha);
        return { status: 0 };
      },
    });

    expect(reachability).toBe("reachable");
    // Positive control: the probe actually ran with the sha under test. Without
    // this the assertion above would pass on a probe that was never called.
    expect(seen).toEqual(["207800eaf5bc582999b227a2ef7393b5e0991a4e"]);
  });

  test("reports absent when git says the object is not a valid object name", () => {
    expect(probeGitHeadReachability({
      gitHead: "207800eaf5bc582999b227a2ef7393b5e0991a4e",
      isGitRepo: true,
      runProbe: () => ({ status: 128, stderr: "fatal: Not a valid object name 207800eaf5bc582999b227a2ef7393b5e0991a4e^{commit}" }),
    })).toBe("absent");
  });

  test("reports unknown rather than absent when the probe itself could not run", () => {
    const cases = [
      { status: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" },
      { status: 128, stderr: "fatal: detected dubious ownership in repository at '/x'" },
      { status: 128, stderr: "error: unable to read sha1 file" },
    ];
    for (const probe of cases) {
      expect(probeGitHeadReachability({ gitHead: "abcdef1234567890", isGitRepo: true, runProbe: () => probe })).toBe("unknown");
    }
  });

  test("never reports absent for a shallow clone, a non-repo, or a malformed sha", () => {
    const called: string[] = [];
    const runProbe = (sha: string) => {
      called.push(sha);
      return { status: 1, stderr: "" };
    };

    expect(probeGitHeadReachability({ gitHead: "abcdef1234567890", isGitRepo: true, isShallow: true, runProbe })).toBe("unknown");
    expect(probeGitHeadReachability({ gitHead: "abcdef1234567890", isGitRepo: false, runProbe })).toBe("unknown");
    expect(probeGitHeadReachability({ gitHead: "not-a-sha", isGitRepo: true, runProbe })).toBe("unknown");
    expect(probeGitHeadReachability({ gitHead: null, isGitRepo: true, runProbe })).toBe("unknown");
    // Positive control on the negative assertions: none of the four above may
    // have consulted git at all.
    expect(called).toEqual([]);
  });
});

describe("divergence classification", () => {
  test("the hasna/cli case classifies as UNRELATED-NAME, not DIVERGED", () => {
    const target = resolveRegistryTarget({ ...HASNA_CLI_MANIFEST, publishConfig: {} });
    const result = classifyRegistryDivergence({
      target,
      repoVersion: "0.2.0",
      artifact: HASNA_CLI_NPMJS_ARTIFACT,
    });

    // With publishConfig emptied, scope is npmjs-public, so the ONLY thing
    // standing between this input and a "DIVERGED 0.2.0 vs 0.1.0" verdict is
    // the gitHead reachability check.
    expect(target.in_npmjs_divergence_scope).toBe(true);
    expect(result.classification).toBe("UNRELATED-NAME");
    expect(result.divergent).toBe(false);
    expect(result.publish_allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("207800eaf5bc582999b227a2ef7393b5e0991a4e");
    expect(result.reasons.join(" ")).toContain("not a commit in this repo");
  });

  test("the full hasna/cli manifest short-circuits at scope, before any version compare", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget(HASNA_CLI_MANIFEST),
      repoVersion: "0.2.0",
      artifact: HASNA_CLI_NPMJS_ARTIFACT,
    });

    expect(result.classification).toBe("OUT-OF-NPMJS-SCOPE");
    expect(result.divergent).toBe(false);
    expect(result.publish_allowed).toBe(false);
    expect(result.publish_refusals.join(" ")).toContain("UNLICENSED");
  });

  test("absent gitHead is its own state, neither reachable nor unrelated", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@x/y", version: "0.2.0" }),
      repoVersion: "0.2.0",
      // Registry manifests published by older npm, or by tooling that strips
      // git metadata, carry no gitHead at all.
      artifact: { readable: true, published: true, version: "0.1.0", git_head: null, git_head_reachability: "unknown" },
    });

    expect(result.classification).toBe("PROVENANCE-UNVERIFIED");
    expect(result.classification).not.toBe("DIVERGED");
    expect(result.classification).not.toBe("UNRELATED-NAME");
    expect(result.divergent).toBe(false);
    expect(result.publish_allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("carries no gitHead");
  });

  test("unknown reachability does not license a divergence claim", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@x/y", version: "0.2.0" }),
      repoVersion: "0.2.0",
      artifact: { readable: true, published: true, version: "0.1.0", git_head: "abcdef1234567890", git_head_reachability: "unknown" },
    });

    expect(result.classification).toBe("PROVENANCE-UNVERIFIED");
    expect(result.divergent).toBe(false);
  });

  test("reports DIVERGED only when the registry commit is in this repo", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@hasna/repos", version: "0.2.0", license: "Apache-2.0" }),
      repoVersion: "0.2.0",
      artifact: { readable: true, published: true, version: "0.1.0", git_head: "abcdef1234567890", git_head_reachability: "reachable" },
    });

    expect(result.classification).toBe("DIVERGED");
    expect(result.divergent).toBe(true);
    expect(result.publish_allowed).toBe(true);
  });

  test("reports IN-SYNC and refuses a republish when versions match", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@hasna/repos", version: "0.1.36", license: "Apache-2.0" }),
      repoVersion: "0.1.36",
      artifact: { readable: true, published: true, version: "0.1.36", git_head: "abcdef1234567890", git_head_reachability: "reachable" },
    });

    expect(result.classification).toBe("IN-SYNC");
    expect(result.divergent).toBe(false);
    expect(result.publish_allowed).toBe(false);
  });

  test("an unreadable registry is not a divergence and not an absence", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@hasna/repos", version: "0.2.0" }),
      repoVersion: "0.2.0",
      artifact: { readable: false, published: false, version: null, git_head: null, git_head_reachability: "unknown" },
    });

    expect(result.classification).toBe("REGISTRY-UNREADABLE");
    expect(result.publish_allowed).toBe(false);
  });

  test("a genuinely unpublished licensed package may still be proposed for release", () => {
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@hasna/brand-new", version: "0.1.0", license: "Apache-2.0" }),
      repoVersion: "0.1.0",
      artifact: { readable: true, published: false, version: null, git_head: null, git_head_reachability: "unknown" },
    });

    expect(result.classification).toBe("NOT-PUBLISHED");
    expect(result.publish_allowed).toBe(true);
  });

  test("a 404 is not an absence when the publish path renames the package", () => {
    // hasna/aicopilot: the audit reported "nothing published to npm" after
    // 404s on @hasna/aicopilot and @aicopilot/*, while the real artifacts are
    // unscoped names (aicopilot-ai, aicopilot-linux-x64, ...) synthesised at
    // publish time.
    const result = classifyRegistryDivergence({
      target: resolveRegistryTarget({ name: "@hasna/aicopilot", version: "0.3.0", license: "Apache-2.0" }),
      repoVersion: "0.3.0",
      artifact: { readable: true, published: false, version: null, git_head: null, git_head_reachability: "unknown" },
      nameAuthority: "publish-script",
    });

    expect(result.classification).toBe("NOT-PUBLISHED-NAME-UNVERIFIED");
    expect(result.publish_allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("rewrites the package name");
  });
});

describe("published-name authority detection", () => {
  test("detects a publish script that rewrites the package name", () => {
    const sources = [
      "node -e \"const p=require('./package.json'); p.name = `aicopilot-${process.env.TARGET}`; require('fs').writeFileSync('package.json', JSON.stringify(p))\"",
      "npm pkg set name=aicopilot-linux-x64 && npm publish",
      "jq '.name = $n' package.json > tmp && mv tmp package.json",
      "bun run publish.ts --package-name aicopilot-ai",
    ];
    for (const source of sources) {
      expect(detectPackageNameAuthority([source])).toBe("publish-script");
    }
  });

  test("leaves the manifest authoritative for an ordinary publish script", () => {
    expect(detectPackageNameAuthority([
      "bun run typecheck && bun test && bun run build",
      "npm publish --access public",
      // A name *comparison* is not a name rewrite.
      "if [ \"$(jq -r .name package.json)\" = \"@hasna/repos\" ]; then npm publish; fi",
      null,
      undefined,
      "",
    ])).toBe("manifest");
  });
});
