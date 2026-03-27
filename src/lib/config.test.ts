import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";

const originalHomedir = homedir;

let mockFsExists = true;
let mockFsContent = "";

const mockExistsSync = (path: string) => {
  const configPath = resolve(originalHomedir(), ".hasna", "repos", "config.json");
  return path === configPath ? mockFsExists : false;
};

const mockReadFileSync = (path: string, _enc: BufferEncoding) => {
  const configPath = resolve(originalHomedir(), ".hasna", "repos", "config.json");
  return path === configPath ? mockFsContent : "";
};

Bun.env.HKIP_BYPASS_FS_MOCK = "1";

let config: typeof import("../lib/config");

beforeEach(async () => {
  mockFsExists = true;
  mockFsContent = "";
  const mod = await import("../lib/config.js");
  config = mod as any;
  config.cachedConfig = null;
});

afterEach(() => {
  config.cachedConfig = null;
});

describe("config", () => {
  describe("getConfig", () => {
    it("should return default config when no config file exists", async () => {
      mockFsExists = false;
      config.cachedConfig = null;
      const cfg = config.getConfig();
      expect(cfg.commitLimit).toBe(5000);
      expect(cfg.incrementalCommitLimit).toBe(100);
      expect(cfg.scanDepth).toBe(5);
      expect(cfg.excludedPaths).toEqual(["node_modules", "dist", "vendor", ".git"]);
    });

    it("should merge custom config over defaults", async () => {
      mockFsContent = JSON.stringify({ commitLimit: 1000, scanDepth: 3 });
      config.cachedConfig = null;
      const cfg = config.getConfig();
      expect(cfg.commitLimit).toBe(1000);
      expect(cfg.scanDepth).toBe(3);
      expect(cfg.incrementalCommitLimit).toBe(100);
      expect(cfg.excludedPaths).toEqual(["node_modules", "dist", "vendor", ".git"]);
    });

    it("should cache config after first call", async () => {
      mockFsContent = JSON.stringify({ commitLimit: 9999 });
      config.cachedConfig = null;
      const cfg1 = config.getConfig();
      mockFsContent = JSON.stringify({ commitLimit: 1 });
      const cfg2 = config.getConfig();
      expect(cfg1.commitLimit).toBe(cfg2.commitLimit);
      expect(cfg1.commitLimit).toBe(9999);
    });

    it("should fall back to defaults for invalid JSON", async () => {
      mockFsContent = "not valid json {{{";
      config.cachedConfig = null;
      const cfg = config.getConfig();
      expect(cfg.commitLimit).toBe(5000);
    });

    it("should support custom excludedPaths", async () => {
      mockFsContent = JSON.stringify({ excludedPaths: ["build", ".cache"] });
      config.cachedConfig = null;
      const cfg = config.getConfig();
      expect(cfg.excludedPaths).toEqual(["build", ".cache"]);
    });
  });

  describe("getFilterAlias", () => {
    it("should return undefined for unknown alias", async () => {
      mockFsContent = JSON.stringify({ aliases: { work: { org: "acme" } } });
      config.cachedConfig = null;
      const result = config.getFilterAlias("nonexistent");
      expect(result).toBeUndefined();
    });

    it("should return alias with org", async () => {
      mockFsContent = JSON.stringify({ aliases: { work: { org: "hasna" } } });
      config.cachedConfig = null;
      const result = config.getFilterAlias("work");
      expect(result).toEqual({ org: "hasna" });
    });

    it("should return alias with paths", async () => {
      mockFsContent = JSON.stringify({ aliases: { local: { paths: ["/a", "/b"] } } });
      config.cachedConfig = null;
      const result = config.getFilterAlias("local");
      expect(result).toEqual({ paths: ["/a", "/b"] });
    });

    it("should return alias with query", async () => {
      mockFsContent = JSON.stringify({ aliases: { ai: { query: "openai" } } });
      config.cachedConfig = null;
      const result = config.getFilterAlias("ai");
      expect(result).toEqual({ query: "openai" });
    });

    it("should return undefined when no aliases defined", async () => {
      mockFsContent = JSON.stringify({ commitLimit: 1000 });
      config.cachedConfig = null;
      const result = config.getFilterAlias("anything");
      expect(result).toBeUndefined();
    });
  });
});
