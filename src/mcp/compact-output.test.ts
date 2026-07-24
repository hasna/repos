import { describe, expect, test } from "bun:test";
import { compactLimit, compactPage, compactText } from "./server.js";

describe("MCP compact output helpers", () => {
  test("truncate long text without changing short text", () => {
    expect(compactText("short", 20)).toBe("short");
    expect(compactText("one two three four five", 12)).toBe("one two t...");
    expect(compactText("https://secret-token@github.com/hasna/repos.git", 120)).toBe("https://***@github.com/hasna/repos.git");
  });

  test("uses compact defaults unless verbose or explicit limits are requested", () => {
    expect(compactLimit({})).toBe(20);
    expect(compactLimit({ verbose: true }, 50)).toBe(50);
    expect(compactLimit({ limit: 7, verbose: true }, 50)).toBe(7);
    expect(compactLimit({ limit: -1 })).toBe(1);
    expect(compactLimit({ limit: 5.8 })).toBe(5);
    expect(compactLimit({ limit: 9999 })).toBe(200);
  });

  test("returns paged compact summaries with disclosure hints", () => {
    const page = compactPage(
      "repos",
      [{ name: "alpha" }, { name: "beta" }],
      { limit: 2, offset: 4, pageable: true },
      (item) => ({ name: item.name }),
      "Call get_repo for details"
    );

    expect(page).toMatchObject({
      kind: "repos",
      output: "compact",
      count: 2,
      limit: 2,
      offset: 4,
      next_cursor: 6,
      items: [{ name: "alpha" }, { name: "beta" }],
    });
    expect(page.hint).toContain("verbose=true");
  });

  test("does not advertise pagination for non-pageable summaries", () => {
    const page = compactPage(
      "search_results",
      [{ title: "alpha" }],
      { limit: 1 },
      (item) => ({ title: item.title }),
      "Call get_repo for details"
    );

    expect(page.next_cursor).toBeNull();
    expect(page.hint).not.toContain("limit/offset");
  });
});
