import { sanitizeRemoteOutput } from "../lib/remote-identity.js";

export function apiJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(sanitizeRemoteOutput(data)), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
