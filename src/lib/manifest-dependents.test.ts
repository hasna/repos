import { describe, expect, test } from "bun:test";
import {
  confirmManifestDependents,
  dependencyNamesMatch,
  isSubstringOnlyMatch,
  manifestDependencyEdges,
  manifestDependencyNames,
} from "./manifest-dependents.js";

describe("exact dependency edges", () => {
  test("finds an edge in every dependency field, keyed exactly", () => {
    const manifest = {
      name: "consumer",
      dependencies: { "@hasna/cli": "^0.2.0" },
      devDependencies: { "@hasna/cli": "workspace:*" },
      peerDependencies: { "@hasna/cli": ">=0.1.0" },
      optionalDependencies: { "@hasna/cli": "0.1.0" },
      overrides: { "@hasna/cli": "0.2.0" },
      resolutions: { "@hasna/cli": "0.2.0" },
      bundleDependencies: ["@hasna/cli"],
      bundledDependencies: ["@hasna/cli"],
    };

    const edges = manifestDependencyEdges(manifest, "@hasna/cli");

    expect(edges.map((edge) => edge.field)).toEqual([
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "overrides",
      "resolutions",
      "bundleDependencies",
      "bundledDependencies",
    ]);
    expect(edges[0]!.range).toBe("^0.2.0");
    expect(edges[6]!.range).toBeNull();
  });

  test("declaring a longer name that contains the query is not an edge", () => {
    // The exact wave failures: hasna/clip declares @hasna/clip and
    // hasnaxyz/iapp-clips declares @hasna/clips; both matched a GitHub code
    // search for "@hasna/cli".
    const clip = { name: "@hasna/clip", dependencies: { "@hasna/clip": "^0.1.0" } };
    const clips = { name: "@hasna/clips", dependencies: { "@hasna/clips": "^0.1.0" } };
    const helper = { name: "x", dependencies: { "@hasna/cli-helper": "^1.0.0" } };

    expect(manifestDependencyEdges(clip, "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges(clips, "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges(helper, "@hasna/cli")).toEqual([]);
    // Positive control: the same call shape does find the real edge, so the
    // three empty results above are not an always-empty function.
    expect(manifestDependencyEdges({ dependencies: { "@hasna/cli": "^0.2.0" } }, "@hasna/cli")).toHaveLength(1);
  });

  test("a shorter declared name that the query contains is not an edge either", () => {
    // identities-mcp / identities-serve matched entities-mcp / entities-serve
    // in both directions during the wave.
    expect(manifestDependencyEdges({ dependencies: { "entities-mcp": "1.0.0" } }, "identities-mcp")).toEqual([]);
    expect(manifestDependencyEdges({ dependencies: { "identities-mcp": "1.0.0" } }, "entities-mcp")).toEqual([]);
  });

  test("a dependency map inherited from the prototype chain is not an edge", () => {
    // Guards against a `key in map` style lookup: every object has toString.
    expect(manifestDependencyEdges({ dependencies: {} }, "toString")).toEqual([]);
    expect(manifestDependencyEdges({ dependencies: {} }, "constructor")).toEqual([]);
  });

  test("ignores non-object manifests and non-object dependency fields", () => {
    expect(manifestDependencyEdges(null, "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges("@hasna/cli", "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges([{ "@hasna/cli": "1" }], "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges({ dependencies: "@hasna/cli" }, "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges({ bundleDependencies: "@hasna/cli" }, "@hasna/cli")).toEqual([]);
    expect(manifestDependencyEdges({ dependencies: { "@hasna/cli": "1" } }, "  ")).toEqual([]);
  });
});

describe("name matching primitives", () => {
  test("dependencyNamesMatch is exact after trimming", () => {
    expect(dependencyNamesMatch("@hasna/cli", "@hasna/cli")).toBe(true);
    expect(dependencyNamesMatch(" @hasna/cli ", "@hasna/cli")).toBe(true);
    expect(dependencyNamesMatch("@hasna/clip", "@hasna/cli")).toBe(false);
    expect(dependencyNamesMatch("@Hasna/CLI", "@hasna/cli")).toBe(false);
    expect(dependencyNamesMatch(undefined, "@hasna/cli")).toBe(false);
  });

  test("isSubstringOnlyMatch names the near misses in both directions", () => {
    expect(isSubstringOnlyMatch("@hasna/clip", "@hasna/cli")).toBe(true);
    expect(isSubstringOnlyMatch("@hasna/clips", "@hasna/cli")).toBe(true);
    expect(isSubstringOnlyMatch("entities-mcp", "identities-mcp")).toBe(true);
    expect(isSubstringOnlyMatch("entity_get", "entity_get")).toBe(false);
    expect(isSubstringOnlyMatch("@hasna/todos", "@hasna/cli")).toBe(false);
    expect(isSubstringOnlyMatch("", "@hasna/cli")).toBe(false);
  });

  test("manifestDependencyNames includes the candidate's own name", () => {
    const names = manifestDependencyNames({ name: "@hasna/clip", dependencies: { "@hasna/clip": "^0.1.0" }, bundleDependencies: ["left-pad"] });
    expect(names).toEqual(expect.arrayContaining(["@hasna/clip", "left-pad"]));
  });
});

describe("dependent confirmation", () => {
  test("confirms a real dependent and rejects the substring look-alikes", () => {
    const result = confirmManifestDependents({
      packageName: "@hasna/cli",
      candidates: [
        {
          candidate: "hasnaxyz/real-consumer",
          manifests: [{ path: "package.json", text: JSON.stringify({ name: "real-consumer", dependencies: { "@hasna/cli": "^0.2.0" } }) }],
        },
        {
          candidate: "hasna/clip",
          manifests: [{ path: "package.json", text: JSON.stringify({ name: "@hasna/clip", version: "0.1.0" }) }],
        },
        {
          candidate: "hasnaxyz/iapp-clips",
          manifests: [{ path: "package.json", text: JSON.stringify({ name: "@hasna/clips", dependencies: { "@hasna/clips": "^0.1.0" } }) }],
        },
      ],
    });

    expect(result.confirmed.map((finding) => finding.candidate)).toEqual(["hasnaxyz/real-consumer"]);
    expect(result.rejected.map((finding) => finding.candidate)).toEqual(["hasna/clip", "hasnaxyz/iapp-clips"]);
    expect(result.rejected.every((finding) => finding.rejection === "substring-only-match")).toBe(true);
    // The near miss is reported, not discarded — that is what makes a rejected
    // candidate auditable instead of invisible.
    expect(result.rejected[0]!.near_miss_names).toEqual(["@hasna/clip"]);
    expect(result.rejected[1]!.near_miss_names).toEqual(["@hasna/clips"]);
    expect(result.summary).toEqual({ candidates: 3, confirmed: 1, rejected: 2, substring_only: 2 });
  });

  test("a source-code text hit with no manifest edge is rejected", () => {
    // hasna/browserplan matched "entity_get" through Chromium identity API
    // code. There is no manifest edge, so it is not a dependent.
    const result = confirmManifestDependents({
      packageName: "entity_get",
      candidates: [{
        candidate: "hasna/browserplan",
        manifests: [{ path: "package.json", text: JSON.stringify({ name: "browserplan", dependencies: { chromium: "^1.0.0" } }) }],
      }],
    });

    expect(result.confirmed).toEqual([]);
    expect(result.rejected[0]!.rejection).toBe("no-dependency-edge");
  });

  test("finds the edge in a workspace package, not only the repo root", () => {
    const result = confirmManifestDependents({
      packageName: "@hasna/cli",
      candidates: [{
        candidate: "hasnatools/platform-x",
        manifests: [
          { path: "package.json", json: { name: "platform-x", workspaces: ["packages/*"] } },
          { path: "packages/sdk/package.json", json: { name: "@x/sdk", dependencies: { "@hasna/cli": "^0.2.0" } } },
        ],
      }],
    });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]!.edges).toEqual([{ manifest: "packages/sdk/package.json", field: "dependencies", range: "^0.2.0" }]);
  });

  test("distinguishes a missing manifest from an unparseable one", () => {
    const result = confirmManifestDependents({
      packageName: "@hasna/cli",
      candidates: [
        { candidate: "no-manifest", manifests: [] },
        { candidate: "broken-manifest", manifests: [{ path: "package.json", text: "{ not json" }] },
      ],
    });

    expect(result.rejected[0]!.rejection).toBe("no-manifest");
    expect(result.rejected[1]!.rejection).toBe("unparseable-manifest");
    expect(result.rejected[1]!.unparseable).toEqual(["package.json"]);
  });
});
