/**
 * Whether a registry row's path is a checkout anything can actually be done to.
 *
 * The registry stored 1581 rows on this machine. Classified against the
 * filesystem on 2026-07-28, **1056 of them (66.8%) pointed at something git
 * refuses to open**:
 *
 *   worktree-severed-common-dir   394   .git file -> gitdir exists, its common dir is gutted
 *   worktree-dangling-gitdir      299   .git file -> gitdir does not exist
 *   missing-path                  291   path absent entirely
 *   hollow-git-dir                 65   .git directory holding only hooks/ and worktrees/
 *   no-git-dir                      7   path exists, no .git, not bare
 *
 * `getRepo` did none of this. It matched a row by path or name and returned it,
 * so `repos repo <name> --json` answered with a `path` for two rows in three
 * that no `git worktree add`, no `cd`, and no `git -C` can use. The lookup
 * succeeded while telling the caller nothing — and every global rule directs
 * agents to that lookup for exact targeting and forbids fuzzy `repos cd` output,
 * so the mandated method was the one that failed silently. Agents then
 * improvised: independent re-clones, and two of them committing into one
 * worktree.
 *
 * Two properties this module is built for:
 *
 *  1. **It is a structural verdict, computed from the filesystem, with no git
 *     subprocess.** That is what makes it affordable on *every* lookup rather
 *     than only in a diagnostic command — and a guard that is too expensive to
 *     run by default is a guard that does not run. Cross-validated against git
 *     itself over all 1581 real rows: `git -C <path> rev-parse
 *     --absolute-git-dir` rejects exactly the 765 rows this module classes as
 *     `hollow-git-dir` + `no-git-dir` + `worktree-dangling-gitdir` +
 *     `worktree-severed-common-dir` (65 + 7 + 299 + 394 = 765).
 *
 *  2. **It never guesses.** A path that cannot be read (permissions, a broken
 *     mount) is `unreadable`, which is not the same claim as "not a repository".
 *     Reporting an unreadable path as gutted would invite someone to re-clone
 *     over a checkout that was merely inaccessible.
 *
 *     Property 2 is why every existence check here goes through
 *     {@link CheckoutFs.probe}, which answers `present` / `absent` /
 *     `unreadable` rather than a boolean. `existsSync` cannot express the third
 *     answer: it returns `false` for `EACCES` exactly as it does for `ENOENT`.
 *     Built on `existsSync`, this module classified a **complete** checkout at
 *     mode 000 as `no-git-dir`, whose remedy is "the directory survives but its
 *     repository does not — re-clone it" — a data-loss instruction synthesised
 *     from a permissions error, on a repository that was entirely intact.
 *     Absence is now a positive finding (`ENOENT`/`ENOTDIR`); every other errno
 *     means only that the probe was blocked.
 *
 * What it deliberately does not do is judge repository *content*: object
 * corruption, a broken index, or an unfetched shallow history all read as
 * usable here. Those are real conditions, they are not this defect, and
 * detecting them needs the git subprocess this module exists to avoid.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizeRemoteIdentity } from "./remote-identity.js";

export type CheckoutState =
  /** A repository git can open: real clone, or a linked worktree with a live common dir. */
  | "usable"
  /** Opens as a repository, but has no commit yet — `git worktree add` will refuse. */
  | "no-commits"
  /** The stored path does not exist. */
  | "missing-path"
  /** The path exists but holds no `.git` and is not a bare repository. */
  | "no-git-dir"
  /** A `.git` directory stripped of HEAD, objects and refs — the reported failure mode. */
  | "hollow-git-dir"
  /** A `.git` file whose `gitdir:` target is gone. */
  | "worktree-dangling-gitdir"
  /** A `.git` file whose gitdir survives but whose common dir has been gutted. */
  | "worktree-severed-common-dir"
  /** A `.git` file that does not carry a parseable `gitdir:` pointer. */
  | "worktree-unparseable-pointer"
  /**
   * Something on the path could not be read. Not a claim that it is broken.
   *
   * Reached whenever a probe is *blocked* rather than answered — a mode-000
   * directory, an unmounted volume, a symlink loop. The checkout underneath may
   * be perfectly intact, so no remedy here may destroy it.
   */
  | "unreadable";

export interface CheckoutHealth {
  path: string;
  state: CheckoutState;
  /** True only for states a caller can hand to git or `cd` into. */
  usable: boolean;
  /** One line, safe for an error message, naming what was found. */
  detail: string;
  /** For linked worktrees: the resolved `gitdir:` target, when there was one. */
  git_dir: string | null;
  /** For linked worktrees: the resolved common dir, when there was one. */
  common_dir: string | null;
}

/**
 * What a probe could establish about a path.
 *
 * `absent` is a *finding*: something looked and there was nothing there.
 * `unreadable` is the absence of a finding. Collapsing the two — which is what a
 * boolean does — is the whole defect this type exists to prevent.
 */
export type PathPresence = "present" | "absent" | "unreadable";

export interface PathProbe {
  presence: PathPresence;
  /** The errno that blocked the probe, when one did. Named in the message so an operator can act. */
  code: string | null;
}

/** Injectable filesystem, so every branch is reachable in a test. */
export interface CheckoutFs {
  /**
   * Tri-state existence probe. Implementations report unreadability rather than
   * throwing it, so that classification reads it as an answer instead of
   * inferring it from a caught exception.
   */
  probe(path: string): PathProbe;
  isDirectory(path: string): boolean;
  readText(path: string): string;
  readDir(path: string): string[];
}

/**
 * The errnos that mean "there is nothing here", as opposed to "I was not allowed
 * to look".
 *
 * `ENOTDIR` belongs with `ENOENT`: a path component that is a regular file proves
 * the target does not exist as spelled. Every other errno — `EACCES`, `EPERM`,
 * `ELOOP`, `EIO` on a dying disk, `ESTALE` on a stale NFS handle — proves only
 * that the probe was blocked, and must never become a claim about the repository.
 * Unrecognised errnos fall on the `unreadable` side deliberately: the safe
 * default is to admit ignorance.
 */
const ABSENT_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

function errnoOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

export const nodeCheckoutFs: CheckoutFs = {
  probe: (path) => {
    try {
      // `statSync`, not `existsSync`: the same syscall, but the errno survives.
      statSync(path);
      return { presence: "present", code: null };
    } catch (error) {
      const code = errnoOf(error);
      return code !== null && ABSENT_ERRNOS.has(code)
        ? { presence: "absent", code }
        : { presence: "unreadable", code };
    }
  },
  isDirectory: (path) => statSync(path).isDirectory(),
  readText: (path) => readFileSync(path, "utf8"),
  readDir: (path) => readdirSync(path),
};

/**
 * Probe through a guard, so a `CheckoutFs` that throws (the interface asks it not
 * to, but a caller's fake may) still degrades to `unreadable` instead of
 * propagating. The verdict does not *depend* on the throw — the non-throwing path
 * arrives at the same place by reading the returned presence.
 */
function probe(fs: CheckoutFs, path: string): PathProbe {
  try {
    return fs.probe(path);
  } catch (error) {
    return { presence: "unreadable", code: errnoOf(error) };
  }
}

/**
 * The three entries that make a directory a git object database.
 *
 * All three are required. A gutted `.git` on this machine retains `hooks/` and
 * `worktrees/`, so a test for "does `.git` exist" — which is what the scanner
 * used — accepts every one of the 65 hollow rows as a repository.
 */
const GIT_DIR_REQUIRED_ENTRIES = ["HEAD", "objects", "refs"] as const;

interface GitDirScan {
  /** Required entries a probe established are not there. */
  missing: string[];
  /** Required entries a probe could not look at. Takes precedence over `missing`. */
  unreadable: string[];
  /** The errno that blocked the first unreadable probe. */
  code: string | null;
}

/**
 * Probe the three entries that make a directory a git object database.
 *
 * `unreadable` outranks `missing`, and that ordering is the safety property: if
 * even one required entry could not be looked at, the directory has not been
 * shown to be gutted, and nothing downstream may act as though it had been.
 */
function scanGitDirEntries(fs: CheckoutFs, gitDir: string): GitDirScan {
  const scan: GitDirScan = { missing: [], unreadable: [], code: null };
  for (const entry of GIT_DIR_REQUIRED_ENTRIES) {
    const result = probe(fs, join(gitDir, entry));
    if (result.presence === "absent") {
      scan.missing.push(entry);
    } else if (result.presence === "unreadable") {
      scan.unreadable.push(entry);
      scan.code ??= result.code;
    }
  }
  return scan;
}

/**
 * Has anything been committed yet?
 *
 * A freshly `git init`ed repository opens fine and answers most commands, but
 * `git worktree add` refuses it, so it must not be reported as interchangeable
 * with a populated checkout. Detected without a subprocess: an unborn HEAD names
 * a ref that exists nowhere in `refs/` or `packed-refs`.
 */
function hasAnyRef(fs: CheckoutFs, commonDir: string): boolean {
  // Only a probe that positively establishes absence counts as absence here.
  // Unreadable ref storage must not downgrade a populated repository to
  // "no commits", because that tells a caller `git worktree add` will refuse when
  // it would in fact succeed. (An unreadable common dir is normally already caught
  // by `scanGitDirEntries`; the direction is stated here because this is where it
  // is decided.)
  if (probe(fs, join(commonDir, "packed-refs")).presence !== "absent") return true;
  const headsDir = join(commonDir, "refs", "heads");
  const heads = probe(fs, headsDir);
  if (heads.presence === "absent") return false;
  if (heads.presence === "unreadable") return true;
  try {
    return fs.readDir(headsDir).length > 0;
  } catch {
    return true;
  }
}

function health(
  path: string,
  state: CheckoutState,
  detail: string,
  extra: { gitDir?: string | null; commonDir?: string | null } = {},
): CheckoutHealth {
  return {
    path,
    state,
    usable: state === "usable" || state === "no-commits",
    detail,
    git_dir: extra.gitDir ?? null,
    common_dir: extra.commonDir ?? null,
  };
}

/**
 * The one verdict that must never be inferred from a failure to look.
 *
 * `blockedAt` is the exact path the probe stopped on, and `code` the errno that
 * stopped it, because "check permissions and mounts" is only actionable if the
 * operator is told where and why.
 */
function unreadable(
  path: string,
  blockedAt: string,
  code: string | null,
  extra: { gitDir?: string | null; commonDir?: string | null } = {},
): CheckoutHealth {
  const because = code === null ? "" : ` (${code})`;
  return health(
    path,
    "unreadable",
    `${blockedAt} could not be read${because}; this is not evidence that it is broken`,
    extra,
  );
}

/**
 * The " (it holds only: ...)" tail on a hollow-`.git` message.
 *
 * Decoration, and deliberately isolated as such. This read used to *be* the
 * classification for a mode-000 `.git`: that case reported `unreadable` only
 * because `readdirSync` threw, which left a safety-critical verdict resting on a
 * cosmetic code path — hand it a `readDir` that cannot fail and the verdict
 * inverted to `hollow-git-dir`, which re-clones. The hollow verdict is now
 * established by {@link scanGitDirEntries} alone, so a failure here costs the
 * decoration and nothing else. A directory readable enough to stat its children
 * but not to list them (mode `--x`) is the real case that still lands here.
 */
function describeHeldEntries(fs: CheckoutFs, gitDir: string): string {
  try {
    const entries = fs.readDir(gitDir);
    return entries.length > 0 ? ` (it holds only: ${entries.join(", ")})` : "";
  } catch {
    return "";
  }
}

/** Resolve the `gitdir:` pointer in a linked worktree's `.git` file. */
function readWorktreePointer(fs: CheckoutFs, dotGitFile: string): string | null {
  const text = fs.readText(dotGitFile);
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return null;
  const target = match[1]!.trim();
  if (target.length === 0) return null;
  return resolve(dirname(dotGitFile), target);
}

/**
 * Classify what is actually at `path`.
 *
 * Order matters and is the safety property: existence, then readability, then
 * structure. Nothing downstream may conclude "broken" from a condition that
 * only proves "could not look".
 */
export function classifyCheckout(path: string, fs: CheckoutFs = nodeCheckoutFs): CheckoutHealth {
  if (!path || path.trim().length === 0) {
    return health(path, "missing-path", "the registry row stores no path");
  }
  const pathProbe = probe(fs, path);
  if (pathProbe.presence === "unreadable") return unreadable(path, path, pathProbe.code);
  if (pathProbe.presence === "absent") {
    return health(path, "missing-path", `${path} does not exist`);
  }

  const dotGit = join(path, ".git");
  const dotGitProbe = probe(fs, dotGit);
  // A checkout directory at mode 000 blocks this probe on a repository that is
  // entirely intact: the directory itself stats fine (its parent is readable), but
  // nothing inside it can be reached. `existsSync` reported that as "no .git
  // here", which classified as `no-git-dir` and told the operator to re-clone.
  if (dotGitProbe.presence === "unreadable") return unreadable(path, dotGit, dotGitProbe.code);

  if (dotGitProbe.presence === "absent") {
    // A bare repository has the object database at the top level.
    const scan = scanGitDirEntries(fs, path);
    if (scan.unreadable.length > 0) {
      return unreadable(path, join(path, scan.unreadable[0]!), scan.code);
    }
    if (scan.missing.length === 0) {
      return hasAnyRef(fs, path)
        ? health(path, "usable", `${path} is a bare repository`, { gitDir: path, commonDir: path })
        : health(path, "no-commits", `${path} is a bare repository with no commits`, { gitDir: path, commonDir: path });
    }
    return health(path, "no-git-dir", `${path} exists but contains no .git and is not a bare repository`);
  }

  let dotGitIsDir: boolean;
  try {
    dotGitIsDir = fs.isDirectory(dotGit);
  } catch (error) {
    return unreadable(path, dotGit, errnoOf(error));
  }

  if (dotGitIsDir) {
    const scan = scanGitDirEntries(fs, dotGit);
    if (scan.unreadable.length > 0) {
      return unreadable(path, join(dotGit, scan.unreadable[0]!), scan.code, { gitDir: dotGit, commonDir: dotGit });
    }
    if (scan.missing.length > 0) {
      return health(
        path,
        "hollow-git-dir",
        `${dotGit} is missing ${scan.missing.join(", ")}${describeHeldEntries(fs, dotGit)}`,
        { gitDir: dotGit, commonDir: dotGit },
      );
    }
    return hasAnyRef(fs, dotGit)
      ? health(path, "usable", `${path} is a git checkout`, { gitDir: dotGit, commonDir: dotGit })
      : health(path, "no-commits", `${path} is a git checkout with no commits`, { gitDir: dotGit, commonDir: dotGit });
  }

  // `.git` is a file: a linked worktree pointing at a gitdir elsewhere.
  let gitDir: string | null;
  try {
    gitDir = readWorktreePointer(fs, dotGit);
  } catch (error) {
    return unreadable(path, dotGit, errnoOf(error));
  }
  if (!gitDir) {
    return health(path, "worktree-unparseable-pointer", `${dotGit} carries no usable 'gitdir:' pointer`);
  }

  const gitDirProbe = probe(fs, gitDir);
  // Same swallowed errno one level down. A gitdir behind an unreadable parent is
  // not a severed worktree, and saying it is sends the caller off to hand-copy
  // unpushed work out of a worktree whose parent repository is fine.
  if (gitDirProbe.presence === "unreadable") return unreadable(path, gitDir, gitDirProbe.code, { gitDir });
  if (gitDirProbe.presence === "absent") {
    return health(path, "worktree-dangling-gitdir", `${dotGit} points at ${gitDir}, which does not exist`, { gitDir });
  }

  const commonDirFile = join(gitDir, "commondir");
  const commonDirProbe = probe(fs, commonDirFile);
  if (commonDirProbe.presence === "unreadable") {
    return unreadable(path, commonDirFile, commonDirProbe.code, { gitDir });
  }
  let commonDir = gitDir;
  if (commonDirProbe.presence === "present") {
    try {
      commonDir = resolve(gitDir, fs.readText(commonDirFile).trim());
    } catch (error) {
      return unreadable(path, commonDirFile, errnoOf(error), { gitDir });
    }
  }

  const scan = scanGitDirEntries(fs, commonDir);
  if (scan.unreadable.length > 0) {
    return unreadable(path, join(commonDir, scan.unreadable[0]!), scan.code, { gitDir, commonDir });
  }
  if (scan.missing.length > 0) {
    return health(
      path,
      "worktree-severed-common-dir",
      `${dotGit} resolves to ${commonDir}, which is missing ${scan.missing.join(", ")}`,
      { gitDir, commonDir },
    );
  }
  return hasAnyRef(fs, commonDir)
    ? health(path, "usable", `${path} is a linked worktree of ${commonDir}`, { gitDir, commonDir })
    : health(path, "no-commits", `${path} is a linked worktree of ${commonDir}, which has no commits`, { gitDir, commonDir });
}

/**
 * The remedy line an error message carries.
 *
 * A refusal that only says "unusable" moves the dead end from the path to the
 * message. Every unusable state has a next action, and when the row knows the
 * remote the exact clone command can be named instead of described.
 */
export function describeCheckoutRemedy(
  reportedHealth: CheckoutHealth,
  opts: { remoteUrl?: string | null; repoName?: string | null } = {},
): string {
  const remote = sanitizeRemoteIdentity(opts.remoteUrl);
  const cloneTarget = remote ? `https://${remote}` : null;
  const cloneHint = cloneTarget
    ? `Re-clone it with: git clone ${cloneTarget} <path>`
    : "This row records no remote, so there is nothing to re-clone from; remove the row instead.";

  switch (reportedHealth.state) {
    case "usable":
    case "no-commits":
      return "";
    case "missing-path":
      return `The path is gone. ${cloneHint}`;
    case "no-git-dir":
      return `The directory survives but its repository does not. ${cloneHint}`;
    case "hollow-git-dir":
      return `The .git directory was stripped of its object database, so 'git worktree add' against it is impossible. ${cloneHint}`;
    case "worktree-dangling-gitdir":
    case "worktree-severed-common-dir":
      return "This is a linked worktree whose parent repository is gone, so its contents cannot be recovered through git. Copy anything unpushed out by hand before removing it.";
    case "worktree-unparseable-pointer":
      return "The .git file is corrupt. Inspect it before doing anything destructive.";
    case "unreadable":
      return "The path could not be read — check permissions and mounts before concluding it is broken. Do NOT re-clone over it.";
  }
}

/** Counts by state, for a registry-wide report. */
export function summarizeCheckoutStates(states: CheckoutState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of states) counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}
