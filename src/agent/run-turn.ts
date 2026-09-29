/**
 * Running one turn.
 *
 * The loop is driven here rather than inside the Durable Object so the
 * object's HTTP surface stays free of pi — importing pi's package root pulls
 * in an extension loader needing `node:process`, which the Workers test pool
 * cannot run even though wrangler's bundler prunes it.
 *
 * Every completed unit is persisted as it happens. A Durable Object is
 * terminated without warning, so waiting until the end of the turn to commit
 * would lose work the user already saw; and the artefacts a client receives
 * must survive an interruption the keepalive alarm failed to prevent.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { createModelRuntime, resolveProvider } from "./model.ts";
import { openSession } from "./session-factory.ts";
import type { Env } from "../do/user-agent-do.ts";
import type { Hub } from "../do/hub.ts";
import { kindToEvent, streamEndFrame, type Frame } from "../do/sse.ts";
import type { AppendInput, EventRow, Store } from "../do/store.ts";
import type { WorkspaceFs } from "../fs/workspace-fs.ts";
import { OUT_DIR } from "../shell/bash.ts";
import { sha256Hex, type OutFile } from "../protocol.ts";

/** Events after which the in-memory entry log is drained to SQLite. */
const PERSIST_AFTER = new Set<AgentSessionEvent["type"]>([
  "message_end",
  "turn_end",
  "tool_execution_end",
  "compaction_end",
  "agent_end",
]);

export interface RunTurnInput {
  env: Env;
  store: Store;
  hub: Hub;
  fs: WorkspaceFs;
  sessionId: string;
  turnId: string;
}

function rowToFrame(row: EventRow): Frame {
  return { event: kindToEvent(row.kind), data: JSON.parse(row.payload) as unknown, seq: row.seq };
}

export async function runTurn(input: RunTurnInput): Promise<void> {
  const { env, store, hub, fs, sessionId, turnId } = input;
  const turn = store.turn(sessionId, turnId);
  if (!turn || turn.status !== "running") return;

  const publish = (inputs: readonly AppendInput[]): void => {
    if (inputs.length === 0) return;
    for (const row of store.append(sessionId, inputs)) hub.broadcast(sessionId, rowToFrame(row));
    store.markProgress(sessionId, turnId);
  };

  try {
    const config = resolveProvider(env);
    const modelRuntime = await createModelRuntime(config);
    const session = store.session(sessionId);
    const opened = await openSession({
      modelRuntime,
      providerId: config.id,
      modelId: session?.model ?? config.defaultModel,
      fs,
      sessionId,
      history: store.piEntries(sessionId).map(row => row.entry),
    });

    let persisted = opened.persistedEntries;

    const drain = (): void => {
      const entries = opened.manager.getEntries();
      const pending: AppendInput[] = [];
      for (let i = persisted; i < entries.length; i++) {
        pending.push({ turnId, kind: "pi_entry", payload: entries[i] });
      }
      persisted = entries.length;
      publish(pending);
    };

    const unsubscribe = opened.session.subscribe((event: AgentSessionEvent) => {
      // `message_update` carries the incremental text and thinking as they
      // arrive. It reaches connected clients only: the same content lands in
      // the entry written at `message_end`, and persisting the increments
      // would cost an order of magnitude more writes for no durable fact.
      // Thinking itself does get stored — it is a part of that entry, with
      // its signature, which is what keeps multi-turn continuation working.
      if (event.type === "message_update") {
        hub.broadcast(sessionId, {
          event: "stream",
          data: { events: [event.assistantMessageEvent] },
        });
        return;
      }
      if (event.type === "tool_execution_start") {
        hub.broadcast(sessionId, {
          event: "tool_start",
          data: { toolCallId: event.toolCallId, name: event.toolName, args: event.args },
        });
      }
      if (event.type === "tool_execution_end") {
        hub.broadcast(sessionId, {
          event: "tool_end",
          data: { toolCallId: event.toolCallId, name: event.toolName, isError: event.isError },
        });
      }
      if (PERSIST_AFTER.has(event.type)) drain();
    });

    try {
      await opened.session.prompt(turn.prompt);
      drain();
    } finally {
      unsubscribe();
    }

    const out = await collectOut(fs);
    store.endTurn(sessionId, turnId, "completed");
    publish([{ turnId, kind: "turn_end", payload: { turnId, reason: "completed", out: stripContent(out) } }]);
    // The live terminator carries content; the stored record does not, so a
    // replay reads the current bytes from the workspace instead.
    hub.broadcast(sessionId, { event: "turn_end", data: { turnId, reason: "completed", out } });
    hub.closeAll(sessionId, streamEndFrame(false));
  } catch (error) {
    store.endTurn(sessionId, turnId, "failed");
    publish([
      {
        turnId,
        kind: "error",
        payload: {
          turnId,
          code: "llm_failed",
          message: String(error).slice(0, 500),
          retryable: true,
        },
      },
      { turnId, kind: "turn_end", payload: { turnId, reason: "failed", out: [] } },
    ]);
    hub.closeAll(sessionId, streamEndFrame(false));
  }
}

/** Every file under the out directory, with its bytes inlined. */
export async function collectOut(fs: WorkspaceFs): Promise<OutFile[]> {
  if (!(await fs.exists(OUT_DIR))) return [];
  const files: OutFile[] = [];
  for (const entry of await fs.readdirWithFileTypes(OUT_DIR)) {
    if (!entry.isFile) continue;
    const path = `${OUT_DIR}/${entry.name}`;
    const bytes = await fs.readFileBuffer(path);
    files.push({
      path: path.slice(1),
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      content: new TextDecoder().decode(bytes),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function stripContent(files: readonly OutFile[]): OutFile[] {
  return files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}
