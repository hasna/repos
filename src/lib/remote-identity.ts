const SUPPORTED_SCHEMES = new Set(["http:", "https:", "ssh:", "git:"]);
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

function safeHost(value: string): string | null {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes("@") || host.includes(":")) return null;
  const labels = host.split(".");
  return labels.every((label) => HOST_LABEL.test(label)) ? host : null;
}

function safePath(value: string): [string, string] | null {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (CONTROL_OR_SPACE.test(decoded) || decoded.includes("\\")) return null;
  const parts = decoded.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo) || repo === "." || repo === "..") return null;
  return [owner, repo];
}

function withoutQueryOrFragment(value: string): string {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const end = Math.min(query < 0 ? value.length : query, fragment < 0 ? value.length : fragment);
  return value.slice(0, end);
}

/**
 * Normalize a supported Git remote into a credential-free host/owner/repository
 * identity. Invalid input returns null and is never interpolated into an error.
 */
export function sanitizeRemoteIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_OR_SPACE.test(value)) return null;
  const input = value;
  if (!input || CONTROL_OR_SPACE.test(input) || input.includes("\\") || input.startsWith("/")) return null;

  let host: string | null = null;
  let path = "";
  const scheme = input.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1];

  if (scheme) {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return null;
    }
    if (!SUPPORTED_SCHEMES.has(parsed.protocol)) return null;
    host = safeHost(parsed.hostname);
    const rawWithoutSuffix = withoutQueryOrFragment(input);
    const authorityEnd = rawWithoutSuffix.indexOf("/", rawWithoutSuffix.indexOf("://") + 3);
    if (authorityEnd < 0) return null;
    const rawPath = rawWithoutSuffix.slice(authorityEnd + 1);
    // URL parsers normalize traversal before exposing pathname, so validate the
    // caller's path bytes rather than the normalized URL pathname.
    path = rawPath;
  } else {
    const bare = withoutQueryOrFragment(input);
    const slash = bare.indexOf("/");
    const authority = slash < 0 ? bare : bare.slice(0, slash);
    const normalizedWithPort = /^([^@:]+):(\d+)$/.exec(authority);
    if (normalizedWithPort && slash > 0) {
      const port = Number(normalizedWithPort[2]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
      host = safeHost(normalizedWithPort[1]!);
      path = bare.slice(slash + 1);
    } else {
      const scp = /^(?:[^@/:?#]+@)?([^/:?#]+):([^?#]+)$/.exec(bare);
      if (scp) {
        host = safeHost(scp[1]!);
        path = scp[2]!;
      } else {
        const parts = bare.split("/");
        if (parts.length !== 3) return null;
        host = safeHost(parts[0]!);
        path = `${parts[1]}/${parts[2]}`;
      }
    }
  }

  const identityPath = safePath(path);
  if (!host || !identityPath) return null;
  return `${host}/${identityPath[0]}/${identityPath[1]}`;
}

/** Compatibility name retained for the public relocation API. */
export function sanitizeGitRemoteUrl(value: unknown): string {
  return sanitizeRemoteIdentity(value) ?? "";
}

/** Final JSON-compatible output guard for repo and remote records. */
export function sanitizeRemoteOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRemoteOutput);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const input = value as Record<string, unknown>;
  const output = Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, sanitizeRemoteOutput(entry)]),
  );
  if (Object.prototype.hasOwnProperty.call(input, "remote_url")) {
    output["remote_url"] = sanitizeRemoteIdentity(input["remote_url"]);
  }
  if (Object.prototype.hasOwnProperty.call(input, "fetch_url")) {
    output["fetch_url"] = sanitizeRemoteIdentity(input["fetch_url"]);
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "url")
    && Object.prototype.hasOwnProperty.call(input, "fetch_url")
    && (
      Object.prototype.hasOwnProperty.call(input, "repo_id")
      || Object.prototype.hasOwnProperty.call(input, "name")
    )
  ) {
    output["url"] = sanitizeRemoteIdentity(input["url"]);
  }
  return output;
}
