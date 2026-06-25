import { afterEach, describe, expect, test } from "bun:test";
import { getStorageConfig, getStorageConnectionString } from "./storage-config.js";

const envKeys = [
  "HASNA_REPOS_DATABASE_URL",
  "REPOS_DATABASE_URL",
  "HASNA_REPOS_STORAGE_MODE",
  "REPOS_STORAGE_MODE",
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, saved] of savedEnv) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedEnv.clear();
});

function setEnv(key: typeof envKeys[number], value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

describe("repos storage config", () => {
  test("canonical storage database env wins over shorthand env", () => {
    setEnv("HASNA_REPOS_DATABASE_URL", "postgres://new.example/repos");
    setEnv("REPOS_DATABASE_URL", "postgres://old.example/repos");

    expect(getStorageConnectionString()).toBe("postgres://new.example/repos");
    expect(getStorageConfig().mode).toBe("hybrid");
  });

  test("shorthand database env remains a supported fallback", () => {
    setEnv("REPOS_DATABASE_URL", "postgres://old.example/repos");

    expect(getStorageConnectionString()).toBe("postgres://old.example/repos");
    expect(getStorageConfig().mode).toBe("hybrid");
  });

  test("canonical storage mode wins over shorthand mode", () => {
    setEnv("HASNA_REPOS_STORAGE_MODE", "remote");
    setEnv("REPOS_STORAGE_MODE", "hybrid");

    expect(getStorageConfig().mode).toBe("remote");
  });

  test("exports storage helpers from the storage subpath source", async () => {
    setEnv("HASNA_REPOS_STORAGE_MODE", "local");
    const storage = await import("../storage.js");

    expect(storage.STORAGE_TABLES).toContain("repos");
    expect(storage.getStorageConfig().mode).toBe("local");
    expect(storage.PG_MIGRATIONS.length).toBeGreaterThan(0);
    expect(typeof storage.PgAdapterAsync).toBe("function");
    expect(typeof storage.applyPgMigrations).toBe("function");
  });
});
