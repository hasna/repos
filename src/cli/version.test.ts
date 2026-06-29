import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_CLI_VERSION, getCliVersionFromDir, parseVersionFromPackageJson } from "./version.js";

describe("parseVersionFromPackageJson", () => {
  test("returns version when present", () => {
    const version = parseVersionFromPackageJson('{"name":"x","version":"1.2.3"}');
    expect(version).toBe("1.2.3");
  });

  test("falls back when JSON is invalid", () => {
    const version = parseVersionFromPackageJson("{not-json");
    expect(version).toBe(FALLBACK_CLI_VERSION);
  });

  test("falls back when version is missing", () => {
    const version = parseVersionFromPackageJson('{"name":"x"}');
    expect(version).toBe(FALLBACK_CLI_VERSION);
  });
});

describe("getCliVersionFromDir", () => {
  test("finds the package version from dist entrypoint directories", () => {
    const root = mkdtempSync(join(tmpdir(), "open-repos-version-"));
    try {
      mkdirSync(join(root, "dist", "cli"), { recursive: true });
      mkdirSync(join(root, "dist", "mcp"), { recursive: true });
      mkdirSync(join(root, "dist", "server"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@hasna/repos", version: "9.8.7" }));

      expect(getCliVersionFromDir(join(root, "dist"))).toBe("9.8.7");
      expect(getCliVersionFromDir(join(root, "dist", "cli"))).toBe("9.8.7");
      expect(getCliVersionFromDir(join(root, "dist", "mcp"))).toBe("9.8.7");
      expect(getCliVersionFromDir(join(root, "dist", "server"))).toBe("9.8.7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores unrelated parent package metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "open-repos-version-"));
    try {
      const nested = join(root, "outer", "package", "dist");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other", version: "1.2.3" }));

      expect(getCliVersionFromDir(nested)).toBe(FALLBACK_CLI_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
