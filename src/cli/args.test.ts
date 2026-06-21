import { describe, expect, test } from "bun:test";
import { parseIntOption } from "./args.js";

describe("parseIntOption", () => {
  test("parses valid integer", () => {
    expect(parseIntOption("42", "--limit", 0)).toBe(42);
  });

  test("throws on non-integer values", () => {
    expect(() => parseIntOption("abc", "--limit", 0)).toThrow("is not an integer");
  });

  test("throws on values with trailing non-numeric text", () => {
    expect(() => parseIntOption("10abc", "--limit", 0)).toThrow("is not an integer");
  });

  test("throws on decimal values", () => {
    expect(() => parseIntOption("1.5", "--limit", 0)).toThrow("is not an integer");
  });

  test("throws when below minimum", () => {
    expect(() => parseIntOption("-1", "--offset", 0)).toThrow("expected >= 0");
  });
});
