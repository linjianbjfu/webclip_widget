#!/usr/bin/env node
/**
 * webclip CLI — drive the server without the iOS app.
 *
 * Configuration comes from the environment so a token never lands in shell
 * history: WEBCLIP_URL, WEBCLIP_TOKEN, WEBCLIP_USER.
 *
 *   webclip preview --out DIR [--source PATH]
 *                                       extract data and open a local widget
 *   webclip sessions                    list
 *   webclip new [title]                 create
 *   webclip prompt <session> <text> [--file PATH]... [--url URL] [--select] [--gzip]
 *                                       run a turn, optionally uploading the
 *                                       captured page and screenshot
 *   webclip --api edgewidgets --url URL --prompt TEXT
 *                                       generate through the Edge Widgets API
 *   webclip events <session> [since]    replay and follow
 *   webclip timeline <session>          where a turn's time went
 *   webclip abort <session>
 *   webclip rm <session>
 *   webclip chat [session]              conversational REPL; creates a
 *                                       session when none is given. Inside,
 *                                       /help lists the slash commands.
 *   webclip check                       run the end-to-end suite
 */

import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";

import { saveCaptureDebug } from "./capture-debug.mjs";
import { artifactReceiver } from "./artifacts.mjs";
import { Client, cursors } from "./client.mjs";
import { loadCliEnv } from "./env.mjs";
import { runChecks } from "./checks.mjs";
import { followRenderer, render } from "./render.mjs";
import { formatTimeline, timeline } from "./timeline.mjs";

loadCliEnv();

/** The shape `new` hands back, so a message is never mistaken for a target. */
function isSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}

function config() {
  const baseUrl = process.env.WEBCLIP_URL;
  const token = process.env.WEBCLIP_TOKEN;
  if (!baseUrl || !token) {
    console.error("WEBCLIP_URL and WEBCLIP_TOKEN must be set.");
    process.exit(2);
  }
  return { baseUrl, token, userId: process.env.WEBCLIP_USER ?? "cli" };
}

function edgeWidgetsConfig() {
  const serviceUrl = process.env.SERVICE_URL;
  const apiKey = process.env.GEC_API_KEY;
  if (!serviceUrl || !apiKey) {
    console.error("SERVICE_URL and GEC_API_KEY must be set.");
    process.exit(2);
  }
  return { serviceUrl, apiKey };
}

function parsePromptArgs(args) {
  const files = [];
  const words = [];
  let api;
  let gzip = false;
  let promptText;
  let url;
  let select = false;
  let sessionId;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      continue;
    } else if (args[i] === "--api") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--api requires a value");
      api = args[++i];
    } else if (args[i] === "--prompt") {
      if (promptText !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
        throw new Error("--prompt requires one message");
      }
      promptText = args[++i];
    } else if (args[i] === "--select") { select = true; }
    else if (args[i] === "--url") { if(url || !args[i+1] || args[i+1].startsWith("--"))throw new Error("--url requires one HTTP/HTTPS URL"); url = args[++i]; }
    else if (args[i] === "--file") { if(!args[i+1] || args[i+1].startsWith("--"))throw new Error("--file requires a path"); files.push(args[++i]); }
    else if (args[i] === "--gzip") gzip = true;
    else if (args[i] === "--session") sessionId = args[++i];
    else if (sessionId === undefined && words.length === 0 && isSessionId(args[i])) {
      sessionId = args[i];
    } else words.push(args[i]);
  }
  if (promptText !== undefined && words.length > 0) {
    throw new Error("Use either --prompt or positional message text, not both");
  }
  return { api, files, gzip, promptText, select, sessionId, url, words };
}

async function runEdgeWidgetsPrompt(options) {
  if (options.sessionId !== undefined) throw new Error("--api edgewidgets does not accept a session");
  if (!options.url) throw new Error("--api edgewidgets requires --url");
  if (options.files.length > 0 || options.select || options.gzip) {
    throw new Error("--api edgewidgets does not accept --file, --select or --gzip");
  }
  const userQuery = options.promptText ?? options.words.join(" ");
  if (userQuery.length === 0) throw new Error("--api edgewidgets requires --prompt");
  const { capturePage } = await import("./capture-page.mjs");
  const { edgeWidgetOutputId, generateEdgeWidget, saveEdgeWidgetOutput } = await import("./edgewidgets.mjs");
  const apiConfig = edgeWidgetsConfig();
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let captured;
  try {
    captured = await capturePage({ url: options.url, select: true }, { signal: stop.signal });
    if (!captured) {
      console.log("Capture cancelled; nothing sent.");
      return;
    }
    const outputId = edgeWidgetOutputId();
    let generated;
    try {
      generated = await generateEdgeWidget({
        ...apiConfig,
        userQuery,
        url: captured.capture.pageUrl ?? options.url,
        pageTitle: captured.pageTitle,
        htmlContent: await readFile(captured.files[0], "utf8"),
      });
    } catch (error) {
      if (error?.callRecord) {
        try {
          const folder = await saveEdgeWidgetOutput({
            outputId,
            callRecord: error.callRecord,
            captured,
          });
          console.error(`Saved API call: ${folder}`);
        } catch (saveError) {
          throw new AggregateError(
            [error, saveError],
            `${error.message}; additionally failed to save API call: ${saveError.message}`,
          );
        }
      }
      throw error;
    }
    for (const warning of generated.warnings) console.error(`Warning: ${warning}`);
    const folder = await saveEdgeWidgetOutput({
      outputId,
      callRecord: generated.callRecord,
      captured,
      extractScript: generated.extractScript,
      meta: generated.meta,
      widgetHtml: generated.widgetHtml,
    });
    console.log(`Saved widget: ${folder}`);
  } finally {
    await captured?.dispose();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, ...args] = argv;
  if (command?.startsWith("--")) {
    const options = parsePromptArgs(argv);
    if (options.api !== "edgewidgets") {
      throw new Error(options.api === undefined ? "--api edgewidgets is required" : `Unknown API: ${options.api}`);
    }
    if (options.promptText === undefined) throw new Error("--api edgewidgets requires --prompt");
    await runEdgeWidgetsPrompt(options);
    return;
  }
  if (command === "preview") {
    const { runPreviewCommand } = await import("./local-preview.mjs");
    await runPreviewCommand(args);
    return;
  }
  if (command === "check") {
    process.exit(await runChecks(config()));
  }

  const promptOptions = command === "prompt" ? parsePromptArgs(args) : undefined;
  if (promptOptions?.api !== undefined) {
    if (promptOptions.api !== "edgewidgets") throw new Error(`Unknown prompt API: ${promptOptions.api}`);
    await runEdgeWidgetsPrompt(promptOptions);
    return;
  }

  const client = new Client({ ...config(), strict: false });

  switch (command) {
    case "sessions": {
      const { body } = await client.listSessions();
      for (const s of body.sessions ?? []) {
        console.log(`${s.id}  ${s.busy ? "busy" : "idle"}  ${s.title ?? "(untitled)"}`);
      }
      return;
    }
    case "new": {
      const { body } = await client.createSession(args[0]);
      console.log(body.sessionId);
      return;
    }
    case "prompt": {
      const { files, gzip, url, select, words } = promptOptions;
      let { sessionId } = promptOptions;
      if (words.length === 0) {
        console.error('usage: webclip prompt [session] "<message>" [--file PATH]... [--url URL] [--select] [--gzip]');
        console.error('       webclip --api edgewidgets --url URL --prompt "message"');
        process.exit(2);
      }
      const { captureSource, capturePage } = await import('./capture-page.mjs');
      const source = captureSource({url, files, select});
      let captured;
      if (source) {
        const stop = new AbortController(); const cancel = () => stop.abort();
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        try { captured = await capturePage({url, files, select}, {signal: stop.signal}); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
        if (!captured) { console.log('Capture cancelled; nothing sent.'); return; }
      }
      try {
      if (sessionId === undefined) {
        const { status, body } = await client.createSession(words.join(" ").slice(0, 60));
        if (status !== 201 || !body?.sessionId) throw new Error(`Create session failed: ${status}`);
        sessionId = body.sessionId;
        console.log(`session ${sessionId}`);
      }
      if (captured) {
        const folder = await saveCaptureDebug({ sessionId, captured });
        console.log(`Capture saved: ${folder}`);
      }
      const turnId = client.newTurnId();
      const artifacts = artifactReceiver({ sessionId, turnId });
      const result = await client.prompt({
        sessionId,
        turnId,
        text: words.join(" "),
        files: captured?.files ?? files,
        capture: captured?.capture,
        gzip,
        onFrame: async frame => {
          render(frame);
          await artifacts.onFrame(frame);
        },
      });
      if (result.status !== 200) {
        throw new Error(`Prompt failed: ${result.status} ${JSON.stringify(result.body)}`);
      }
      artifacts.finish();
      } finally { await captured?.dispose(); }
      return;
    }
    case "events": {
      const [sessionId, since] = args;
      const artifacts = artifactReceiver({ sessionId });
      const show = followRenderer();
      const result = await client.events(sessionId, Number(since ?? 0), {
        onFrame: async frame => {
          show(frame);
          await artifacts.onFrame(frame);
        },
      });
      if (result.status !== 200) throw new Error(`events returned ${result.status}`);
      return;
    }
    case "timeline": {
      const { status, frames } = await client.events(args[0], 0);
      if (status !== 200) {
        console.error(`${status}`);
        process.exit(1);
      }
      console.log(formatTimeline(timeline(frames)));
      return;
    }
    case "abort": {
      console.log(JSON.stringify((await client.abort(args[0])).body));
      return;
    }
    case "rm": {
      console.log((await client.deleteSession(args[0])).status);
      return;
    }
    case "chat": {
      await chat(client, args[0]);
      return;
    }
    default:
      console.error("usage: webclip <sessions|new|prompt|chat|events|timeline|abort|rm|check|preview>");
      process.exit(2);
  }
}

/**
 * Slash commands available inside `chat`.
 *
 * This table is the only list. `/help` renders from it, so a command cannot
 * exist undocumented or be documented without existing. Each `run` receives
 * the live session state and may replace any part of it.
 */
const COMMANDS = [
  {
    name: "help",
    summary: "list these commands",
    run: () => {
      const width = Math.max(...COMMANDS.map(c => usage(c).length));
      for (const c of COMMANDS) console.log(`  /${usage(c).padEnd(width)}  ${c.summary}`);
      console.log("\n  anything else is sent as a message; //text sends a literal leading slash");
    },
  },
  {
    name: "list",
    aliases: ["sessions", "ls"],
    summary: "every session, current one marked",
    run: async ({ state, client }) => {
      const { body } = await client.listSessions();
      const sessions = body.sessions ?? [];
      if (sessions.length === 0) return console.log("  (none)");
      for (const s of sessions) {
        const mark = s.id === state.sessionId ? "*" : " ";
        console.log(`${mark} ${s.id}  ${s.busy ? "busy" : "idle"}  ${s.title ?? "(untitled)"}`);
      }
    },
  },
  {
    name: "new",
    args: "[title]",
    summary: "create a session and move to it",
    run: async ({ args, state, client }) => {
      const { body } = await client.createSession(args.join(" ") || "chat");
      enter(state, body.sessionId);
    },
  },
  {
    name: "switch",
    args: "<session>",
    summary: "continue an existing session",
    run: ({ args, state }) => {
      if (!args[0]) return console.error("  /switch needs a session id — /list shows them");
      enter(state, args[0]);
    },
  },
  {
    name: "session",
    summary: "current session, cursor and staged files",
    run: ({ state }) => {
      console.log(`  session ${state.sessionId}`);
      console.log(`  cursor  ${state.since}`);
      console.log(`  files   ${state.files.length ? state.files.join(", ") : "(none)"}`);
      console.log(`  gzip    ${state.gzip ? "on" : "off"}`);
    },
  },
  {
    name: "history",
    args: "[since]",
    summary: "replay this session's log",
    run: async ({ args, state, client }) => {
      const from = Number(args[0] ?? 0) || 0;
      const { status, frames } = await client.events(state.sessionId, from, {
        onFrame: followRenderer(),
      });
      if (status !== 200) return console.error(`  ${status}`);
      const last = cursors(frames).at(-1);
      if (last !== undefined) state.since = last;
    },
  },
  {
    name: "file",
    args: "[path|clear]",
    summary: "stage a file for the next message",
    run: ({ args, state }) => {
      if (args.length === 0) return console.log(`  ${state.files.join(", ") || "(none staged)"}`);
      if (args[0] === "clear") {
        state.files = [];
        return console.log("  cleared");
      }
      state.files.push(...args);
      console.log(`  staged ${args.join(", ")}`);
    },
  },
  {
    name: "gzip",
    summary: "toggle gzip for staged uploads",
    run: ({ state }) => {
      state.gzip = !state.gzip;
      console.log(`  gzip ${state.gzip ? "on" : "off"}`);
    },
  },
  {
    name: "abort",
    summary: "stop the running turn",
    run: async ({ state, client }) => {
      console.log(`  ${JSON.stringify((await client.abort(state.sessionId)).body)}`);
    },
  },
  {
    name: "rm",
    args: "[session]",
    summary: "delete a session, current one by default",
    run: async ({ args, state, client }) => {
      const target = args[0] ?? state.sessionId;
      console.log(`  ${(await client.deleteSession(target)).status}`);
      if (target !== state.sessionId) return;
      // The REPL cannot keep pointing at a session that no longer exists:
      // every later message would fail. Open a fresh one instead.
      const { body } = await client.createSession("chat");
      enter(state, body.sessionId);
    },
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    summary: "leave",
    run: ({ state }) => {
      state.done = true;
    },
  },
];

function usage(command) {
  return command.args ? `${command.name} ${command.args}` : command.name;
}

/**
 * Point the REPL at a session.
 *
 * The cursor resets because a sequence number is only meaningful within the
 * log that issued it; carrying one across sessions would ask the server to
 * resume from a position in a different log.
 */
function enter(state, sessionId) {
  state.sessionId = sessionId;
  state.since = 0;
  console.log(`  session ${sessionId}`);
}

/** Complete slash commands; ordinary prose gets no suggestions. */
function completer(line) {
  if (!line.startsWith("/")) return [[], line];
  const names = COMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]).map(n => `/${n}`);
  const hits = names.filter(n => n.startsWith(line));
  return [hits.length > 0 ? hits : names, line];
}

/**
 * A conversational loop over one session.
 *
 * Each line is its own turn — the server has no notion of a partial message —
 * and every turn after the first sees the ones before it, because context is
 * rebuilt from the session's own event log rather than from anything this
 * client keeps. `since` carries the cursor forward so records produced while
 * the previous stream was closing still reach it.
 *
 * Piped input is read to the end before the first turn runs. Readline signals
 * `close` as soon as the stream is exhausted, which arrives before the later
 * lines have been asked for, so consuming a pipe one `question()` at a time
 * silently drops everything after the first message.
 */
async function chat(client, existing) {
  const state = { sessionId: existing, since: 0, files: [], gzip: false, done: false };
  if (!state.sessionId) {
    const { body } = await client.createSession("chat");
    state.sessionId = body.sessionId;
    console.log(`session ${state.sessionId}`);
  }

  const send = async text => {
    const files = state.files;
    state.files = []; // staged files belong to one message, not to the session
    const turnId = client.newTurnId();
    const artifacts = artifactReceiver({ sessionId: state.sessionId, turnId });
    const result = await client.prompt({
      sessionId: state.sessionId,
      turnId,
      text,
      files,
      gzip: state.gzip,
      since: state.since,
      onFrame: async frame => {
        render(frame);
        await artifacts.onFrame(frame);
        if (frame.id !== undefined) state.since = Number(frame.id);
      },
    });
    if (result.status !== 200) throw new Error(`${result.status} ${JSON.stringify(result.body)}`);
    artifacts.finish();
    console.log();
  };

  /** Dispatch one line: a command, an escaped literal, or a message. */
  const handle = async line => {
    if (line.startsWith("//")) return send(line.slice(1));
    if (!line.startsWith("/")) return send(line);
    const [word, ...args] = line.slice(1).split(/\s+/);
    const command = COMMANDS.find(c => c.name === word || c.aliases?.includes(word));
    if (!command) return console.error(`  unknown command /${word} — /help lists them`);
    await command.run({ args, state, client });
  };

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      const text = line.trim();
      if (text.length === 0) continue;
      if (!text.startsWith("/")) console.log(`> ${text}`);
      await handle(text);
      if (state.done) return;
    }
    return;
  }

  console.log("/help lists the commands. Ctrl-C also leaves.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, completer });
  try {
    while (!state.done) {
      let line;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        return; // stream closed under an interactive session
      }
      if (line.length > 0) await handle(line);
    }
  } finally {
    rl.close();
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
