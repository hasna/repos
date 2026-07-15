import { describe, expect, it } from "bun:test";
import { apiJsonResponse } from "./output.js";

describe("dashboard HTTP output", () => {
  it("sanitizes remote identities before serializing API responses", async () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const response = apiJsonResponse([{ id: 1, remote_url: unsafe }]);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual([{ id: 1, remote_url: "git.example.test/team/tool" }]);
    expect(text).not.toContain(unsafe);
  });
});
