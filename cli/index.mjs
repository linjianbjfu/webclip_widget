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
 *                                       session when none is given
 *   webclip check                       run the end-to-end suite
 */

import { createInterface } from "node:readline/promises";

import { Client } from "./client.mjs";
import { runChecks } from "./checks.mjs";

function config() {
  const baseUrl = process.env.WEBCLIP_URL;
  const token = process.env.WEBCLIP_TOKEN;
  if (!baseUrl || !token) {
    console.error("WEBCLIP_URL and WEBCLIP_TOKEN must be set.");
    process.exit(2);
  }
  return { baseUrl, token, userId: process.env.WEBCLIP_USER ?? "cli" };
}

/** Render a frame for a human. The interactive driver is tolerant by design. */
function render(frame) {
  const seq = frame.id ? `#${frame.id} ` : "   ";
  switch (frame.event) {
    case "stream": {
      const events = frame.data?.events ?? [];
      const text = events.map(e => e.delta ?? e.text ?? "").join("");
      if (text) process.stdout.write(text);
      return;
    }
    case "tool_start":
      console.log(`\n${seq}→ ${frame.data.name} ${JSON.stringify(frame.data.args ?? {}).slice(0, 120)}`);
      return;
    case "tool_end":
      console.log(`${seq}← ${frame.data.name} ${frame.data.isError ? "ERROR" : "ok"}`);
      return;
    case "out_file":
      console.log(`${seq}📄 ${frame.data.path} ${frame.data.bytes}B`);
      return;
    case "turn_end": {
      const out = (frame.data.out ?? []).map(f => `${f.path} (${f.bytes}B)`).join(", ");
      console.log(`\n${seq}turn ${frame.data.reason}${out ? ` — ${out}` : ""}`);
      return;
    }
    case "error":
      console.log(`\n${seq}error ${frame.data.code}: ${frame.data.message}`);
      return;
    case "stream_end":
      console.log(`${seq}stream closed (busy=${frame.data.sessionBusy})`);
      return;
    default:
      console.log(`${seq}${frame.event}`);
  }
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
      await client.events(sessionId, Number(since ?? 0), { onFrame: render });
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
  let sessionId = existing;
  if (!sessionId) {
    const { body } = await client.createSession("chat");
    sessionId = body.sessionId;
    console.log(`session ${sessionId}`);
  }

  let since = 0;
  const send = async line => {
    const result = await client.prompt({
      sessionId,
      text: line,
      since,
      onFrame: frame => {
        if (frame.id !== undefined) since = Number(frame.id);
        render(frame);
      },
    });
    if (result.status !== 200) console.error(`${result.status}`, JSON.stringify(result.body));
    console.log();
  };

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      const text = line.trim();
      if (text.length === 0 || text === "/quit" || text === "/exit") continue;
      console.log(`> ${text}`);
      await send(text);
    }
    return;
  }

  console.log("type a message, or /quit to leave. Ctrl-C also works.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let line;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        return; // stream closed under an interactive session
      }
      if (line.length === 0) continue;
      if (line === "/quit" || line === "/exit") return;
      await send(line);
    }
  } finally {
    rl.close();
  }
}

await main();
