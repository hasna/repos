import { describe, expect, it } from "bun:test";
import { sanitizeRemoteIdentity, sanitizeRemoteOutput } from "./remote-identity.js";

describe("sanitizeRemoteIdentity", () => {
  it.each([
    ["https://user:pass@GitHub.com:443/hasna/repos.git?token=hidden#frag", "github.com/hasna/repos"],
    ["http://github.com/hasna/repos", "github.com/hasna/repos"],
    ["ssh://git@github.com:22/hasna/repos.git", "github.com/hasna/repos"],
    ["git://github.com/hasna/repos.git", "github.com/hasna/repos"],
    ["git@github.com:hasna/repos.git", "github.com/hasna/repos"],
    ["github.com/hasna/repos", "github.com/hasna/repos"],
    ["github.com:443/hasna/repos.git", "github.com/hasna/repos"],
  ])("normalizes supported credential-free identities", (input, expected) => {
    expect(sanitizeRemoteIdentity(input)).toBe(expected);
  });

  it.each([
    "",
    "/tmp/repo",
    "../repo",
    "./owner/repo",
    "file:///tmp/repo",
    "ftp://example.com/owner/repo",
    "github.com/owner/../repo",
    "github.com/owner/repo/extra",
    "github.com//repo",
    "github.com/owner/%2e%2e",
    "github.com/owner%2frepo/name",
    "github.com/owner/repo\nleak",
    "\nhttps://github.com/owner/repo",
    " https://github.com/owner/repo",
    "github.com:99999/owner/repo",
    "host:owner/repo:ambiguous",
    "https://github.com/owner",
    "https://github.com/owner/repo/",
  ])("rejects malformed or local identities", (input) => {
    expect(sanitizeRemoteIdentity(input)).toBeNull();
  });
});

describe("sanitizeRemoteOutput", () => {
  it("guards repository and remote JSON records without rewriting ordinary URLs", () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const output = sanitizeRemoteOutput({
      remote_url: unsafe,
      pr: { url: "https://github.com/team/tool/pull/1" },
      remotes: [{ repo_id: 1, name: "origin", url: unsafe, fetch_url: "/tmp/tool" }],
    });
    expect(output).toEqual({
      remote_url: "git.example.test/team/tool",
      pr: { url: "https://github.com/team/tool/pull/1" },
      remotes: [{ repo_id: 1, name: "origin", url: "git.example.test/team/tool", fetch_url: null }],
    });
    expect(JSON.stringify(output)).not.toContain(unsafe);
  });

  it("preserves non-plain JSON-compatible values and sanitizes projected remote records", () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const createdAt = new Date("2026-07-15T00:00:00.000Z");
    const output = sanitizeRemoteOutput({
      created_at: createdAt,
      pull_request: { url: "https://github.com/team/tool/pull/1" },
      remote: { repo_id: 1, name: "origin", url: unsafe, fetch_url: unsafe },
    });
    expect(output).toEqual({
      created_at: createdAt,
      pull_request: { url: "https://github.com/team/tool/pull/1" },
      remote: {
        repo_id: 1,
        name: "origin",
        url: "git.example.test/team/tool",
        fetch_url: "git.example.test/team/tool",
      },
    });
    expect(JSON.stringify(output)).not.toContain("phrase");
  });

  it("does not rewrite ordinary URL objects and neutralizes hostile own toJSON methods", () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const bytes = Buffer.from([1, 2, 3]);
    const ordinary = { name: "link", url: unsafe, fetch_url: unsafe };
    const hostile = {
      repo_id: 1,
      name: "origin",
      url: unsafe,
      fetch_url: unsafe,
      toJSON() {
        return { url: unsafe, fetch_url: unsafe };
      },
    };
    const output = sanitizeRemoteOutput({ ordinary, bytes, hostile }) as Record<string, unknown>;

    expect(output["ordinary"]).toEqual(ordinary);
    expect(output["bytes"]).toBe(bytes);
    expect(output["hostile"]).toEqual({
      repo_id: 1,
      name: "origin",
      url: "git.example.test/team/tool",
      fetch_url: "git.example.test/team/tool",
    });
    expect(JSON.stringify(output["hostile"])).not.toContain("phrase");
  });

  it("projects custom prototypes without invoking inherited serializers or accessors", () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const prototype = {
      toJSON() {
        return { url: unsafe };
      },
    };
    const custom = Object.assign(Object.create(prototype), {
      repo_id: 1,
      name: "origin",
      url: unsafe,
      fetch_url: unsafe,
    });
    class HostileBytes extends Uint8Array {
      toJSON() {
        return { url: unsafe };
      }
    }
    Object.defineProperty(custom, "computed", {
      enumerable: true,
      get() {
        throw new Error("accessor must not execute");
      },
    });

    const output = sanitizeRemoteOutput({
      custom,
      hostileBytes: new HostileBytes([1, 2]),
      urlObject: new URL(unsafe),
    }) as Record<string, unknown>;
    expect(output["custom"]).toEqual({
      repo_id: 1,
      name: "origin",
      url: "git.example.test/team/tool",
      fetch_url: "git.example.test/team/tool",
    });
    expect(output["urlObject"]).toEqual({});
    expect(output["hostileBytes"]).toEqual({ 0: 1, 1: 2 });
    expect(JSON.stringify(output)).not.toContain("phrase");
  });

  it("treats sensitive accessors as null without invoking them", () => {
    const marker = ["getter", "phrase"].join(":");
    const repo = { id: 1 } as Record<string, unknown>;
    Object.defineProperty(repo, "remote_url", {
      enumerable: true,
      get() {
        throw new Error(marker);
      },
    });
    const remote = { repo_id: 1, name: "origin" } as Record<string, unknown>;
    for (const key of ["url", "fetch_url"]) {
      Object.defineProperty(remote, key, {
        enumerable: true,
        get() {
          throw new Error(marker);
        },
      });
    }

    const output = sanitizeRemoteOutput({ repo, remote });
    expect(output).toEqual({
      repo: { id: 1, remote_url: null },
      remote: { repo_id: 1, name: "origin", url: null, fetch_url: null },
    });
    expect(JSON.stringify(output)).not.toContain(marker);
  });

  it("projects built-ins with hostile own toJSON while preserving ordinary built-ins", () => {
    const marker = ["serializer", "phrase"].join(":");
    const hostileDate = new Date("2026-07-15T00:00:00.000Z");
    Object.defineProperty(hostileDate, "toJSON", { value: () => marker });
    const hostileBytes = Buffer.from([9, 8]);
    Object.defineProperty(hostileBytes, "toJSON", { value: () => ({ marker }) });
    const ordinaryDate = new Date("2026-07-15T00:00:00.000Z");
    const ordinaryBytes = Buffer.from([1, 2]);
    const ordinaryTyped = new Uint8Array([3, 4]);

    const output = sanitizeRemoteOutput({
      hostileDate,
      hostileBytes,
      ordinaryDate,
      ordinaryBytes,
      ordinaryTyped,
    }) as Record<string, unknown>;
    expect(output["hostileDate"]).toEqual({});
    expect(output["hostileBytes"]).toEqual({ 0: 9, 1: 8 });
    expect(output["ordinaryDate"]).toBe(ordinaryDate);
    expect(output["ordinaryBytes"]).toBe(ordinaryBytes);
    expect(output["ordinaryTyped"]).toBe(ordinaryTyped);
    expect(JSON.stringify(output)).not.toContain(marker);
  });
});
