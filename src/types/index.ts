// ── Core entity types for open-git ──

export interface Repo {
  id: number;
  path: string;
  name: string;
  org: string | null;
  remote_url: string | null;
  default_branch: string;
  description: string | null;
  last_scanned: string | null;
  commit_count: number;
  branch_count: number;
  tag_count: number;
  created_at: string;
  updated_at: string;
}

export interface Commit {
  id: number;
  repo_id: number;
  sha: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface Branch {
  id: number;
  repo_id: number;
  name: string;
  is_remote: boolean;
  last_commit_sha: string | null;
  last_commit_date: string | null;
  ahead: number;
  behind: number;
}

export interface Tag {
  id: number;
  repo_id: number;
  name: string;
  sha: string;
  date: string | null;
  message: string | null;
}

export interface Remote {
  id: number;
  repo_id: number;
  name: string;
  url: string;
  fetch_url: string | null;
}

export interface PullRequest {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string;
  created_at: string;
  updated_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  url: string;
  base_branch: string | null;
  head_branch: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  /** Tip commit of the head ref, for `gh pr merge --match-head-commit`. */
  head_sha: string | null;
  /** GitHub `mergeable`: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string | null;
  /** GitHub `mergeStateStatus`: CLEAN | BLOCKED | DIRTY | UNSTABLE | BEHIND | DRAFT | HAS_HOOKS | UNKNOWN. */
  merge_state_status: string | null;
  /** Rolled-up status check state: SUCCESS | FAILURE | PENDING | ERROR | EXPECTED. */
  ci_state: string | null;
  is_draft: boolean;
  /** GitHub `reviewDecision`: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED. */
  review_decision: string | null;
}

/**
 * A pull request as returned by the listing surface: the stored row plus the
 * GitHub identity (`org`/`repo`) resolved from the PR's own URL, which is the
 * only trustworthy owner of that PR when a repository is checked out more than
 * once locally.
 */
export interface PullRequestRecord extends PullRequest {
  org: string | null;
  repo: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  session_id: string | null;
  capabilities: string[];
  working_dir: string | null;
  focus_project_id: string | null;
  last_seen: string;
  created_at: string;
}

export interface ScanResult {
  repos_found: number;
  repos_new: number;
  repos_updated: number;
  commits_indexed: number;
  branches_indexed: number;
  tags_indexed: number;
  duration_ms: number;
}

export interface SearchResult {
  type: "repo" | "commit" | "branch" | "tag" | "pr";
  repo_name: string;
  repo_path: string;
  title: string;
  snippet: string;
  date: string | null;
  score: number;
}

export interface RepoStats {
  total_repos: number;
  total_commits: number;
  total_branches: number;
  total_tags: number;
  total_prs: number;
  repos_by_org: Record<string, number>;
  most_active_repos: Array<{ name: string; commits: number }>;
  stale_repos: Array<{ name: string; last_commit: string }>;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  cursor?: string;
}
