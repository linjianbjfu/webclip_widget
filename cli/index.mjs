#!/usr/bin/env node
/**
 * webclip CLI — drive the server without the iOS app.
 *
 * Configuration comes from the environment so a token never lands in shell
 * history: WEBCLIP_URL, WEBCLIP_TOKEN, WEBCLIP_USER.
 *
 *   webclip sessions                    list
 *   webclip new [title]                 create
 *   webclip prompt <session> <text> [--file PATH]... [--gzip]
 *                                       run a turn, optionally uploading the
 *                                       captured page and screenshot
 *   webclip events <session> [since]    replay and follow
 *   webclip abort <session>
 *   webclip rm <session>
 *   webclip chat [session]              conversational REPL; creates a
 *                                       session when none is given. Inside,
 *                                       /help lists the slash commands.
 *   webclip check                       run the end-to-end suite
 */

import { createInterface } from "node:readline/promises";

import { Client, cursors } from "./client.mjs";
import { runChecks } from "./checks.mjs";
import { followRenderer, render } from "./render.mjs";

function config() {
  const baseUrl = process.env.WEBCLIP_URL;
  const token = process.env.WEBCLIP_TOKEN;
  if (!baseUrl || !token) {
    console.error("WEBCLIP_URL and WEBCLIP_TOKEN must be set.");
    process.exit(2);
  }
  return { baseUrl, token, userId: process.env.WEBCLIP_USER ?? "cli" };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    process.exit(await runChecks(config()));
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
      const [sessionId, ...rest] = args;
      const files = [];
      let gzip = false;
      const words = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--file") files.push(rest[++i]);
        else if (rest[i] === "--gzip") gzip = true;
        else words.push(rest[i]);
      }
      if (!sessionId || words.length === 0) {
        // Without this the session id absorbs the message and the server
        // answers 404 for a session nobody meant to name.
        console.error('usage: webclip prompt <session> "<message>" [--file PATH]... [--gzip]');
        console.error("  a session id comes from `webclip new`; `webclip chat` makes one for you");
        process.exit(2);
      }
      const result = await client.prompt({
        sessionId,
        text: words.join(" "),
        files,
        gzip,
        onFrame: render,
      });
      if (result.status !== 200) {
        console.error(`\n${result.status}`, JSON.stringify(result.body));
        process.exit(1);
      }
      return;
    }
    case "events": {
      const [sessionId, since] = args;
      await client.events(sessionId, Number(since ?? 0), { onFrame: followRenderer() });
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
      console.error("usage: webclip <sessions|new|prompt|chat|events|abort|rm|check>");
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
    const result = await client.prompt({
      sessionId: state.sessionId,
      text,
      files,
      gzip: state.gzip,
      since: state.since,
      onFrame: frame => {
        if (frame.id !== undefined) state.since = Number(frame.id);
        render(frame);
      },
    });
    if (result.status !== 200) console.error(`${result.status}`, JSON.stringify(result.body));
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

await main();
