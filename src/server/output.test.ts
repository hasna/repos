import { describe, expect, it } from "bun:test";
import { apiJsonResponse } from "./output.js";

describe("dashboard HTTP output", () => {
  it("can omit CORS headers from privileged responses", () => {
    const response = apiJsonResponse({ ok: true }, 200, { cors: false });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("sanitizes remote identities before serializing API responses", async () => {
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git?query=marker`;
    const response = apiJsonResponse([{ id: 1, remote_url: unsafe }]);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual([{ id: 1, remote_url: "git.example.test/team/tool" }]);
    expect(text).not.toContain(unsafe);
  });

  it("never executes sensitive accessors or hostile own serializers", async () => {
    const marker = ["accessor", "phrase"].join(":");
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
    const hostileDate = new Date("2026-07-15T00:00:00.000Z");
    Object.defineProperty(hostileDate, "toJSON", {
      configurable: true,
      value() {
        return marker;
      },
    });

    const response = apiJsonResponse({ repo, remote, hostileDate });
    const text = await response.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toEqual({
      repo: { id: 1, remote_url: null },
      remote: { repo_id: 1, name: "origin", url: null, fetch_url: null },
      hostileDate: "2026-07-15T00:00:00.000Z",
    });
  });

  it("retains ordinary Date and byte serialization when no own toJSON hook exists", async () => {
    const response = apiJsonResponse({
      created_at: new Date("2026-07-15T00:00:00.000Z"),
      bytes: Buffer.from([1, 2, 3]),
      typed: new Uint8Array([4, 5]),
    });
    expect(JSON.parse(await response.text())).toEqual({
      created_at: "2026-07-15T00:00:00.000Z",
      bytes: { type: "Buffer", data: [1, 2, 3] },
      typed: { 0: 4, 1: 5 },
    });
  });

  it("does not execute inherited serializers during final API JSON materialization", async () => {
    const marker = ["inherited", "phrase"].join(":");
    const unsafe = `https://${["member", "phrase"].join(":")}@git.example.test/team/tool.git`;
    const prototypes = [
      Object.prototype,
      Array.prototype,
      Date.prototype,
      Buffer.prototype,
      Uint8Array.prototype,
    ];
    const previous = prototypes.map((prototype) => Object.getOwnPropertyDescriptor(prototype, "toJSON"));
    let response: Response;
    try {
      for (const prototype of prototypes) {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          value() {
            return marker;
          },
        });
      }
      response = apiJsonResponse({
        repos: [{ id: 1, remote_url: unsafe }],
        created_at: new Date("2026-07-15T00:00:00.000Z"),
        bytes: Buffer.from([1, 2]),
        typed: new Uint8Array([3, 4]),
      });
    } finally {
      for (let index = 0; index < prototypes.length; index++) {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(prototypes[index]!, "toJSON", descriptor);
        else delete (prototypes[index] as { toJSON?: unknown }).toJSON;
      }
    }
    const text = await response!.text();
    expect(text).not.toContain(marker);
    expect(text).not.toContain(unsafe);
    expect(JSON.parse(text)).toEqual({
      repos: [{ id: 1, remote_url: "git.example.test/team/tool" }],
      created_at: "2026-07-15T00:00:00.000Z",
      bytes: { type: "Buffer", data: [1, 2] },
      typed: { 0: 3, 1: 4 },
    });
  });
});
