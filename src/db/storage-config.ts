import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StorageMode = "local" | "hybrid" | "remote";

export interface StorageConfig {
  mode: StorageMode;
  rds: {
    host: string;
    port: number;
    username: string;
    password_env: string;
    ssl: boolean;
  };
}

const STORAGE_CONFIG_PATH = join(homedir(), ".hasna", "repos", "storage", "config.json");

function normalizeMode(value: string | undefined): StorageMode | undefined {
  if (value === "local" || value === "hybrid" || value === "remote") return value;
  return undefined;
}

function envConnectionString(): string | undefined {
  return (
    process.env["HASNA_REPOS_DATABASE_URL"] ??
    process.env["REPOS_DATABASE_URL"]
  );
}

export function getStorageConfig(): StorageConfig {
  const config: StorageConfig = {
    mode: "local",
    rds: {
      host: "",
      port: 5432,
      username: "",
      password_env: "REPOS_DATABASE_PASSWORD",
      ssl: true,
    },
  };

  if (existsSync(STORAGE_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(STORAGE_CONFIG_PATH, "utf-8")) as Partial<StorageConfig>;
      config.mode = normalizeMode(raw.mode) ?? config.mode;
      config.rds = { ...config.rds, ...(raw.rds ?? {}) };
    } catch {
      // Ignore malformed storage config and fall back to local mode.
    }
  }

  const modeOverride =
    process.env["HASNA_REPOS_STORAGE_MODE"] ??
    process.env["REPOS_STORAGE_MODE"];
  const normalizedMode = normalizeMode(modeOverride);
  if (normalizedMode) {
    config.mode = normalizedMode;
  } else if (envConnectionString() && config.mode === "local") {
    config.mode = "hybrid";
  }

  return config;
}

export function getStorageConnectionString(dbName = "repos"): string {
  const direct = envConnectionString();
  if (direct) return direct;

  const config = getStorageConfig();
  const { host, port, username, password_env, ssl } = config.rds;
  if (!host || !username) {
    throw new Error("Storage database is not configured. Set HASNA_REPOS_DATABASE_URL or configure ~/.hasna/repos/storage/config.json.");
  }

  const password = process.env[password_env];
  if (!password) {
    throw new Error(`Storage database password is not set. Export ${password_env}.`);
  }

  const sslParam = ssl ? "?sslmode=require" : "";
  return `postgres://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbName}${sslParam}`;
}
