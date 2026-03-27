import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface FilterAlias {
  org?: string;
  paths?: string[];
  query?: string;
}

export interface ReposConfig {
  commitLimit?: number;
  incrementalCommitLimit?: number;
  scanDepth?: number;
  excludedPaths?: string[];
  aliases?: Record<string, FilterAlias>;
}

const DEFAULT_CONFIG: ReposConfig = {
  commitLimit: 5000,
  incrementalCommitLimit: 100,
  scanDepth: 5,
  excludedPaths: ["node_modules", "dist", "vendor", ".git"],
};

let cachedConfig: ReposConfig | null = null;

export function getFilterAlias(name: string): FilterAlias | undefined {
  const cfg = getConfig();
  return cfg.aliases?.[name];
}

export function getConfig(): ReposConfig {
  if (cachedConfig !== null) return cachedConfig;
  const configPath = resolve(homedir(), ".hasna", "repos", "config.json");
  let loaded: ReposConfig = { ...DEFAULT_CONFIG };
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      loaded = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch { /* use defaults */ }
  }
  cachedConfig = loaded;
  return loaded;
}
