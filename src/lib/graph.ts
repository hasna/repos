import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/database.js";
import { nonDerivedCheckoutSql } from "../db/repos.js";

export interface Edge {
  id: number;
  source_type: string;
  source_id: string;
  relation: string;
  target_type: string;
  target_id: string;
  weight: number;
  metadata: string | null;
}

export interface GraphNode {
  type: string;
  id: string;
  label: string;
  edges: Array<{ relation: string; target_type: string; target_id: string; weight: number }>;
}

export interface GraphPath {
  nodes: Array<{ type: string; id: string }>;
  edges: Array<{ relation: string }>;
  length: number;
}

// ── Edge CRUD ──

function upsertEdge(
  sourceType: string, sourceId: string, relation: string,
  targetType: string, targetId: string, weight = 1.0, metadata?: string
): void {
  const db = getDb();
  db.query(`INSERT OR REPLACE INTO edges (source_type, source_id, relation, target_type, target_id, weight, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sourceType, sourceId, relation, targetType, targetId, weight, metadata || null);
}

// ── Graph Builder ──

export function buildGraph(opts: { onProgress?: (msg: string) => void } = {}): {
  edges_created: number;
  duration_ms: number;
} {
  const start = Date.now();
  const db = getDb();
  let edges_created = 0;

  // Clear existing edges
  db.exec("DELETE FROM edges");

  const repos = db.query("SELECT * FROM repos").all() as any[];
  opts.onProgress?.(`Building graph for ${repos.length} repos...`);

  // 1. Repo → Org edges
  opts.onProgress?.("  Building repo→org edges...");
  for (const repo of repos) {
    if (repo.org) {
      upsertEdge("repo", String(repo.id), "owned_by", "org", repo.org);
      edges_created++;
    }
  }

  // 2. Author → Repo edges (aggregated commits)
  opts.onProgress?.("  Building author→repo edges...");
  const authorRepos = db.query(`
    SELECT author_email, repo_id, COUNT(*) as commit_count, r.name as repo_name
    FROM commits c JOIN repos r ON r.id = c.repo_id
    GROUP BY author_email, repo_id
  `).all() as any[];

  for (const ar of authorRepos) {
    upsertEdge("author", ar.author_email, "contributes_to", "repo", String(ar.repo_id), ar.commit_count,
      JSON.stringify({ repo_name: ar.repo_name }));
    edges_created++;
  }

  // 3. Author → Org edges (derived)
  opts.onProgress?.("  Building author→org edges...");
  const authorOrgs = db.query(`
    SELECT c.author_email, r.org, COUNT(*) as commit_count
    FROM commits c JOIN repos r ON r.id = c.repo_id
    WHERE r.org IS NOT NULL
    GROUP BY c.author_email, r.org
  `).all() as any[];

  for (const ao of authorOrgs) {
    upsertEdge("author", ao.author_email, "works_in", "org", ao.org, ao.commit_count);
    edges_created++;
  }

  // 4. Repo → Language edges (from file extensions in git)
  opts.onProgress?.("  Detecting languages...");
  for (const repo of repos) {
    try {
      const lang = detectLanguage(repo.path);
      if (lang) {
        upsertEdge("repo", String(repo.id), "uses_lang", "language", lang);
        edges_created++;
      }
    } catch { /* skip */ }
  }

  // 5. Repo → Repo dependency edges (from package.json)
  opts.onProgress?.("  Extracting dependencies...");
  for (const repo of repos) {
    try {
      const deps = extractDeps(repo.path);
      for (const dep of deps) {
        // Find if dep is a local repo. Excludes derived checkouts (todos
        // f3c7ecb6, same class as getRepo()'s c357a1f3 fix): a raw dependency
        // name is passed through unchanged, so a package literally depending
        // on e.g. "loops" would otherwise attribute the edge to a
        // `_factory_src/loops` scratch clone -- the exact bare name it is
        // indexed under -- while the canonical checkout ("open-loops") never
        // matches at all.
        const localRepo = db
          .query(`SELECT id FROM repos WHERE name = ? AND ${nonDerivedCheckoutSql("path")}`)
          .get(dep) as { id: number } | null;
        if (localRepo) {
          upsertEdge("repo", String(repo.id), "depends_on", "repo", String(localRepo.id));
          edges_created++;
        }
      }
    } catch { /* skip */ }
  }

  // 6. Similar repos (shared authors)
  opts.onProgress?.("  Finding similar repos...");
  const sharedAuthors = db.query(`
    SELECT c1.repo_id as repo1, c2.repo_id as repo2, COUNT(DISTINCT c1.author_email) as shared_authors
    FROM commits c1
    JOIN commits c2 ON c1.author_email = c2.author_email AND c1.repo_id < c2.repo_id
    GROUP BY c1.repo_id, c2.repo_id
    HAVING shared_authors >= 2
    LIMIT 500
  `).all() as any[];

  for (const sa of sharedAuthors) {
    upsertEdge("repo", String(sa.repo1), "similar_to", "repo", String(sa.repo2), sa.shared_authors);
    edges_created++;
  }

  opts.onProgress?.(`  Done: ${edges_created} edges created`);
  return { edges_created, duration_ms: Date.now() - start };
}

function detectLanguage(repoPath: string): string | null {
  const checks: Array<[string, string]> = [
    ["package.json", "TypeScript/JavaScript"],
    ["tsconfig.json", "TypeScript"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["requirements.txt", "Python"],
    ["pyproject.toml", "Python"],
    ["Gemfile", "Ruby"],
    ["pom.xml", "Java"],
    ["build.gradle", "Java"],
    ["*.swift", "Swift"],
    ["CMakeLists.txt", "C/C++"],
  ];

  for (const [file, lang] of checks) {
    if (existsSync(join(repoPath, file))) return lang;
  }
  return null;
}

function extractDeps(repoPath: string): string[] {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    return Object.keys(allDeps || {}).map((d) => {
      // @hasna/todos → open-todos, @hasna/repos → open-repos
      if (d.startsWith("@hasna/")) return `open-${d.replace("@hasna/", "")}`;
      return d;
    });
  } catch {
    return [];
  }
}

// ── Query ──

export function queryNode(type: string, id: string): GraphNode | null {
  const db = getDb();

  // Find outgoing edges
  const outgoing = db.query(
    "SELECT relation, target_type, target_id, weight FROM edges WHERE source_type = ? AND source_id = ?"
  ).all(type, id) as any[];

  // Find incoming edges
  const incoming = db.query(
    "SELECT relation, source_type as target_type, source_id as target_id, weight FROM edges WHERE target_type = ? AND target_id = ?"
  ).all(type, id) as any[];

  if (outgoing.length === 0 && incoming.length === 0) return null;

  // Build label
  let label = id;
  if (type === "repo") {
    const repo = db.query("SELECT name FROM repos WHERE id = ?").get(Number(id)) as any;
    if (repo) label = repo.name;
  }

  return {
    type,
    id,
    label,
    edges: [...outgoing, ...incoming.map((e: any) => ({ ...e, relation: `←${e.relation}` }))],
  };
}

export function queryRelated(repoIdOrName: string, limit = 10): Array<{
  repo_id: string;
  repo_name: string;
  relation: string;
  weight: number;
}> {
  const db = getDb();

  // Resolve repo ID. Excludes derived checkouts (todos f3c7ecb6, same class
  // as getRepo()'s c357a1f3 fix) so a bare name whose only exact match is a
  // `_factory_src` scratch clone falls through to the `else` below (treated
  // as an unresolved id) instead of silently attributing results to the
  // wrong repo.
  let repoId: string;
  const byName = db
    .query(`SELECT id FROM repos WHERE name = ? AND ${nonDerivedCheckoutSql("path")}`)
    .get(repoIdOrName) as any;
  if (byName) repoId = String(byName.id);
  else repoId = repoIdOrName;

  const results = db.query(`
    SELECT e.target_id as repo_id, r.name as repo_name, e.relation, e.weight
    FROM edges e
    JOIN repos r ON r.id = CAST(e.target_id AS INTEGER)
    WHERE e.source_type = 'repo' AND e.source_id = ? AND e.target_type = 'repo'
    UNION
    SELECT e.source_id as repo_id, r.name as repo_name, e.relation, e.weight
    FROM edges e
    JOIN repos r ON r.id = CAST(e.source_id AS INTEGER)
    WHERE e.target_type = 'repo' AND e.target_id = ? AND e.source_type = 'repo'
    ORDER BY weight DESC
    LIMIT ?
  `).all(repoId, repoId, limit) as any[];

  return results;
}

export function findPath(
  fromType: string, fromId: string,
  toType: string, toId: string,
  maxDepth = 5
): GraphPath | null {
  const db = getDb();

  // BFS
  const queue: Array<{ type: string; id: string; path: Array<{ type: string; id: string }>; relations: string[] }> = [
    { type: fromType, id: fromId, path: [{ type: fromType, id: fromId }], relations: [] },
  ];
  const visited = new Set<string>();
  visited.add(`${fromType}:${fromId}`);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length > maxDepth) continue;

    // Check if we reached target
    if (current.type === toType && current.id === toId) {
      return {
        nodes: current.path,
        edges: current.relations.map((r) => ({ relation: r })),
        length: current.path.length - 1,
      };
    }

    // Get neighbors (outgoing)
    const outgoing = db.query(
      "SELECT target_type, target_id, relation FROM edges WHERE source_type = ? AND source_id = ?"
    ).all(current.type, current.id) as any[];

    // Get neighbors (incoming)
    const incoming = db.query(
      "SELECT source_type as target_type, source_id as target_id, relation FROM edges WHERE target_type = ? AND target_id = ?"
    ).all(current.type, current.id) as any[];

    for (const neighbor of [...outgoing, ...incoming]) {
      const key = `${neighbor.target_type}:${neighbor.target_id}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({
          type: neighbor.target_type,
          id: neighbor.target_id,
          path: [...current.path, { type: neighbor.target_type, id: neighbor.target_id }],
          relations: [...current.relations, neighbor.relation],
        });
      }
    }
  }

  return null;
}

export function getDeps(repoIdOrName: string, depth = 3): Array<{
  repo_id: string;
  repo_name: string;
  depth: number;
}> {
  const db = getDb();
  let repoId: string;
  // Same derived-checkout exclusion as queryRelated() above (todos f3c7ecb6).
  const byName = db
    .query(`SELECT id FROM repos WHERE name = ? AND ${nonDerivedCheckoutSql("path")}`)
    .get(repoIdOrName) as any;
  if (byName) repoId = String(byName.id);
  else repoId = repoIdOrName;

  const result: Array<{ repo_id: string; repo_name: string; depth: number }> = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: repoId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth || visited.has(current.id)) continue;
    visited.add(current.id);

    const deps = db.query(`
      SELECT e.target_id as repo_id, r.name as repo_name
      FROM edges e
      JOIN repos r ON r.id = CAST(e.target_id AS INTEGER)
      WHERE e.source_type = 'repo' AND e.source_id = ? AND e.relation = 'depends_on' AND e.target_type = 'repo'
    `).all(current.id) as any[];

    for (const dep of deps) {
      if (!visited.has(dep.repo_id)) {
        result.push({ ...dep, depth: current.depth + 1 });
        queue.push({ id: dep.repo_id, depth: current.depth + 1 });
      }
    }
  }

  return result;
}

export function getCrossOrgAuthors(): Array<{
  author_email: string;
  orgs: string[];
  total_commits: number;
}> {
  const db = getDb();
  return db.query(`
    SELECT e.source_id as author_email, GROUP_CONCAT(DISTINCT e.target_id) as orgs, SUM(e.weight) as total_commits
    FROM edges e
    WHERE e.source_type = 'author' AND e.relation = 'works_in'
    GROUP BY e.source_id
    HAVING COUNT(DISTINCT e.target_id) > 1
    ORDER BY total_commits DESC
  `).all().map((r: any) => ({
    ...r,
    orgs: r.orgs.split(","),
  })) as any[];
}

export function getGraphStats(): {
  total_edges: number;
  by_relation: Record<string, number>;
  by_source_type: Record<string, number>;
} {
  const db = getDb();
  const total_edges = (db.query("SELECT COUNT(*) as c FROM edges").get() as any).c;

  const byRelation = db.query("SELECT relation, COUNT(*) as c FROM edges GROUP BY relation ORDER BY c DESC").all() as any[];
  const by_relation: Record<string, number> = {};
  for (const r of byRelation) by_relation[r.relation] = r.c;

  const byType = db.query("SELECT source_type, COUNT(*) as c FROM edges GROUP BY source_type ORDER BY c DESC").all() as any[];
  const by_source_type: Record<string, number> = {};
  for (const t of byType) by_source_type[t.source_type] = t.c;

  return { total_edges, by_relation, by_source_type };
}
