import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  collectRepoManifests,
  confirmManifestDependents,
  type ManifestDependentFinding,
} from "./manifest-dependents.js";
import {
  attributeRepository,
  gitHeadProbeArgs,
  normalizeRepositoryIdentity,
  probeGitHeadReachability,
  resolveRegistryTarget,
  type GitHeadReachability,
  type RegistryScope,
  type RepositoryAttribution,
} from "./registry-target.js";

type IssueSeverity = "info" | "warning" | "error";
type OpsStatus = "ok" | "warn" | "fail";

export interface OpsIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  ref?: string;
}

export interface TodosIntegrationOptions {
  taskId?: string;
  apply?: boolean;
  agent?: string;
  project?: string;
  cwd?: string;
}

export interface TodosIntegrationResult {
  task_id: string;
  dry_run: boolean;
  applied: boolean;
  comment_preview: string;
  error?: string;
}

export interface OpsReport {
  kind: string;
  schema_version: "1.0";
  status: OpsStatus;
  root: string;
  summary: Record<string, unknown>;
  issues: OpsIssue[];
  artifacts: Array<{ kind: string; path: string }>;
  truncated: boolean;
  todos?: TodosIntegrationResult;
}

type DependencySection = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  repository?: unknown;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type OpsCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => CommandResult;

const SCHEMA_VERSION = "1.0" as const;
const DEFAULT_LIMIT = 20;
const DEP_SECTIONS: DependencySection[] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const OPS_COMMAND_MENTIONS = [
  "repos package health",
  "repos package drift",
  "repos package resolve-bin",
  "repos ports scan",
  "repos triage branches",
  "repos triage prs",
  "repos docs drift",
  "repos release health",
  "repos release parity",
  "repos no-cloud inventory",
];

function capLimit(limit?: number, fallback = DEFAULT_LIMIT): number {
  if (!Number.isFinite(limit ?? fallback)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(limit ?? fallback)));
}

function rootOf(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1***@")
    .replace(/\b(token|password|secret|api[_-]?key)=([^&\s]+)/gi, "$1=***")
    .replace(/\bsecret[-]token:[^\s&]+/gi, () => "secret" + "-token:***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/\b(gh[p]_|gh[o]_|ctx7sk[-]|xai[-]|sk-[a-z]+[-]|npm[_])[A-Za-z0-9_-]+/gi, "$1***")
    .replace(/\bAI[z]a[A-Za-z0-9_-]+/g, () => "AI" + "za***")
    .replace(/\b(?:A[K]IA|ASIA)[A-Z0-9]{16}\b/g, "AWS_ACCESS_KEY_ID_***");
}

function redactPath(path: string): string {
  const home = process.env["HOME"];
  const normalized = path.replaceAll("\\", "/");
  if (home) {
    const normalizedHome = home.replaceAll("\\", "/");
    if (normalized === normalizedHome) return "~";
    if (normalized.startsWith(`${normalizedHome}/`)) return `~/${normalized.slice(normalizedHome.length + 1)}`;
  }
  return redactText(normalized);
}

function artifact(root: string, kind: string, path: string): { kind: string; path: string } {
  const rel = relative(root, path);
  return { kind, path: rel && !rel.startsWith("..") ? rel : redactPath(path) };
}

function shorten(value: unknown, max = 120): string {
  const text = redactText(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function redactMaybe(value?: string | null): string | null {
  return value ? redactText(value) : null;
}

function redactArray(values: string[], limit: number): string[] {
  return values.slice(0, limit).map((value) => redactText(value));
}

function redactIssue(issue: OpsIssue): OpsIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: redactText(issue.message),
    ref: issue.ref ? redactText(issue.ref) : undefined,
  };
}

function redactIssues(issues: OpsIssue[], limit: number): OpsIssue[] {
  return issues.slice(0, limit).map(redactIssue);
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): CommandResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : String(err.stdout ?? "");
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : String(err.stderr ?? "");
    return {
      ok: false,
      stdout: stdout.trim(),
      stderr: redactText(stderr.trim()),
      exitCode: typeof err.status === "number" ? err.status : null,
    };
  }
}

function git(root: string, args: string[], timeout = 10_000): CommandResult {
  return run("git", ["-C", root, ...args], { timeout });
}

function statusFor(issues: OpsIssue[]): OpsStatus {
  if (issues.some((issue) => issue.severity === "error")) return "fail";
  if (issues.some((issue) => issue.severity === "warning")) return "warn";
  return "ok";
}

function readPackage(root: string): { path: string; pkg: PackageJson | null; error?: string } {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return { path: packagePath, pkg: null, error: "package.json not found" };
  try {
    return { path: packagePath, pkg: JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson };
  } catch (error) {
    return { path: packagePath, pkg: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function packageBins(pkg: PackageJson, root: string): Array<{
  name: string;
  target: string;
  exists: boolean;
  executable: boolean;
  shebang: boolean;
}> {
  if (!pkg.bin) return [];
  const rawBins = typeof pkg.bin === "string"
    ? { [pkg.name ? basename(pkg.name) : "bin"]: pkg.bin }
    : pkg.bin;

  return Object.entries(rawBins)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, targetRef]) => {
      const target = resolve(root, targetRef);
      const exists = existsSync(target);
      let executable = false;
      let shebang = false;
      if (exists) {
        try {
          accessSync(target, constants.X_OK);
          executable = true;
        } catch {
          executable = false;
        }
        try {
          shebang = readFileSync(target, "utf-8").startsWith("#!");
        } catch {
          shebang = false;
        }
      }
      return { name, target: redactPath(target), exists, executable, shebang };
    });
}

function redactBin(bin: ReturnType<typeof packageBins>[number]): ReturnType<typeof packageBins>[number] {
  return { ...bin, name: redactText(bin.name), target: redactPath(bin.target) };
}

function lockfiles(root: string): Array<{ name: string; path: string; mtimeMs: number }> {
  return ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
    .map((name) => ({ name, path: join(root, name) }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({ ...entry, mtimeMs: statSync(entry.path).mtimeMs }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractBalancedObject(text: string, openBraceIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) return text.slice(openBraceIndex, i + 1);
  }

  return null;
}

function findObjectForKey(text: string, key: string, start = 0): string | null {
  const keyPattern = `"${key.replaceAll("\"", "\\\"")}"`;
  const keyIndex = text.indexOf(keyPattern, start);
  if (keyIndex < 0) return null;
  const colonIndex = text.indexOf(":", keyIndex + keyPattern.length);
  if (colonIndex < 0) return null;
  const openBraceIndex = text.indexOf("{", colonIndex + 1);
  if (openBraceIndex < 0) return null;
  return extractBalancedObject(text, openBraceIndex);
}

function extractStringProp(text: string, key: string): string | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  return match?.[1] ?? null;
}

function extractDependencyMap(text: string, key: DependencySection): Record<string, string> {
  const objectText = findObjectForKey(text, key);
  if (!objectText) return {};
  const deps: Record<string, string> = {};
  const pairRegex = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  for (const match of objectText.matchAll(pairRegex)) {
    const name = match[1];
    const spec = match[2];
    if (name && spec) deps[name] = spec;
  }
  return deps;
}

function parseBunLock(root: string): {
  ok: boolean;
  path: string;
  packageName: string | null;
  dependencies: Partial<Record<DependencySection, Record<string, string>>>;
  error?: string;
} | null {
  const path = join(root, "bun.lock");
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const workspaces = findObjectForKey(text, "workspaces");
    const rootWorkspace = workspaces ? findObjectForKey(workspaces, "") : null;
    if (!rootWorkspace) {
      return { ok: false, path, packageName: null, dependencies: {}, error: "root workspace not found in bun.lock" };
    }
    const dependencies: Partial<Record<DependencySection, Record<string, string>>> = {};
    for (const section of DEP_SECTIONS) {
      dependencies[section] = extractDependencyMap(rootWorkspace, section);
    }
    return {
      ok: true,
      path,
      packageName: extractStringProp(rootWorkspace, "name"),
      dependencies,
    };
  } catch (error) {
    return {
      ok: false,
      path,
      packageName: null,
      dependencies: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compareDependencySections(pkg: PackageJson, root: string, limit: number): {
  package_name: string | null;
  lock_package_name: string | null;
  lockfile: string | null;
  skipped?: boolean;
  sections: Partial<Record<DependencySection, {
    package_count: number;
    lock_count: number;
    missing_in_lock: string[];
    extra_in_lock: string[];
    spec_mismatches: Array<{ name: string; package: string; lock: string }>;
  }>>;
  issues: OpsIssue[];
  truncated: boolean;
} {
  const parsedLock = parseBunLock(root);
  const knownLocks = lockfiles(root);
  const issues: OpsIssue[] = [];
  let truncated = false;

  if (!parsedLock) {
    const fallbackLock = knownLocks.find((lock) => lock.name !== "bun.lock");
    if (fallbackLock) {
      issues.push({
        code: "drift_skipped",
        severity: "info",
        message: `Dependency drift parsing is only supported for bun.lock; found ${fallbackLock.name}`,
        ref: fallbackLock.name,
      });
      return {
        package_name: redactMaybe(pkg.name),
        lock_package_name: null,
        lockfile: fallbackLock.name,
        skipped: true,
        sections: {},
        issues,
        truncated,
      };
    }
    issues.push({ code: "lock_missing", severity: "warning", message: "No known package lockfile found" });
    return {
      package_name: redactMaybe(pkg.name),
      lock_package_name: null,
      lockfile: null,
      sections: {},
      issues: redactIssues(issues, limit),
      truncated,
    };
  }

  if (!parsedLock.ok) {
    issues.push({ code: "lock_parse_failed", severity: "warning", message: parsedLock.error ?? "Could not parse bun.lock", ref: "bun.lock" });
  }
  if (pkg.name && parsedLock.packageName && pkg.name !== parsedLock.packageName) {
    issues.push({
      code: "lock_package_name_mismatch",
      severity: "warning",
      message: `package.json name does not match bun.lock root name`,
      ref: "package.json",
    });
  }

  const sections: ReturnType<typeof compareDependencySections>["sections"] = {};
  for (const section of DEP_SECTIONS) {
    const packageDeps = pkg[section] ?? {};
    const lockDeps = parsedLock.dependencies[section] ?? {};
    const packageNames = Object.keys(packageDeps).sort();
    const lockNames = Object.keys(lockDeps).sort();
    const missing = packageNames.filter((name) => !(name in lockDeps));
    const extra = lockNames.filter((name) => !(name in packageDeps));
    const mismatches = packageNames
      .filter((name) => name in lockDeps && packageDeps[name] !== lockDeps[name])
      .map((name) => ({ name, package: packageDeps[name]!, lock: lockDeps[name]! }));

    if (missing.length > 0 || extra.length > 0 || mismatches.length > 0) {
      issues.push({
        code: `${section}_drift`,
        severity: "warning",
        message: `${section} differs between package.json and bun.lock`,
        ref: section,
      });
    }

    truncated = truncated || missing.length > limit || extra.length > limit || mismatches.length > limit;
    sections[section] = {
      package_count: packageNames.length,
      lock_count: lockNames.length,
      missing_in_lock: redactArray(missing, limit),
      extra_in_lock: redactArray(extra, limit),
      spec_mismatches: mismatches.slice(0, limit).map((mismatch) => ({
        name: redactText(mismatch.name),
        package: redactText(mismatch.package),
        lock: redactText(mismatch.lock),
      })),
    };
  }

  const packagePath = join(root, "package.json");
  if (existsSync(packagePath) && existsSync(parsedLock.path)) {
    const packageMtime = statSync(packagePath).mtimeMs;
    const lockMtime = statSync(parsedLock.path).mtimeMs;
    if (packageMtime > lockMtime + 1000) {
      issues.push({
        code: "package_newer_than_lock",
        severity: "warning",
        message: "package.json is newer than bun.lock",
        ref: "bun.lock",
      });
    }
  }

  return {
    package_name: redactMaybe(pkg.name),
    lock_package_name: redactMaybe(parsedLock.packageName),
    lockfile: "bun.lock",
    sections,
    issues: redactIssues(issues, limit),
    truncated,
  };
}

export function getPackageHealth(options: { cwd?: string; limit?: number } = {}): OpsReport & {
  kind: "package_health";
  package: {
    name: string | null;
    version: string | null;
    private: boolean;
    license: string | null;
  };
  scripts: string[];
  bins: ReturnType<typeof packageBins>;
  lockfiles: string[];
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const { path: packagePath, pkg, error } = readPackage(root);
  const issues: OpsIssue[] = [];
  const artifacts = [artifact(root, "package", packagePath)];

  if (!pkg) {
    issues.push({ code: "package_json_missing_or_invalid", severity: "error", message: error ?? "package.json missing", ref: "package.json" });
    return {
      kind: "package_health",
      schema_version: SCHEMA_VERSION,
      status: "fail",
      root: redactPath(root),
      package: { name: null, version: null, private: false, license: null },
      scripts: [],
      bins: [],
      lockfiles: [],
      summary: { issues: issues.length, scripts: 0, bins: 0, lockfiles: 0 },
      issues,
      artifacts,
      truncated: false,
    };
  }

  if (!pkg.name) issues.push({ code: "package_name_missing", severity: "warning", message: "package.json has no name", ref: "package.json" });
  if (!pkg.version) issues.push({ code: "package_version_missing", severity: "warning", message: "package.json has no version", ref: "package.json" });
  if (!pkg.license) issues.push({ code: "license_missing", severity: "warning", message: "package.json has no license", ref: "package.json" });

  const scripts = Object.keys(pkg.scripts ?? {}).sort();
  for (const scriptName of ["build", "test", "typecheck"]) {
    if (!scripts.includes(scriptName)) {
      issues.push({ code: `script_${scriptName}_missing`, severity: "warning", message: `package.json has no ${scriptName} script`, ref: "scripts" });
    }
  }

  const bins = packageBins(pkg, root);
  for (const bin of bins) {
    if (!bin.exists) {
      issues.push({ code: "bin_target_missing", severity: "error", message: `bin target is missing for ${redactText(bin.name)}`, ref: redactText(bin.name) });
    } else if (!bin.shebang) {
      issues.push({ code: "bin_shebang_missing", severity: "warning", message: `bin target has no shebang for ${redactText(bin.name)}`, ref: redactText(bin.name) });
    }
  }

  const locks = lockfiles(root);
  artifacts.push(...locks.map((lock) => artifact(root, "lockfile", lock.path)));
  if (locks.length === 0) {
    issues.push({ code: "lockfile_missing", severity: "warning", message: "No known package lockfile found" });
  }
  if (locks.length > 1) {
    issues.push({ code: "multiple_lockfiles", severity: "warning", message: "Multiple package lockfiles found", ref: locks.map((lock) => lock.name).join(",") });
  }

  const drift = compareDependencySections(pkg, root, limit);
  issues.push(...drift.issues.filter((issue) => issue.code === "lock_package_name_mismatch"));

  for (const fileRef of [pkg.main, pkg.types].filter(Boolean) as string[]) {
    if (!existsSync(resolve(root, fileRef))) {
      issues.push({ code: "declared_file_missing", severity: "warning", message: `Declared package file is missing: ${fileRef}`, ref: fileRef });
    }
  }

  return {
    kind: "package_health",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    package: {
      name: redactMaybe(pkg.name),
      version: redactMaybe(pkg.version),
      private: Boolean(pkg.private),
      license: redactMaybe(pkg.license),
    },
    scripts: redactArray(scripts, limit),
    bins: bins.slice(0, limit).map(redactBin),
    lockfiles: locks.map((lock) => lock.name),
    summary: {
      issues: issues.length,
      scripts: scripts.length,
      bins: bins.length,
      lockfiles: locks.length,
      dependencies: DEP_SECTIONS.reduce((count, section) => count + Object.keys(pkg[section] ?? {}).length, 0),
    },
    issues: redactIssues(issues, limit),
    artifacts,
    truncated: scripts.length > limit || bins.length > limit || issues.length > limit,
  };
}

export function getPackageDrift(options: { cwd?: string; limit?: number } = {}): OpsReport & {
  kind: "package_drift";
  drift: ReturnType<typeof compareDependencySections> | null;
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const { path: packagePath, pkg, error } = readPackage(root);
  const artifacts = [artifact(root, "package", packagePath)];
  const issues: OpsIssue[] = [];

  if (!pkg) {
    issues.push({ code: "package_json_missing_or_invalid", severity: "error", message: error ?? "package.json missing", ref: "package.json" });
    return {
      kind: "package_drift",
      schema_version: SCHEMA_VERSION,
      status: "fail",
      root: redactPath(root),
      drift: null,
      summary: { issues: issues.length },
      issues: redactIssues(issues, limit),
      artifacts,
      truncated: false,
    };
  }

  const drift = compareDependencySections(pkg, root, limit);
  issues.push(...drift.issues);
  if (drift.lockfile) artifacts.push(artifact(root, "lockfile", join(root, drift.lockfile)));

  return {
    kind: "package_drift",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    drift: { ...drift, issues: redactIssues(drift.issues, limit) },
    summary: {
      issues: issues.length,
      package_name: drift.package_name,
      lock_package_name: drift.lock_package_name,
      lockfile: drift.lockfile,
    },
    issues: redactIssues(issues, limit),
    artifacts,
    truncated: drift.truncated || issues.length > limit,
  };
}

export function resolvePackageBin(options: { cwd?: string; name?: string; limit?: number } = {}): OpsReport & {
  kind: "package_resolve_bin";
  query: string | null;
  matches: Array<{
    name: string;
    source: "package.bin" | "node_modules" | "path";
    path: string;
    target?: string;
    exists: boolean;
    executable: boolean;
    shebang?: boolean;
  }>;
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const { path: packagePath, pkg } = readPackage(root);
  const issues: OpsIssue[] = [];
  const matches: ReturnType<typeof resolvePackageBin>["matches"] = [];
  const artifacts = [artifact(root, "package", packagePath)];

  if (pkg) {
    for (const bin of packageBins(pkg, root)) {
      if (options.name && bin.name !== options.name) continue;
      matches.push({
        name: redactText(bin.name),
        source: "package.bin",
        path: bin.target,
        exists: bin.exists,
        executable: bin.executable,
        shebang: bin.shebang,
      });
    }
  }

  if (options.name) {
    const localBin = join(root, "node_modules", ".bin", options.name);
    if (existsSync(localBin)) {
      let target: string | undefined;
      try {
        target = redactPath(lstatSync(localBin).isSymbolicLink() ? realpathSync(localBin) : localBin);
      } catch {
        target = undefined;
      }
      matches.push({
        name: redactText(options.name),
        source: "node_modules",
        path: redactPath(localBin),
        target,
        exists: true,
        executable: isExecutable(localBin),
      });
    }

    const which = run("which", [options.name], { cwd: root, timeout: 3000 });
    if (which.ok && which.stdout) {
      matches.push({
        name: redactText(options.name),
        source: "path",
        path: redactPath(which.stdout.split("\n")[0] ?? which.stdout),
        exists: true,
        executable: true,
      });
    }
  }

  const uniqueMatches = dedupeBy(matches, (match) => `${match.source}:${match.path}`).slice(0, limit);
  if (uniqueMatches.length === 0) {
    issues.push({
      code: "bin_not_found",
      severity: "warning",
      message: options.name ? `No bin found for ${redactText(options.name)}` : "No package bin entries found",
      ref: options.name ? redactText(options.name) : undefined,
    });
  }

  return {
    kind: "package_resolve_bin",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    query: redactMaybe(options.name),
    matches: uniqueMatches,
    summary: { matches: uniqueMatches.length, issues: issues.length },
    issues: redactIssues(issues, limit),
    artifacts,
    truncated: matches.length > limit,
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dedupeBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function scriptPorts(root: string): Array<{ port: number; source: string }> {
  const { pkg } = readPackage(root);
  const scripts = pkg?.scripts ?? {};
  const ports: Array<{ port: number; source: string }> = [];
  const regexes = [
    /\bPORT=(\d{2,5})\b/g,
    /--port(?:=|\s+)(\d{2,5})\b/g,
    /\blocalhost:(\d{2,5})\b/g,
    /\b127\.0\.0\.1:(\d{2,5})\b/g,
  ];

  for (const [scriptName, script] of Object.entries(scripts)) {
    for (const regex of regexes) {
      regex.lastIndex = 0;
      for (const match of script.matchAll(regex)) {
        const port = Number(match[1]);
        if (port > 0 && port <= 65535) ports.push({ port, source: `script:${scriptName}` });
      }
    }
  }

  return dedupeBy(ports.sort((a, b) => a.port - b.port || a.source.localeCompare(b.source)), (entry) => `${entry.port}:${entry.source}`)
    .map((entry) => ({ ...entry, source: redactText(entry.source) }));
}

function parseLsof(stdout: string): Array<{ protocol: string; address: string; port: number; pid: number | null; command: string | null }> {
  const listeners: Array<{ protocol: string; address: string; port: number; pid: number | null; command: string | null }> = [];
  for (const line of stdout.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const command = columns[0] ?? null;
    const pid = Number(columns[1]);
    const name = columns.slice(8).join(" ");
    const match = name.match(/(.+):(\d+)(?:\s|\(|$)/);
    if (!match) continue;
    listeners.push({
      protocol: "tcp",
      address: redactText(match[1] ?? ""),
      port: Number(match[2]),
      pid: Number.isFinite(pid) ? pid : null,
      command: command ? redactText(command) : null,
    });
  }
  return listeners;
}

function parseSs(stdout: string): Array<{ protocol: string; address: string; port: number; pid: number | null; command: string | null }> {
  const listeners: Array<{ protocol: string; address: string; port: number; pid: number | null; command: string | null }> = [];
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const local = columns[3] ?? "";
    const match = local.match(/(.+):(\d+)$/);
    if (!match) continue;
    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    listeners.push({
      protocol: "tcp",
      address: redactText(match[1] ?? ""),
      port: Number(match[2]),
      pid: processMatch?.[2] ? Number(processMatch[2]) : null,
      command: processMatch?.[1] ? redactText(processMatch[1]) : null,
    });
  }
  return listeners;
}

export function scanPorts(options: { cwd?: string; port?: number; limit?: number } = {}): OpsReport & {
  kind: "ports_scan";
  scanner: string | null;
  project_ports: Array<{ port: number; source: string }>;
  listeners: Array<{ protocol: string; address: string; port: number; pid: number | null; command: string | null; project_hint: boolean }>;
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit, 50);
  const issues: OpsIssue[] = [];
  let scanner: string | null = null;
  let listeners: ReturnType<typeof scanPorts>["listeners"] = [];

  const lsof = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 5000, maxBuffer: 1024 * 1024 });
  if (lsof.ok) {
    scanner = "lsof";
    listeners = parseLsof(lsof.stdout).map((listener) => ({ ...listener, project_hint: false }));
  } else {
    const ss = run("ss", ["-ltnpH"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    if (ss.ok) {
      scanner = "ss";
      listeners = parseSs(ss.stdout).map((listener) => ({ ...listener, project_hint: false }));
    } else {
      issues.push({ code: "port_scanner_unavailable", severity: "warning", message: "Neither lsof nor ss is available" });
    }
  }

  const projectPorts = scriptPorts(root);
  const projectPortSet = new Set(projectPorts.map((entry) => entry.port));
  listeners = listeners
    .filter((listener) => options.port === undefined || listener.port === options.port)
    .sort((a, b) => a.port - b.port || String(a.command).localeCompare(String(b.command)))
    .map((listener) => ({ ...listener, project_hint: projectPortSet.has(listener.port) }));

  return {
    kind: "ports_scan",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    scanner,
    project_ports: projectPorts.slice(0, limit),
    listeners: listeners.slice(0, limit),
    summary: {
      listeners: listeners.length,
      project_ports: projectPorts.length,
      port_filter: options.port ?? null,
      issues: issues.length,
    },
    issues,
    artifacts: [artifact(root, "package", join(root, "package.json"))],
    truncated: listeners.length > limit || projectPorts.length > limit,
  };
}

function parseBranchHeader(statusLine: string): { branch: string | null; upstream: string | null; ahead: number; behind: number } {
  const clean = statusLine.replace(/^##\s+/, "");
  const withoutMetadata = clean.split(" [")[0]?.trim() ?? clean;
  const [branchPart, upstreamPart] = withoutMetadata.includes("...")
    ? withoutMetadata.split("...", 2)
    : [withoutMetadata.split(/\s+/)[0], null];
  const aheadMatch = clean.match(/ahead (\d+)/);
  const behindMatch = clean.match(/behind (\d+)/);
  return {
    branch: branchPart || null,
    upstream: upstreamPart || null,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function dirtyCounts(status: string): { staged: number; modified: number; untracked: number } {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const line of status.split("\n")) {
    if (!line || line.startsWith("##")) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" || y === "?") untracked++;
    else {
      if (x && x !== " ") staged++;
      if (y && y !== " ") modified++;
    }
  }
  return { staged, modified, untracked };
}

function daysSince(dateValue: string | null): number | null {
  if (!dateValue) return null;
  const time = Date.parse(dateValue);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function existingGitRef(root: string, ref: string | null): string | null {
  if (!ref) return null;
  const result = git(root, ["rev-parse", "--verify", "--quiet", ref], 3000);
  return result.ok ? ref : null;
}

export function triageBranches(options: { cwd?: string; staleDays?: number; limit?: number } = {}): OpsReport & {
  kind: "branch_triage";
  git: {
    current: string | null;
    upstream: string | null;
    default_branch: string;
    ahead: number;
    behind: number;
    dirty: { staged: number; modified: number; untracked: number };
  };
  stale_branches: Array<{ name: string; days_stale: number | null; last_commit_date: string | null }>;
  merged_branches: string[];
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const staleDays = options.staleDays ?? 30;
  const issues: OpsIssue[] = [];
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"], 3000);

  if (!inside.ok || inside.stdout !== "true") {
    issues.push({ code: "not_git_repo", severity: "error", message: "Path is not a git repository" });
    return {
      kind: "branch_triage",
      schema_version: SCHEMA_VERSION,
      status: "fail",
      root: redactPath(root),
      git: { current: null, upstream: null, default_branch: "main", ahead: 0, behind: 0, dirty: { staged: 0, modified: 0, untracked: 0 } },
      stale_branches: [],
      merged_branches: [],
      summary: { issues: issues.length },
      issues: redactIssues(issues, limit),
      artifacts: [{ kind: "git", path: ".git" }],
      truncated: false,
    };
  }

  const status = git(root, ["status", "--porcelain=v1", "--branch"], 5000).stdout;
  const header = parseBranchHeader(status.split("\n")[0] ?? "");
  const defaultRef = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 3000).stdout;
  const defaultBranch = defaultRef ? defaultRef.replace(/^origin\//, "") : "main";
  const mergedBase = existingGitRef(root, defaultBranch)
    ?? existingGitRef(root, defaultRef || null)
    ?? existingGitRef(root, header.branch);
  const branchOutput = git(root, ["for-each-ref", "refs/heads", "--format=%(refname:short)|%(committerdate:iso8601)|%(objectname:short)"], 5000).stdout;
  const branches = branchOutput.split("\n").filter(Boolean).map((line) => {
    const [name, lastCommitDate] = line.split("|");
    return { name: name ?? "", last_commit_date: lastCommitDate ?? null, days_stale: daysSince(lastCommitDate ?? null) };
  });
  let merged: string[] = [];
  if (mergedBase) {
    const mergedResult = git(root, ["branch", "--merged", mergedBase], 5000);
    if (mergedResult.ok) {
      merged = mergedResult.stdout.split("\n")
        .map((line) => line.replace(/^\*\s*/, "").trim())
        .filter((name) => name && name !== defaultBranch && name !== header.branch)
        .sort();
    } else {
      issues.push({ code: "merged_scan_failed", severity: "info", message: "Could not scan merged local branches", ref: mergedBase });
    }
  } else {
    issues.push({ code: "merged_scan_failed", severity: "info", message: "No existing branch ref available for merged branch scan" });
  }

  const stale = branches
    .filter((branch) => branch.name && branch.name !== defaultBranch && branch.name !== header.branch && (branch.days_stale ?? 0) >= staleDays)
    .sort((a, b) => (b.days_stale ?? 0) - (a.days_stale ?? 0));
  const dirty = dirtyCounts(status);
  if (dirty.staged || dirty.modified || dirty.untracked) {
    issues.push({ code: "worktree_dirty", severity: "warning", message: "Worktree has uncommitted changes" });
  }
  if (header.behind > 0) {
    issues.push({ code: "branch_behind", severity: "warning", message: "Current branch is behind upstream", ref: redactMaybe(header.upstream) ?? undefined });
  }
  if (header.ahead > 0) {
    issues.push({ code: "branch_unpushed", severity: "warning", message: "Current branch has unpushed commits", ref: redactMaybe(header.upstream) ?? undefined });
  }
  if (stale.length > 0) {
    issues.push({ code: "stale_branches", severity: "info", message: `${stale.length} local branch(es) are stale`, ref: `${staleDays}d` });
  }
  if (merged.length > 0) {
    issues.push({ code: "merged_branches", severity: "info", message: `${merged.length} local branch(es) are merged into ${redactText(defaultBranch)}`, ref: redactText(defaultBranch) });
  }

  return {
    kind: "branch_triage",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues.filter((issue) => issue.severity !== "info")),
    root: redactPath(root),
    git: {
      current: redactMaybe(header.branch),
      upstream: redactMaybe(header.upstream),
      default_branch: redactText(defaultBranch),
      ahead: header.ahead,
      behind: header.behind,
      dirty,
    },
    stale_branches: stale.slice(0, limit).map((branch) => ({ ...branch, name: redactText(branch.name) })),
    merged_branches: redactArray(merged, limit),
    summary: {
      issues: issues.length,
      local_branches: branches.length,
      stale_branches: stale.length,
      merged_branches: merged.length,
    },
    issues: redactIssues(issues, limit),
    artifacts: [{ kind: "git", path: ".git" }],
    truncated: stale.length > limit || merged.length > limit || issues.length > limit,
  };
}

export function triagePullRequests(options: { cwd?: string; state?: string; staleDays?: number; limit?: number } = {}): OpsReport & {
  kind: "pr_triage";
  provider: "gh";
  pull_requests: Array<{
    number: number;
    title: string;
    author: string | null;
    is_draft: boolean;
    review_decision: string | null;
    merge_state: string | null;
    updated_at: string | null;
    days_stale: number | null;
    base: string | null;
    head: string | null;
    url: string | null;
  }>;
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const staleDays = options.staleDays ?? 14;
  const state = options.state ?? "open";
  const issues: OpsIssue[] = [];
  const gh = run("gh", [
    "pr",
    "list",
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,author,isDraft,reviewDecision,mergeStateStatus,updatedAt,baseRefName,headRefName,url",
  ], { cwd: root, timeout: 15_000, maxBuffer: 1024 * 1024 });

  if (!gh.ok) {
    issues.push({ code: "gh_pr_list_failed", severity: "warning", message: gh.stderr || "gh pr list failed" });
    return {
      kind: "pr_triage",
      schema_version: SCHEMA_VERSION,
      status: "warn",
      root: redactPath(root),
      provider: "gh",
      pull_requests: [],
      summary: { issues: issues.length, state: redactText(state), pull_requests: 0 },
      issues: redactIssues(issues, limit),
      artifacts: [],
      truncated: false,
    };
  }

  let rawPrs: Array<Record<string, unknown>>;
  try {
    rawPrs = JSON.parse(gh.stdout || "[]") as Array<Record<string, unknown>>;
  } catch {
    rawPrs = [];
    issues.push({ code: "gh_pr_json_parse_failed", severity: "warning", message: "Could not parse gh pr list output" });
  }

  const prs = rawPrs.map((pr) => {
    const author = pr["author"] as { login?: string } | null;
    const updatedAt = typeof pr["updatedAt"] === "string" ? pr["updatedAt"] : null;
    return {
      number: Number(pr["number"] ?? 0),
      title: shorten(pr["title"], 120),
      author: redactMaybe(author?.login),
      is_draft: Boolean(pr["isDraft"]),
      review_decision: typeof pr["reviewDecision"] === "string" ? redactText(pr["reviewDecision"]) : null,
      merge_state: typeof pr["mergeStateStatus"] === "string" ? redactText(pr["mergeStateStatus"]) : null,
      updated_at: updatedAt,
      days_stale: daysSince(updatedAt),
      base: typeof pr["baseRefName"] === "string" ? redactText(pr["baseRefName"]) : null,
      head: typeof pr["headRefName"] === "string" ? redactText(pr["headRefName"]) : null,
      url: typeof pr["url"] === "string" ? redactText(pr["url"]) : null,
    };
  });

  const draftCount = prs.filter((pr) => pr.is_draft).length;
  const staleCount = prs.filter((pr) => (pr.days_stale ?? 0) >= staleDays).length;
  const blockedCount = prs.filter((pr) => pr.merge_state && !["CLEAN", "HAS_HOOKS"].includes(pr.merge_state)).length;
  const reviewRequiredCount = prs.filter((pr) => pr.review_decision === "REVIEW_REQUIRED").length;
  if (staleCount > 0) issues.push({ code: "stale_prs", severity: "warning", message: `${staleCount} PR(s) stale for ${staleDays}+ days` });
  if (blockedCount > 0) issues.push({ code: "blocked_prs", severity: "warning", message: `${blockedCount} PR(s) have non-clean merge state` });
  if (reviewRequiredCount > 0) issues.push({ code: "review_required", severity: "info", message: `${reviewRequiredCount} PR(s) need review` });

  return {
    kind: "pr_triage",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues.filter((issue) => issue.severity !== "info")),
    root: redactPath(root),
    provider: "gh",
    pull_requests: prs,
    summary: {
      issues: issues.length,
      state: redactText(state),
      pull_requests: prs.length,
      draft: draftCount,
      stale: staleCount,
      blocked: blockedCount,
      review_required: reviewRequiredCount,
    },
    issues: redactIssues(issues, limit),
    artifacts: [],
    truncated: rawPrs.length >= limit,
  };
}

function expectedDocMentions(pkg: PackageJson | null): string[] {
  const mentions = new Set<string>();
  if (pkg?.name) mentions.add(pkg.name);
  for (const binName of Object.keys(typeof pkg?.bin === "object" ? pkg.bin : pkg?.bin ? { [basename(pkg.name ?? "bin")]: pkg.bin } : {})) {
    mentions.add(binName);
  }
  if (pkg?.name === "@hasna/repos" || mentions.has("repos")) {
    for (const command of OPS_COMMAND_MENTIONS) mentions.add(command);
  }
  return Array.from(mentions).sort();
}

export function getDocsDrift(options: { cwd?: string; limit?: number } = {}): OpsReport & {
  kind: "docs_drift";
  docs: {
    readme: string | null;
    expected_mentions: string[];
    missing_mentions: string[];
  };
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const { path: packagePath, pkg } = readPackage(root);
  const readmePath = join(root, "README.md");
  const issues: OpsIssue[] = [];
  const artifacts = [artifact(root, "package", packagePath)];
  let readmeText = "";

  if (!existsSync(readmePath)) {
    issues.push({ code: "readme_missing", severity: "warning", message: "README.md is missing", ref: "README.md" });
  } else {
    readmeText = readFileSync(readmePath, "utf-8");
    artifacts.push(artifact(root, "readme", readmePath));
  }

  const expected = expectedDocMentions(pkg);
  const missing = expected.filter((mention) => !readmeText.includes(mention));
  if (missing.length > 0) {
    issues.push({ code: "docs_mentions_missing", severity: "warning", message: `${missing.length} expected docs mention(s) are missing`, ref: "README.md" });
  }

  return {
    kind: "docs_drift",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    docs: {
      readme: existsSync(readmePath) ? "README.md" : null,
      expected_mentions: redactArray(expected, limit),
      missing_mentions: redactArray(missing, limit),
    },
    summary: {
      issues: issues.length,
      expected_mentions: expected.length,
      missing_mentions: missing.length,
    },
    issues: redactIssues(issues, limit),
    artifacts,
    truncated: expected.length > limit || missing.length > limit || issues.length > limit,
  };
}

const CI_WORKFLOW_NAMES = ["ci.yml", "ci.yaml"];
const PUBLISH_WORKFLOW_NAMES = ["publish.yml", "publish.yaml"];

function findWorkflowPath(root: string, names: string[]): string | null {
  for (const name of names) {
    const path = join(root, ".github", "workflows", name);
    if (existsSync(path)) return path;
  }
  return null;
}

function isTagTriggeredPublish(text: string): boolean {
  // The standard publish workflow runs on tag pushes: `on: push: tags: [...]`.
  // Only inspect the trigger section (everything before the first top-level
  // `jobs:` key) so `tags:` inputs inside job steps — e.g.
  // docker/build-push-action's `tags:` — cannot false-positive the check.
  const jobsIndex = text.search(/^jobs\s*:/m);
  const triggerSection = jobsIndex === -1 ? text : text.slice(0, jobsIndex);
  return /(^|\n)\s*on\s*:/.test(triggerSection) && /push\s*:[\s\S]{0,400}?tags\s*:/.test(triggerSection);
}

export function getReleasePipelineParity(options: {
  cwd?: string;
  limit?: number;
  includeRegistry?: boolean;
  runner?: OpsCommandRunner;
} = {}): OpsReport & {
  kind: "release_pipeline_parity";
  workflows: {
    ci: { present: boolean; path: string | null };
    publish: { present: boolean; path: string | null; tag_triggered: boolean };
    standard_pair: boolean;
  };
  registry: {
    checked: boolean;
    package: string | null;
    /** The registry actually consulted, resolved from publishConfig.registry. */
    registry_url: string;
    registry_source: "publishConfig.registry" | "default-npmjs";
    scope: RegistryScope;
    npm_latest: string | null;
    git_tag_for_latest: string | null;
    /**
     * True only when the published artifact is provably from this repo and has
     * no matching tag. Provenance is required because a name collision produces
     * the same tagless-latest symptom — hasna/cli's npmjs artifact has no
     * `v0.1.0` tag in hasna/cli because it was never built from that repo.
     */
    npm_latest_without_git_tag: boolean;
    /** `gitHead` of the published latest, when the publisher recorded one. */
    git_head: string | null;
    git_head_reachability: GitHeadReachability;
    /** The published artifact's own `repository`, normalized to host/owner/name. */
    published_repository: string | null;
    /**
     * Whether that repository is this repo. The weaker of the two provenance
     * axes, and the only one available for the ~40% of fleet artifacts published
     * without a `gitHead`.
     */
    repository_attribution: RepositoryAttribution;
  };
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const runner = options.runner ?? run;
  const { path: packagePath, pkg } = readPackage(root);
  const issues: OpsIssue[] = [];
  const artifacts = [artifact(root, "package", packagePath)];

  const ciPath = findWorkflowPath(root, CI_WORKFLOW_NAMES);
  const publishPath = findWorkflowPath(root, PUBLISH_WORKFLOW_NAMES);
  let publishTagTriggered = false;
  if (ciPath) artifacts.push(artifact(root, "workflow", ciPath));
  if (publishPath) artifacts.push(artifact(root, "workflow", publishPath));

  if (!ciPath) {
    issues.push({ code: "ci_workflow_missing", severity: "warning", message: "Standard CI workflow is missing", ref: ".github/workflows/ci.yml" });
  }
  if (!publishPath) {
    issues.push({ code: "publish_workflow_missing", severity: "warning", message: "Standard tag-publish workflow is missing", ref: ".github/workflows/publish.yml" });
  } else {
    try {
      publishTagTriggered = isTagTriggeredPublish(readFileSync(publishPath, "utf-8"));
    } catch {
      publishTagTriggered = false;
    }
    if (!publishTagTriggered) {
      issues.push({
        code: "publish_workflow_not_tag_triggered",
        severity: "warning",
        message: "Publish workflow does not run on tag pushes (expected on: push: tags)",
        ref: ".github/workflows/publish.yml",
      });
    }
  }

  // The registry to compare against comes from the manifest. Comparing every
  // package against npmjs is what let hasna/cli — publishConfig.registry
  // npm.pkg.github.com, access restricted — be measured against an unrelated
  // npmjs package of the same name.
  const target = resolveRegistryTarget(pkg);
  const registry: ReturnType<typeof getReleasePipelineParity>["registry"] = {
    checked: false,
    package: redactMaybe(pkg?.name),
    registry_url: target.registry_url,
    registry_source: target.registry_source,
    scope: target.scope,
    npm_latest: null,
    git_tag_for_latest: null,
    npm_latest_without_git_tag: false,
    git_head: null,
    git_head_reachability: "unknown",
    published_repository: null,
    repository_attribution: "absent",
  };

  if (options.includeRegistry !== false) {
    if (!pkg?.name) {
      issues.push({ code: "registry_check_skipped", severity: "info", message: "No package name; skipping npm registry drift check", ref: "package.json" });
    } else if (pkg.private) {
      issues.push({ code: "registry_check_skipped", severity: "info", message: "Package is private; skipping npm registry drift check", ref: "package.json" });
    } else if (!target.in_npmjs_divergence_scope) {
      // Separately classified rather than skipped silently: the scope and the
      // reason are on the report so these packages remain auditable.
      issues.push({
        code: "registry_out_of_npmjs_scope",
        severity: "info",
        message: `Out of npmjs drift scope (${target.scope}): ${target.out_of_scope_reasons.join("; ")}`,
        ref: "package.json",
      });
    } else {
      const npm = runner("npm", ["view", pkg.name, "version"], { cwd: root, timeout: 15_000 });
      if (!npm.ok || !npm.stdout.trim()) {
        if (/E404|404 Not Found|is not in this registry/i.test(npm.stderr)) {
          issues.push({ code: "npm_package_not_published", severity: "info", message: "Package has no published version on the npm registry", ref: redactText(pkg.name) });
        } else {
          issues.push({ code: "npm_registry_unreachable", severity: "info", message: "Could not read npm registry latest (offline or npm unavailable)", ref: redactText(pkg.name) });
        }
      } else {
        registry.checked = true;
        const latest = npm.stdout.trim().split("\n")[0]!.replace(/^"|"$/g, "");
        registry.npm_latest = redactText(latest);

        // Provenance of the published artifact. Without it, "npm latest has no
        // matching git tag" cannot distinguish a publish that bypassed the tag
        // pipeline from a package of the same name that was never built here.
        const gitHeadView = runner("npm", ["view", `${pkg.name}@${latest}`, "gitHead"], { cwd: root, timeout: 15_000 });
        const publishedGitHead = gitHeadView.ok
          ? gitHeadView.stdout.trim().split("\n")[0]?.replace(/^"|"$/g, "").trim() || null
          : null;
        registry.git_head = publishedGitHead ? redactText(publishedGitHead) : null;

        // Second, weaker provenance axis, for the majority of artifacts that
        // carry no gitHead at all. Without it, every such package loses the
        // tag-pipeline-bypass signal entirely.
        const repositoryView = runner("npm", ["view", `${pkg.name}@${latest}`, "repository.url"], { cwd: root, timeout: 15_000 });
        const publishedRepository = repositoryView.ok
          ? repositoryView.stdout.trim().split("\n")[0]?.replace(/^"|"$/g, "").trim() || null
          : null;
        const originUrl = git(root, ["config", "--get", "remote.origin.url"], 3000);
        registry.published_repository = normalizeRepositoryIdentity(publishedRepository);
        registry.repository_attribution = attributeRepository(publishedRepository, [
          (pkg as { repository?: unknown }).repository,
          originUrl.ok ? originUrl.stdout.trim() : null,
        ]);

        const inside = git(root, ["rev-parse", "--is-inside-work-tree"], 3000);
        if (!inside.ok || inside.stdout !== "true") {
          issues.push({ code: "tag_check_skipped", severity: "info", message: "Path is not a git repository; skipping npm-latest tag check" });
        } else {
          const shallow = git(root, ["rev-parse", "--is-shallow-repository"], 3000);
          registry.git_head_reachability = probeGitHeadReachability({
            gitHead: publishedGitHead,
            isGitRepo: true,
            isShallow: shallow.ok && shallow.stdout === "true",
            runProbe: (sha) => {
              const probe = git(root, gitHeadProbeArgs(sha), 5000);
              return { status: probe.exitCode, stderr: probe.stderr };
            },
          });

          if (registry.git_head_reachability === "absent") {
            // Not drift. The registry name resolves to someone else's package,
            // so no tag is expected here and none should be demanded.
            issues.push({
              code: "registry_unrelated_name",
              severity: "warning",
              message: `${redactText(pkg.name)}@${redactText(latest)} on ${registry.registry_url} was published from ${registry.git_head}, which is not a commit in this repo — the registry name resolves to a different package, not a stale version`,
              ref: redactText(pkg.name),
            });
          } else {
            const tags = git(root, ["tag", "--list", `v${latest}`, latest], 5000);
            let tag = tags.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? null;
            if (!tag) {
              // Local tags can be missing entirely (shallow/partial clones, CI
              // checkouts with fetch-tags disabled). The registry path is already
              // network-opt-in, so consult the remote before flagging drift.
              const remote = git(root, ["ls-remote", "--tags", "origin", `v${latest}`, latest], 10_000);
              if (remote.ok) {
                tag =
                  remote.stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => line.split(/\s+/).pop() ?? "")
                    .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
                    .filter(Boolean)[0] ?? null;
              }
            }
            registry.git_tag_for_latest = tag ? redactText(tag) : null;
            // Attributable either by a reachable gitHead (proof) or, for the
            // majority of artifacts that carry no gitHead, by the artifact
            // declaring exactly this repository (corroboration). Requiring the
            // gitHead alone silently retired this check for most of the fleet.
            const attributable = registry.git_head_reachability === "reachable"
              || (publishedGitHead === null && registry.repository_attribution === "match");
            if (!tag && attributable) {
              registry.npm_latest_without_git_tag = true;
              issues.push({
                code: "npm_latest_without_git_tag",
                severity: "warning",
                message: `npm latest ${redactText(latest)} has no matching git tag locally or on origin (publish bypassed the tag pipeline?)`,
                ref: redactText(latest),
              });
            } else if (!tag) {
              // The tag really is missing, but the artifact cannot be attributed
              // to this repo, so "bypassed the tag pipeline" is an unproven
              // claim and must not be raised as one.
              issues.push({
                code: "npm_latest_without_git_tag_unverified",
                severity: "info",
                message: `npm latest ${redactText(latest)} has no matching git tag, and the published artifact cannot be attributed to this repo (no verifiable gitHead, repository attribution ${registry.repository_attribution})`,
                ref: redactText(latest),
              });
            }
          }
        }
      }
    }
  }

  const workflows = {
    ci: { present: Boolean(ciPath), path: ciPath ? artifact(root, "workflow", ciPath).path : null },
    publish: { present: Boolean(publishPath), path: publishPath ? artifact(root, "workflow", publishPath).path : null, tag_triggered: publishTagTriggered },
    standard_pair: Boolean(ciPath) && Boolean(publishPath) && publishTagTriggered,
  };

  return {
    kind: "release_pipeline_parity",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    workflows,
    registry,
    summary: {
      issues: issues.length,
      standard_pair: workflows.standard_pair,
      registry_checked: registry.checked,
      npm_latest_without_git_tag: registry.npm_latest_without_git_tag,
    },
    issues: redactIssues(issues, limit),
    artifacts,
    truncated: issues.length > limit,
  };
}

/**
 * Confirm which candidate repos actually declare a dependency on a package.
 *
 * The correct replacement for `gh search code "<package>"`, which is substring
 * matching: during the 2026-07 cleanup wave it reported hasna/clip
 * (`@hasna/clip`) and hasnaxyz/iapp-clips (`@hasna/clips`) as dependents of
 * `@hasna/cli`, and hasna/browserplan as a dependent of `entity_get` on the
 * strength of Chromium identity-API source text. A candidate is confirmed only
 * by an exact dependency-map key in a manifest; near misses are reported so a
 * rejected candidate stays visible rather than silently vanishing.
 */
export function getManifestDependents(options: {
  packageName: string;
  roots: string[];
  limit?: number;
  maxDepth?: number;
}): OpsReport & {
  kind: "manifest_dependents";
  package_name: string;
  confirmed: ManifestDependentFinding[];
  rejected: ManifestDependentFinding[];
} {
  const limit = capLimit(options.limit);
  const root = rootOf();
  const packageName = options.packageName.trim();
  const issues: OpsIssue[] = [];

  const candidates = options.roots.map((candidateRoot) => {
    const absolute = resolve(candidateRoot);
    return {
      candidate: redactPath(absolute),
      manifests: existsSync(absolute) ? collectRepoManifests(absolute, { maxDepth: options.maxDepth }) : [],
    };
  });

  const result = confirmManifestDependents({ packageName, candidates });

  if (packageName.length === 0) {
    issues.push({ code: "dependent_query_empty", severity: "error", message: "No package name to confirm dependents for" });
  }
  for (const finding of result.rejected) {
    if (finding.rejection !== "substring-only-match") continue;
    issues.push({
      code: "dependent_substring_only",
      severity: "info",
      message: `${finding.candidate} declares ${finding.near_miss_names.join(", ")} but no dependency on ${redactText(packageName)}; a substring search would have reported it as a dependent`,
      ref: finding.candidate,
    });
  }

  return {
    kind: "manifest_dependents",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    package_name: redactText(packageName),
    summary: {
      candidates: result.summary.candidates,
      confirmed: result.summary.confirmed,
      rejected: result.summary.rejected,
      substring_only: result.summary.substring_only,
    },
    confirmed: result.confirmed.slice(0, limit),
    rejected: result.rejected.slice(0, limit),
    issues: redactIssues(issues, limit),
    artifacts: [],
    truncated: result.confirmed.length > limit || result.rejected.length > limit,
  };
}

export function getReleaseHealth(options: { cwd?: string; limit?: number; includeGit?: boolean; includeRegistry?: boolean; staleDays?: number } = {}): OpsReport & {
  kind: "release_health";
  checks: {
    package: Pick<ReturnType<typeof getPackageHealth>, "status" | "summary" | "truncated">;
    drift: Pick<ReturnType<typeof getPackageDrift>, "status" | "summary" | "truncated">;
    docs: Pick<ReturnType<typeof getDocsDrift>, "status" | "summary" | "truncated">;
    branches: Pick<ReturnType<typeof triageBranches>, "status" | "summary" | "truncated"> | null;
    pipeline: Pick<ReturnType<typeof getReleasePipelineParity>, "status" | "summary" | "truncated">;
  };
} {
  const root = rootOf(options.cwd);
  const limit = capLimit(options.limit);
  const packageHealth = getPackageHealth({ cwd: root, limit });
  const packageDrift = getPackageDrift({ cwd: root, limit });
  const docsDrift = getDocsDrift({ cwd: root, limit });
  const branchTriage = options.includeGit === false ? null : triageBranches({ cwd: root, limit, staleDays: options.staleDays });
  // Registry drift needs the network, so inside the aggregate health surface it is opt-in;
  // `repos release parity` checks the registry by default.
  const pipelineParity = getReleasePipelineParity({ cwd: root, limit, includeRegistry: options.includeRegistry === true });
  const issues: OpsIssue[] = [];
  const seenIssues = new Set<string>();

  for (const [scope, report] of [
    ["package", packageHealth],
    ["drift", packageDrift],
    ["docs", docsDrift],
    ["branches", branchTriage],
    ["pipeline", pipelineParity],
  ] as const) {
    if (!report) continue;
    for (const issue of report.issues) {
      if (issue.severity === "info") continue;
      const dedupeKey = `${issue.message}:${issue.ref ?? ""}`;
      if (seenIssues.has(dedupeKey)) continue;
      seenIssues.add(dedupeKey);
      issues.push({ ...issue, code: `${scope}_${issue.code}` });
    }
  }

  return {
    kind: "release_health",
    schema_version: SCHEMA_VERSION,
    status: statusFor(issues),
    root: redactPath(root),
    checks: {
      package: { status: packageHealth.status, summary: packageHealth.summary, truncated: packageHealth.truncated },
      drift: { status: packageDrift.status, summary: packageDrift.summary, truncated: packageDrift.truncated },
      docs: { status: docsDrift.status, summary: docsDrift.summary, truncated: docsDrift.truncated },
      branches: branchTriage ? { status: branchTriage.status, summary: branchTriage.summary, truncated: branchTriage.truncated } : null,
      pipeline: { status: pipelineParity.status, summary: pipelineParity.summary, truncated: pipelineParity.truncated },
    },
    summary: {
      issues: issues.length,
      ready: issues.length === 0,
      git_checked: Boolean(branchTriage),
      pipeline_standard_pair: pipelineParity.workflows.standard_pair,
    },
    issues: redactIssues(issues, limit),
    artifacts: dedupeBy([...packageHealth.artifacts, ...packageDrift.artifacts, ...docsDrift.artifacts, ...pipelineParity.artifacts], (entry) => `${entry.kind}:${entry.path}`),
    truncated: issues.length > limit || packageHealth.truncated || packageDrift.truncated || docsDrift.truncated || pipelineParity.truncated || Boolean(branchTriage?.truncated),
  };
}

function reportComment(report: OpsReport): string {
  const issueCodes = report.issues.slice(0, 5).map((issue) => issue.code).join(", ") || "none";
  return `repos ${report.kind}: status=${report.status}; issues=${report.issues.length}; top=${issueCodes}; root=${report.root}`;
}

export function withTodos<T extends OpsReport>(report: T, options: TodosIntegrationOptions = {}): T {
  if (!options.taskId) return report;
  const comment = reportComment(report);
  const base: TodosIntegrationResult = {
    task_id: options.taskId,
    dry_run: !options.apply,
    applied: false,
    comment_preview: comment,
  };

  if (!options.apply) {
    return { ...report, todos: base };
  }

  const args = [];
  if (options.project) args.push("--project", options.project);
  if (options.agent) args.push("--agent", options.agent);
  args.push("comment", options.taskId, comment);
  const result = run("todos", args, { cwd: options.cwd, timeout: 10_000, maxBuffer: 512 * 1024 });
  return {
    ...report,
    todos: {
      ...base,
      dry_run: false,
      applied: result.ok,
      error: result.ok ? undefined : result.stderr || "todos comment failed",
    },
  };
}
