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
});
