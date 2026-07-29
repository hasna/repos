import { sanitizeRemoteOutput } from "../lib/remote-identity.js";

export function apiJsonResponse(
  data: unknown,
  status = 200,
  options: { cors?: boolean } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.cors !== false) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return new Response(JSON.stringify(sanitizeRemoteOutput(data)), {
    status,
    headers,
  });
}
