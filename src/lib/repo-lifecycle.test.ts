/**
 * Unit coverage for the repository-plane primitives that must hold without a
 * subprocess in the loop: the spec grammar that keeps hostile arguments out of
 * `gh` argv, and the redaction that keeps a resolved token out of anything a
 * caller can read. The end-to-end behavior, including the credential boundary
 * with positive controls, lives in `src/cli/repo-lifecycle-cli.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { RepoLifecycleError, parseRepoSpec, redactRepoLifecycleText } from "./repo-lifecycle.js";

describe("parseRepoSpec", () => {
  test.each([
    ["hasna/repos", "hasna", "repos"],
    ["hasnaxyz/iapp-factory", "hasnaxyz", "iapp-factory"],
    ["a/b", "a", "b"],
    ["org-name/repo.name_v2", "org-name", "repo.name_v2"],
  ])("accepts %s", (spec, org, name) => {
    expect(parseRepoSpec(spec)).toEqual({ org, name });
  });

  test.each([
    // Argument-shape refusals: nothing that could reach `gh` as a flag, a
    // path expression, or a second argument is representable.
    "",
    "no-slash",
    "org/",
    "/name",
    "org//name",
    "org/name/extra",
    "-leading-dash/name",
    "org/-leading-dash",
    "--flag/name",
    "org/--flag",
    "org/..",
    "org/.",
    "../up/name",
    "org/name with space",
    "org/name\ttab",
    "org/name\nnewline",
    "org name/repo",
  ])("refuses %j", (spec) => {
    expect(() => parseRepoSpec(spec)).toThrow(RepoLifecycleError);
    try {
      parseRepoSpec(spec);
    } catch (error) {
      expect((error as RepoLifecycleError).code).toBe("INVALID_REPO_SPEC");
    }
  });
});

describe("redactRepoLifecycleText", () => {
  test("strips a resolved token wherever it appears, whatever its shape", () => {
    // No provider prefix, deliberately: a vault-minted token can have a shape
    // no prefix list anticipates, so only the exact-value leg can catch it.
    const token = "vault-minted-marker-0123456789abcdef";
    const text = `remote: says ${token} and again ${token}`;
    const redacted = redactRepoLifecycleText(text, token);
    expect(redacted).not.toContain(token);
  });

  test("strips provider-prefixed tokens even without knowing the value", () => {
    const text = "fatal: could not read https://ghs_unknowntoken12345@github.com/x/y";
    const redacted = redactRepoLifecycleText(text, null);
    expect(redacted).not.toContain("ghs_unknowntoken12345");
  });

  test("a control string survives — redaction is not deletion", () => {
    const redacted = redactRepoLifecycleText("plain diagnostic text", null);
    expect(redacted).toBe("plain diagnostic text");
  });
});
