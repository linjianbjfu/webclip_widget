/**
 * Worker-side routing.
 *
 * The Worker is stateless: it resolves the caller's identity and forwards to
 * that user's Durable Object. Session routing is by `idFromName(userId)`, so
 * every request for one user lands on one instance and can share the
 * subscriber hub and the live pi sessions held in its memory.
 *
 * Requests carry a shared secret and a caller-declared `userId`. The secret
 * decides whether the service answers at all; the id decides which Durable
 * Object answers. **The id is not verified**, so any holder of the token can
 * read or delete any user's sessions — the boundary between users is not a
 * security boundary yet. Replacing this with per-user identity is its own
 * piece of work and must happen before real users are involved.
 */

import { checkAuth } from "./auth.ts";
import type { Env } from "./do/user-agent-do.ts";

const USER_HEADER = "x-webclip-user";

export interface RouteError {
  error: string;
  [key: string]: unknown;
}

export function jsonError(status: number, body: RouteError): Response {
  return Response.json(body, { status });
}

function resolveUserId(request: Request): string | undefined {
  const raw = request.headers.get(USER_HEADER)?.trim();
  return raw && raw.length > 0 && raw.length <= 200 ? raw : undefined;
}

export async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const auth = checkAuth(request, env.AUTH_TOKEN);
  if (!auth.ok) return jsonError(auth.status, { error: auth.error });

  const userId = resolveUserId(request);
  if (!userId) return jsonError(400, { error: "missing_user", header: USER_HEADER });

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return jsonError(404, { error: "not_found" });

  const stub = env.AGENT.get(env.AGENT.idFromName(userId));
  return stub.fetch(request);
}
