import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCheckout,
  describeCheckoutRemedy,
  nodeCheckoutFs,
  summarizeCheckoutStates,
  type CheckoutFs,
  type CheckoutState,
} from "./checkout-health.js";

const root = mkdtempSync(join(tmpdir(), "repos-checkout-health-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Without a ceiling, git walks *above* the fixture and can answer from an
      // ancestor repository — /tmp/.git exists on this machine, which would make
      // a gutted fixture report as a healthy repo and quietly invert this test.
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return { code: result.exitCode ?? -1, out: result.stdout.toString().trim() };
}

function makeRepo(name: string, opts: { commit?: boolean } = {}): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  expect(git(path, ["init", "-q", "-b", "main", "."]).code).toBe(0);
  if (opts.commit !== false) {
    expect(git(path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]).code).toBe(0);
  }
  return path;
}

/** Strip a `.git` down to what the real gutted checkouts on this machine retain. */
function gutGitDir(repoPath: string): void {
  const dotGit = join(repoPath, ".git");
  rmSync(dotGit, { recursive: true, force: true });
  mkdirSync(join(dotGit, "hooks"), { recursive: true });
  mkdirSync(join(dotGit, "worktrees"), { recursive: true });
}

describe("classifyCheckout against real git fixtures", () => {
  test("a normal clone is usable, and git agrees", () => {
    const path = makeRepo("normal-clone");
    const result = classifyCheckout(path);
    expect(result.state).toBe("usable");
    expect(result.usable).toBe(true);
    const probe = git(path, ["rev-parse", "--absolute-git-dir"]);
    expect(probe.code).toBe(0);
    expect(probe.out).toBe(join(path, ".git"));
  });

  test("a fresh repository with no commit is reported separately, not as interchangeable", () => {
    // git opens it, but `git worktree add` refuses it. Calling it plain "usable"
    // would send a caller into a command that cannot succeed.
    const path = makeRepo("unborn", { commit: false });
    const result = classifyCheckout(path);
    expect(result.state).toBe("no-commits");
    expect(result.usable).toBe(true);
    expect(git(path, ["rev-parse", "--absolute-git-dir"]).code).toBe(0);
    expect(git(path, ["rev-parse", "HEAD"]).code).not.toBe(0);
  });

  test("a live linked worktree is usable, and git agrees", () => {
    const parent = makeRepo("wt-parent");
    const wt = join(root, "wt-live");
    expect(git(parent, ["worktree", "add", "-q", wt, "-b", "feature"]).code).toBe(0);
    const result = classifyCheckout(wt);
    expect(result.state).toBe("usable");
    expect(result.common_dir).toBe(join(parent, ".git"));
    expect(git(wt, ["rev-parse", "--absolute-git-dir"]).code).toBe(0);
  });

  test("a hollow .git holding only hooks/ and worktrees/ is refused, and git refuses it too", () => {
    // The exact reported failure mode: 65 registry rows look like this, and
    // `existsSync(path + "/.git")` — which is what the scanner used — accepts
    // every one of them as a repository.
    const path = makeRepo("hollow");
    gutGitDir(path);
    const result = classifyCheckout(path);
    expect(result.state).toBe("hollow-git-dir");
    expect(result.usable).toBe(false);
    expect(result.detail).toContain("HEAD");
    expect(git(path, ["rev-parse", "--absolute-git-dir"]).code).not.toBe(0);
  });

  test("a worktree whose gitdir target is gone is refused, and git refuses it too", () => {
    const parent = makeRepo("wt-parent-deleted");
    const wt = join(root, "wt-dangling");
    expect(git(parent, ["worktree", "add", "-q", wt, "-b", "dangling"]).code).toBe(0);
    rmSync(join(parent, ".git"), { recursive: true, force: true });
    const result = classifyCheckout(wt);
    expect(result.state).toBe("worktree-dangling-gitdir");
    expect(result.usable).toBe(false);
    expect(git(wt, ["rev-parse", "--absolute-git-dir"]).code).not.toBe(0);
  });

  test("a worktree whose parent object store was gutted is refused, and git refuses it too", () => {
    // 394 rows are in exactly this shape: the per-worktree gitdir survives with
    // its hooks/ directory, and the common dir it points at has been stripped.
    const parent = makeRepo("wt-parent-gutted");
    const wt = join(root, "wt-severed");
    expect(git(parent, ["worktree", "add", "-q", wt, "-b", "severed"]).code).toBe(0);
    for (const entry of ["HEAD", "objects", "refs", "packed-refs", "config", "index", "logs", "info", "description"]) {
      rmSync(join(parent, ".git", entry), { recursive: true, force: true });
    }
    const result = classifyCheckout(wt);
    expect(result.state).toBe("worktree-severed-common-dir");
    expect(result.usable).toBe(false);
    expect(git(wt, ["rev-parse", "--absolute-git-dir"]).code).not.toBe(0);
  });

  test("a directory with no .git at all is refused", () => {
    const path = join(root, "plain-dir");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "README.md"), "not a repo\n");
    const result = classifyCheckout(path);
    expect(result.state).toBe("no-git-dir");
    expect(git(path, ["rev-parse", "--absolute-git-dir"]).code).not.toBe(0);
  });

  test("an absent path is refused", () => {
    const result = classifyCheckout(join(root, "does-not-exist"));
    expect(result.state).toBe("missing-path");
    expect(result.usable).toBe(false);
  });

  test("a bare repository is usable", () => {
    const path = join(root, "bare.git");
    mkdirSync(path, { recursive: true });
    expect(git(path, ["init", "-q", "--bare", "-b", "main", "."]).code).toBe(0);
    // An empty bare repo has no refs yet; make one so it is a populated repo.
    const seed = makeRepo("bare-seed");
    expect(git(seed, ["push", "-q", path, "main"]).code).toBe(0);
    expect(classifyCheckout(path).state).toBe("usable");
  });

  test("a .git file with no gitdir pointer is refused as corrupt, not as absent", () => {
    const path = join(root, "corrupt-pointer");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), "this is not a pointer\n");
    expect(classifyCheckout(path).state).toBe("worktree-unparseable-pointer");
  });
});

describe("classifyCheckout never guesses", () => {
  function throwingFs(failOn: (path: string) => boolean, base: CheckoutFs = nodeCheckoutFs): CheckoutFs {
    return {
      exists: (path) => { if (failOn(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return base.exists(path); },
      isDirectory: (path) => { if (failOn(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return base.isDirectory(path); },
      readText: (path) => { if (failOn(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return base.readText(path); },
      readDir: (path) => { if (failOn(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return base.readDir(path); },
    };
  }

  test("an unreadable path is 'unreadable', never 'missing' or 'hollow'", () => {
    // Reporting an inaccessible checkout as gutted would invite someone to
    // re-clone over a working tree that was merely unmounted.
    const result = classifyCheckout("/somewhere", throwingFs(() => true));
    expect(result.state).toBe("unreadable");
    expect(result.usable).toBe(false);
    expect(describeCheckoutRemedy(result)).toContain("Do NOT re-clone");
  });

  test("an unreadable .git directory is 'unreadable', not 'hollow-git-dir'", () => {
    const path = makeRepo("unreadable-git");
    const dotGit = join(path, ".git");
    const result = classifyCheckout(path, throwingFs((p) => p === join(dotGit, "HEAD")));
    expect(result.state).toBe("unreadable");
  });

  test("unreadable ref storage does not get reported as an empty repository", () => {
    // `hasAnyRef` swallows its own read error and answers "yes". That is the
    // deliberate direction: an unreadable refs/heads must not downgrade a
    // populated repository to "no commits", because a caller would then be told
    // `git worktree add` will refuse when it would in fact succeed.
    const path = makeRepo("unreadable-refs");
    const headsDir = join(path, ".git", "refs", "heads");
    let readDirCalls = 0;
    const fs: CheckoutFs = {
      exists: (p) => nodeCheckoutFs.exists(p),
      isDirectory: (p) => nodeCheckoutFs.isDirectory(p),
      readText: (p) => nodeCheckoutFs.readText(p),
      readDir: (p) => {
        if (p === headsDir) { readDirCalls++; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }
        return nodeCheckoutFs.readDir(p);
      },
    };
    // packed-refs short-circuits before refs/heads is read, so remove it to force
    // the directory listing this test is about.
    rmSync(join(path, ".git", "packed-refs"), { force: true });
    const result = classifyCheckout(path, fs);
    expect(readDirCalls).toBe(1);
    expect(result.state).toBe("usable");
  });
});

describe("describeCheckoutRemedy", () => {
  test("names the exact clone command when the row knows its remote", () => {
    // A refusal that only says "unusable" moves the dead end from the path into
    // the message.
    const result = classifyCheckout(join(root, "nope"));
    const remedy = describeCheckoutRemedy(result, { remoteUrl: "github.com/hasna/repos" });
    expect(remedy).toContain("git clone https://github.com/hasna/repos");
  });

  test("says so plainly when there is no remote to clone from", () => {
    const result = classifyCheckout(join(root, "nope"));
    expect(describeCheckoutRemedy(result, { remoteUrl: null })).toContain("no remote");
  });

  test("does not tell a caller to re-clone a severed worktree over the top of it", () => {
    // A severed worktree may hold the only copy of unpushed work. Cloning over
    // it would destroy exactly what is worth saving.
    const parent = makeRepo("remedy-parent");
    const wt = join(root, "remedy-wt");
    expect(git(parent, ["worktree", "add", "-q", wt, "-b", "r"]).code).toBe(0);
    rmSync(join(parent, ".git"), { recursive: true, force: true });
    const remedy = describeCheckoutRemedy(classifyCheckout(wt), { remoteUrl: "github.com/hasna/repos" });
    expect(remedy).not.toContain("git clone");
    expect(remedy).toContain("unpushed");
  });

  test("a usable checkout has no remedy text", () => {
    expect(describeCheckoutRemedy(classifyCheckout(makeRepo("remedy-ok")))).toBe("");
  });
});

describe("summarizeCheckoutStates", () => {
  test("counts each state", () => {
    const states: CheckoutState[] = ["usable", "usable", "hollow-git-dir", "missing-path", "usable"];
    expect(summarizeCheckoutStates(states)).toEqual({ usable: 3, "hollow-git-dir": 1, "missing-path": 1 });
  });
});
