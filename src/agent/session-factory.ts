/**
 * Building and restoring a pi session.
 *
 * Context is rebuilt from the event log's `pi_entry` records only. Those
 * records are pi's own `SessionEntry` values, stored verbatim, so a restored
 * session produces the same request the live one did — thinking blocks and
 * their signatures included, which is what keeps the upstream prompt cache
 * matching across a restart.
 *
 * The persisted form is a linear sequence while pi's session is a tree, so
 * `parentId` is relinked in order on the way back in. v1 has no branching,
 * which makes a linear relink exact; supporting forks would change this.
 */

import {
  type AgentSession,
  buildSessionContext,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type ModelRuntime,
  type SessionContext,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { withWorkspaceShellBrief } from "./bash-brief.ts";
import { createBriefProvider } from "./brief.ts";
import { createPreviewTool } from "./preview.ts";
import { createWorkspaceOperations } from "./operations.ts";
import { WORKSPACE_ROOT, OUT_DIR, createShell } from "../shell/bash.ts";
import type { WorkspaceFs } from "../fs/workspace-fs.ts";

export interface OpenSessionInput {
  modelRuntime: ModelRuntime;
  providerId: string;
  modelId: string;
  fs: WorkspaceFs;
  sessionId: string;
  /** Raw pi entries in seq order. Empty for a new session. */
  history: readonly unknown[];
  /** Browser Run binding. Without it `preview_widget` is not offered at all. */
  browser?: BrowserRun;
}

export interface OpenedSession {
  session: AgentSession;
  manager: SessionManager;
  /**
   * Entries already durable at open time.
   *
   * Opening a session makes pi write `model_change` and `thinking_level_change`
   * bootstrap entries into a fresh manager. A new session must persist them —
   * they are where the model and thinking level come back from — while a
   * restored one must skip them. A cursor fixed at zero duplicates them on
   * every restore; one fixed at the current length never stores them at all,
   * and the restored session silently falls back to defaults.
   */
  persistedEntries: number;
  briefed: boolean;
}

function relink(entries: readonly unknown[]): SessionContext | undefined {
  const seen = new Set<string>();
  const chain: SessionEntry[] = [];
  let previousId: string | null = null;
  for (const raw of entries) {
    const entry = raw as SessionEntry & { id: string; parentId: string | null };
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entry.parentId = previousId;
    previousId = entry.id;
    chain.push(entry);
  }
  // `buildSessionContext` truncates at the last compaction entry, so passing
  // the whole chain does not undo a compaction.
  return chain.length > 0 ? buildSessionContext(chain, previousId) : undefined;
}

export async function openSession(input: OpenSessionInput): Promise<OpenedSession> {
  const restored = relink(input.history);
  const manager = SessionManager.inMemory();
  const shell = createShell(input.fs);
  const operations = createWorkspaceOperations(input.fs, shell);
  const brief = createBriefProvider();

  const model = input.modelRuntime.getModel(input.providerId, input.modelId);
  if (!model) throw new Error(`model ${input.providerId}/${input.modelId} is not registered`);

  // The `*Operations` seam is reached through each tool's definition factory,
  // and those definitions are registered as `customTools`. A same-named custom
  // tool replaces the built-in, so pi keeps its own argument validation,
  // truncation and diffing while the IO is ours. Passing operations to
  // `createAgentSession` directly does nothing: the built-ins stay in place and
  // reach for the local filesystem and `child_process.spawn`.
  const customTools = [
    // Offered only when the binding exists: a tool the model can call but
    // that always fails is worse than one it never sees.
    ...(input.browser ? [createPreviewTool(input.browser, input.fs)] : []),
    withWorkspaceShellBrief(
      createBashToolDefinition(WORKSPACE_ROOT, { operations: operations.bash }),
    ),
    createReadToolDefinition(WORKSPACE_ROOT, { operations: operations.read }),
    createEditToolDefinition(WORKSPACE_ROOT, { operations: operations.edit }),
    createWriteToolDefinition(WORKSPACE_ROOT, { operations: operations.write }),
    createLsToolDefinition(WORKSPACE_ROOT, { operations: operations.ls }),
    createFindToolDefinition(WORKSPACE_ROOT, { operations: operations.find }),
  ];

  const { session } = await createAgentSession({
    cwd: WORKSPACE_ROOT,
    model,
    modelRuntime: input.modelRuntime,
    sessionManager: manager,
    // jiti cannot load TypeScript extensions under Workers.
    resourceLoader: new DefaultResourceLoader({ cwd: WORKSPACE_ROOT, agentDir: "/.agent", noExtensions: true }),
    systemPrompt: brief.system({
      sessionId: input.sessionId,
      workspaceRoot: WORKSPACE_ROOT,
      outDir: OUT_DIR,
    }),
    customTools,
  } as Parameters<typeof createAgentSession>[0]);

  // Restored messages are assigned after construction: `createAgentSession`
  // takes no context parameter, so passing one is silently ignored and every
  // turn starts blank — the model then cannot see anything said before it.
  if (restored) {
    (session as unknown as { agent: { state: { messages: unknown[] } } }).agent.state.messages = [
      ...restored.messages,
    ];
  }

  return {
    session,
    manager,
    persistedEntries: input.history.length > 0 ? manager.getEntries().length : 0,
    briefed: input.history.length > 0,
  };
}
