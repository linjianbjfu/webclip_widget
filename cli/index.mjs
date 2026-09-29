#!/usr/bin/env node
/**
 * webclip CLI — drive the server without the iOS app.
 *
 * Configuration comes from the environment so a token never lands in shell
 * history: WEBCLIP_URL, WEBCLIP_TOKEN, WEBCLIP_USER.
 *
 *   webclip sessions                    list
 *   webclip new [title]                 create
 *   webclip prompt <session> <text>     run a turn, stream it
 *   webclip events <session> [since]    replay and follow
 *   webclip abort <session>
 *   webclip rm <session>
 *   webclip check                       run the end-to-end suite
 */

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
      const result = await client.prompt({ sessionId, text: rest.join(" "), onFrame: render });
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
    default:
      console.error("usage: webclip <sessions|new|prompt|events|abort|rm|check>");
      process.exit(2);
  }
}

await main();
