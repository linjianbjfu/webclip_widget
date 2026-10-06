/**
 * HTTP surface of the Durable Object.
 *
 * Kept free of pi so it can be exercised in the Workers test pool: importing
 * pi's package root pulls in an extension loader that needs `node:process`,
 * which the pool resolves and the pool cannot run. Turn execution is injected
 * as a callback instead.
 */

import { Hub } from "./hub.ts";
import { encodeFrame, kindToEvent, streamEndFrame, type Frame } from "./sse.ts";
import type { EventRow, Store } from "./store.ts";
import { isValidTurnId, type PromptRequest } from "../protocol.ts";
import { CaptureError } from "../capture.ts";
import { isMultipart, parseMultipartPrompt, type ParsedPrompt } from "./upload.ts";
import type { WorkspaceFs } from "../fs/workspace-fs.ts";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

/** Starts a turn. Never awaited by the caller: the response must return first. */
export type StartTurn = (input: {
  sessionId: string;
  turnId: string;
  text: string;
}) => Promise<void>;

export interface HandlerDeps {
  store: Store;
  hub: Hub;
  workspace: (sessionId: string) => WorkspaceFs;
  startTurn: StartTurn;
  newSessionId: () => string;
  scheduleKeepalive: () => void;
}

function rowToFrame(row: EventRow): Frame {
  return { event: kindToEvent(row.kind), data: JSON.parse(row.payload) as unknown, seq: row.seq };
}

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // v1, sessions, [id], [action]
  if (parts[0] !== "v1" || parts[1] !== "sessions") return Response.json({ error: "not_found" }, { status: 404 });

  const sessionId = parts[2];
  const action = parts[3];

  if (sessionId === undefined) {
    if (request.method === "POST") return createSession(request, deps);
    if (request.method === "GET") return Response.json({ sessions: deps.store.listSessions() });
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  if (!deps.store.session(sessionId)) return Response.json({ error: "not_found" }, { status: 404 });

  if (action === undefined && request.method === "DELETE") {
    deps.store.deleteSession(sessionId);
    return new Response(null, { status: 204 });
  }
  if (action === "events" && request.method === "GET") return events(url, sessionId, deps);
  if (action === "prompt" && request.method === "POST") return prompt(request, sessionId, deps);
  if (action === "abort" && request.method === "POST") return abort(sessionId, deps);
  return Response.json({ error: "not_found" }, { status: 404 });
}

async function createSession(request: Request, deps: HandlerDeps): Promise<Response> {
  const body = await request.json<{ title?: string }>().catch(() => ({}) as { title?: string });
  const id = deps.newSessionId();
  deps.store.createSession(id, body.title);
  // Establish the workspace so `/out` exists before the first turn writes.
  deps.workspace(id).mkdir("/out", { recursive: true });
  return Response.json({ sessionId: id }, { status: 201 });
}

/**
 * Backlog and registration happen in one synchronous block.
 *
 * Reading first and registering after would miss anything broadcast in
 * between; registering first would let a live frame arrive before the older
 * records. `sql.exec()` returns synchronously, so with no `await` between the
 * two steps no broadcast can interleave and the ordering is fixed here.
 */
function events(url: URL, sessionId: string, deps: HandlerDeps): Response {
  const since = Number(url.searchParams.get("since") ?? "0");
  const backlog = deps.store.eventsSince(sessionId, Number.isFinite(since) ? since : 0).map(rowToFrame);
  const running = deps.store.runningTurn(sessionId);

  if (!running) {
    // Nothing to follow: emit the backlog and close, so the caller never
    // becomes a subscriber and never holds the object in memory.
    return new Response(deps.hub.finite(backlog, streamEndFrame(false)), { headers: SSE_HEADERS });
  }
  return new Response(deps.hub.subscribe(sessionId, backlog), { headers: SSE_HEADERS });
}

async function prompt(request: Request, sessionId: string, deps: HandlerDeps): Promise<Response> {
  let turnId = "", text = "", since = 0;
  let parsed: ParsedPrompt | undefined;
  if (isMultipart(request)) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({error:'invalid_multipart'}, {status:400});
    turnId = String(form.get('turnId') ?? '');
    if (!isValidTurnId(turnId)) return Response.json({error:'invalid_turn_id'}, {status:400});
    text = String(form.get('text') ?? '').trim(); since = Number(form.get('since') ?? 0) || 0;
    if (!deps.store.turn(sessionId, turnId)) {
      try { parsed = await parseMultipartPrompt(form); text = parsed.text.trim(); since = parsed.since; }
      catch (error) { return Response.json({error:'invalid_capture',message:String(error)}, {status:error instanceof CaptureError ? error.status : 400}); }
    }
  } else {
    const body = await request.json<PromptRequest>().catch(() => null);
    if (!body || !isValidTurnId(body.turnId)) return Response.json({error:'invalid_turn_id'}, {status:400});
    turnId = body.turnId; text = body.text?.trim() ?? ''; since = Number.isFinite(body.since) ? Number(body.since) : 0;
  }
  if (!deps.store.session(sessionId)) return Response.json({error:"not_found"}, {status:404});
  if (text.length > 32_000) return Response.json({error:'prompt_too_large'}, {status:413});

  const body = { turnId, text, since } satisfies PromptRequest;
  const existing = deps.store.turn(sessionId, body.turnId);
  if (!existing && text.length === 0) {
    return Response.json({ error: "empty_prompt" }, { status: 400 });
  }

  const running = deps.store.runningTurn(sessionId);
  if (running && running.turn_id !== body.turnId) {
    // v1 does not splice a prompt into a turn already under way; the client
    // queues locally and submits after `stream_end`.
    return Response.json(
      { error: "turn_in_progress", runningTurnId: running.turn_id },
      { status: 409 },
    );
  }

  const backlog = deps.store.eventsSince(sessionId, since).map(rowToFrame);

  if (existing && existing.status !== "running") {
    // A retry of a finished turn: replay what followed the cursor, then close.
    return new Response(deps.hub.finite(backlog, streamEndFrame(false)), { headers: SSE_HEADERS });
  }

  const stream = deps.hub.subscribe(sessionId, backlog);
  if (!existing) {
    deps.store.acceptTurn(sessionId, body.turnId, text, parsed?.files ?? [], parsed?.capture ?? null);
    deps.scheduleKeepalive();
    // Not awaited: awaiting would hold the response until the whole turn
    // finished, and there would be no streaming. The turn's survival rests on
    // the keepalive alarm, not on this request.
    void deps.startTurn({ sessionId, turnId: body.turnId, text });
  }
  return new Response(stream, { headers: SSE_HEADERS });
}

function abort(sessionId: string, deps: HandlerDeps): Response {
  const running = deps.store.runningTurn(sessionId);
  if (!running) return Response.json({ error: "no_running_turn" }, { status: 409 });
  deps.store.endTurn(sessionId, running.turn_id, "aborted");
  const frames = deps.store.append(sessionId, [
    {
      turnId: running.turn_id,
      kind: "turn_end",
      payload: { turnId: running.turn_id, reason: "aborted", out: [] },
    },
  ]);
  for (const row of frames) deps.hub.broadcast(sessionId, rowToFrame(row));
  deps.hub.closeAll(sessionId, streamEndFrame(false));
  return Response.json({ aborted: running.turn_id });
}

export { encodeFrame, SSE_HEADERS };
