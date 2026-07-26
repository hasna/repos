import { describe, expect, it } from "bun:test";
import { parsePullRequestUrl, parseRemoteIdentity, resolvePullRequestOrigin } from "./pr-identity.js";

describe("parsePullRequestUrl", () => {
  it("extracts owner, repo and number from a GitHub PR URL", () => {
    expect(parsePullRequestUrl("https://github.com/hasna/codewith/pull/415"))
      .toEqual({ owner: "hasna", repo: "codewith", number: 415 });
  });

  it("tolerates trailing path, query and fragment segments", () => {
    expect(parsePullRequestUrl("https://github.com/hasna/repos/pull/26/files"))
      .toEqual({ owner: "hasna", repo: "repos", number: 26 });
    expect(parsePullRequestUrl("https://github.com/hasna/repos/pull/26#issuecomment-1"))
      .toEqual({ owner: "hasna", repo: "repos", number: 26 });
  });

  it("rejects values that are not pull request URLs", () => {
    expect(parsePullRequestUrl("https://github.com/hasna/repos/issues/26")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/hasna/repos")).toBeNull();
    expect(parsePullRequestUrl("not a url")).toBeNull();
    expect(parsePullRequestUrl(null)).toBeNull();
    expect(parsePullRequestUrl("")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/hasna/repos/pull/abc")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/hasna/repos/pull/0")).toBeNull();
  });
});

describe("parseRemoteIdentity", () => {
  it("splits a normalized host/owner/name identity", () => {
    expect(parseRemoteIdentity("github.com/hasna/emails")).toEqual({ owner: "hasna", repo: "emails" });
  });

  it("rejects anything that is not exactly host/owner/name", () => {
    expect(parseRemoteIdentity("github.com/hasna")).toBeNull();
    expect(parseRemoteIdentity("github.com/hasna/emails/extra")).toBeNull();
    expect(parseRemoteIdentity(null)).toBeNull();
  });
});

describe("resolvePullRequestOrigin", () => {
  it("trusts the PR URL over the repo record it is attached to", () => {
    // A real mis-attribution from the live index: a PR belonging to
    // hasna/aicopilot was stored against the platform-aicopilot repo record,
    // whose remote points at a different org entirely.
    expect(resolvePullRequestOrigin(
      "https://github.com/hasna/aicopilot/pull/9",
      "github.com/hasnatools/platform-aicopilot",
      "hasnatools",
    )).toEqual({ org: "hasna", repo: "aicopilot" });
  });

  it("falls back to the owning repo's remote when the URL is unusable", () => {
    expect(resolvePullRequestOrigin(null, "github.com/hasna/emails", "hasna"))
      .toEqual({ org: "hasna", repo: "emails" });
  });

  it("falls back to the stored org when there is no remote either", () => {
    expect(resolvePullRequestOrigin(null, null, "hasna")).toEqual({ org: "hasna", repo: null });
  });

  it("returns nulls when nothing identifies the pull request", () => {
    expect(resolvePullRequestOrigin(null, null, null)).toEqual({ org: null, repo: null });
  });
});
