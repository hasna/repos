import { describe, expect, test } from "bun:test";
import { isMissingRepoError } from "./github.js";

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
