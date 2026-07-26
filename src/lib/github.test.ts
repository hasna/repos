import { describe, expect, test } from "bun:test";
import { collectPullRequestNodes, isMissingRepoError } from "./github.js";

const node = (number: number) => ({
  number,
  title: `PR #${number}`,
  state: "OPEN",
  createdAt: "2026-07-01T00:00:00Z",
});

describe("collectPullRequestNodes", () => {
  test("drops the null holes in a partially-resolved page", () => {
    // GitHub returns nodes with nulls alongside an `errors` entry when only
    // some of the page could be resolved. Dereferencing one throws
    // "null is not an object (evaluating 'pr.number')" and aborts the sync.
    const nodes = [null, node(2), undefined, node(3)];
    expect(collectPullRequestNodes(nodes).map((pr) => pr.number)).toEqual([2, 3]);
  });

  test("rejects entries that are not pull request shaped", () => {
    expect(collectPullRequestNodes([{ number: "12" }, {}, "nope", 7])).toEqual([]);
  });

  test("rejects half-resolved nodes that would violate a NOT NULL column", () => {
    // Dropping these here is the point: letting one through only moves the
    // abort into the write transaction.
    expect(collectPullRequestNodes([
      { number: 1 },                                        // no title/createdAt
      { ...node(2), title: null },                          // title is NOT NULL
      { ...node(3), createdAt: "" },                        // created_at is NOT NULL
      { ...node(4), number: -1 },                           // not a real PR number
    ])).toEqual([]);
  });

  test("tolerates a missing or non-array nodes field", () => {
    expect(collectPullRequestNodes(undefined)).toEqual([]);
    expect(collectPullRequestNodes(null)).toEqual([]);
    expect(collectPullRequestNodes({})).toEqual([]);
  });
});

describe("transient failures are not mistaken for missing repositories", () => {
  test("an empty pull request connection is an error, not a skip", () => {
    // Classifying this as missing would file a transient failure alongside
    // renamed and deleted repositories, and a fleet sync would report success.
    expect(isMissingRepoError("GitHub GraphQL returned no pull request connection")).toBe(false);
  });

  test("a genuinely absent repository is still classified as missing", () => {
    expect(isMissingRepoError("GitHub repository is unavailable")).toBe(true);
  });
});

describe("isMissingRepoError", () => {
  test("classifies a renamed/deleted GitHub repo (GraphQL resolve error) as missing", () => {
    const message =
      "gh pr list -R hasna/agency --state open failed exit=1: GraphQL: Could not resolve to a Repository with the name 'hasna/agency'. (repository)";
    expect(isMissingRepoError(message)).toBe(true);
  });

  test("classifies REST 404 not-found responses as missing", () => {
    expect(isMissingRepoError("HTTP 404: Not Found (https://api.github.com/repos/hasna/gone)")).toBe(true);
    expect(isMissingRepoError("404: Not Found")).toBe(true);
    expect(isMissingRepoError("Repository not found")).toBe(true);
  });

  test("does NOT classify genuine sync failures as missing (they stay hard errors)", () => {
    expect(isMissingRepoError("gh pr list ... failed: signal=SIGKILL")).toBe(false);
    expect(isMissingRepoError("gh pr list returned invalid JSON for hasna/loops: Unexpected token")).toBe(false);
    expect(isMissingRepoError("Repo has no remote URL: open-loops")).toBe(false);
    expect(isMissingRepoError("network timeout while contacting api.github.com")).toBe(false);
  });
});
