import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearConfigCache } from "../lib/config.js";
import {
  isTrustedScanRequest,
  resolveConfiguredScanRoots,
  SCAN_REQUEST_HEADER,
  SCAN_REQUEST_HEADER_VALUE,
  SERVER_HOSTNAME,
} from "./security.js";

let testDir = "";
let configPath = "";

beforeEach(() => {
  testDir = join(tmpdir(), `repos-server-security-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  configPath = join(testDir, "config.json");
  process.env["HASNA_REPOS_CONFIG_PATH"] = configPath;
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  delete process.env["HASNA_REPOS_CONFIG_PATH"];
  rmSync(testDir, { recursive: true, force: true });
});

describe("dashboard server security", () => {
  it("binds only to IPv4 loopback", () => {
    expect(SERVER_HOSTNAME).toBe("127.0.0.1");
  });

  it("requires the scan gate header", () => {
    const url = "http://127.0.0.1:19450/api/scan";
    expect(isTrustedScanRequest(new Request(url))).toBe(false);
    expect(isTrustedScanRequest(new Request(url, {
      headers: { [SCAN_REQUEST_HEADER]: SCAN_REQUEST_HEADER_VALUE },
    }))).toBe(true);
  });

  it("rejects the scan gate header from a cross-origin page", () => {
    const request = new Request("http://127.0.0.1:19450/api/scan", {
      headers: {
        [SCAN_REQUEST_HEADER]: SCAN_REQUEST_HEADER_VALUE,
        Origin: "https://attacker.example",
      },
    });
    expect(isTrustedScanRequest(request)).toBe(false);
  });

  it("uses configured roots when none are requested", () => {
    const first = join(testDir, "first");
    const second = join(testDir, "second");
    writeFileSync(configPath, JSON.stringify({ workspaceRoots: [first, second] }));
    clearConfigCache();

    expect(resolveConfiguredScanRoots(undefined)).toEqual([resolve(first), resolve(second)]);
    expect(resolveConfiguredScanRoots([])).toEqual([resolve(first), resolve(second)]);
  });

  it("allows only configured roots and permits a configured subset", () => {
    const first = join(testDir, "first");
    const second = join(testDir, "second");
    writeFileSync(configPath, JSON.stringify({ workspaceRoots: [first, second] }));
    clearConfigCache();

    expect(resolveConfiguredScanRoots([second, second])).toEqual([resolve(second)]);
    expect(() => resolveConfiguredScanRoots([first, join(testDir, "outside")])).toThrow(
      "roots must be selected from the configured workspace roots",
    );
    expect(() => resolveConfiguredScanRoots([join(first, "nested")])).toThrow(
      "roots must be selected from the configured workspace roots",
    );
  });

  it("rejects malformed root input", () => {
    expect(() => resolveConfiguredScanRoots("/tmp/not-an-array")).toThrow(
      "roots must be an array of non-empty paths",
    );
    expect(() => resolveConfiguredScanRoots([""])).toThrow(
      "roots must be an array of non-empty paths",
    );
  });
});
