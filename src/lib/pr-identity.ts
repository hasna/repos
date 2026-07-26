/**
 * A pull request's GitHub identity.
 *
 * The same GitHub repository is routinely checked out many times on one
 * machine — worktrees, throwaway build copies, `open-*` mirrors — and each
 * checkout becomes its own `repos` row. Every one of those rows can carry its
 * own copy of the same pull request, so `repo_id` is NOT the owner of a PR and
 * the local directory name is NOT the GitHub repository name.
 *
 * The PR's own HTML URL is the only field that names the real owner, so it is
 * what identity, de-duplication and `--org` filtering are derived from.
 */
export interface PullRequestIdentity {
  owner: string;
  repo: string;
  number: number;
}

const PR_URL = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** Parse `https://github.com/<owner>/<repo>/pull/<n>`; null when unparseable. */
export function parsePullRequestUrl(url: unknown): PullRequestIdentity | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const match = PR_URL.exec(url.trim());
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/i, ""), number };
}

/**
 * Owner/name of a normalized `host/owner/name` remote identity, as produced by
 * `sanitizeRemoteIdentity`. Returns null for anything else.
 */
export function parseRemoteIdentity(remoteUrl: unknown): { owner: string; repo: string } | null {
  if (typeof remoteUrl !== "string") return null;
  const parts = remoteUrl.split("/");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { owner: parts[1], repo: parts[2] };
}

/**
 * Resolve the org/repo a stored PR row belongs to.
 *
 * The URL wins whenever it is parseable: a PR row can be attached to a repo
 * record whose remote points somewhere else entirely (a mis-attributed sync),
 * and in that case the repo record's org is simply wrong. The owning repo
 * record is only a fallback for rows with no usable URL.
 */
export function resolvePullRequestOrigin(
  url: unknown,
  fallbackRemoteUrl: unknown,
  fallbackOrg: unknown,
): { org: string | null; repo: string | null } {
  const fromUrl = parsePullRequestUrl(url);
  if (fromUrl) return { org: fromUrl.owner, repo: fromUrl.repo };

  const fromRemote = parseRemoteIdentity(fallbackRemoteUrl);
  if (fromRemote) return { org: fromRemote.owner, repo: fromRemote.repo };

  return { org: typeof fallbackOrg === "string" && fallbackOrg ? fallbackOrg : null, repo: null };
}
