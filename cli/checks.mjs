/**
 * End-to-end checks against a deployed server.
 *
 * These cover what no other layer can: a real network, a real model, and a
 * client that drops mid-turn. They replace the hand-run curl commands that
 * previously stood in for this — a check nobody can repeat is a check that
 * stops being run.
 *
 * Every assertion is about protocol behaviour, never about what the model
 * says: the same prompt does not produce the same words twice, so an
 * assertion on wording would either be vacuous or flaky.
 */

import { assertMonotonic, assertNoGapOrRepeat, Client, cursors, ProtocolError } from "./client.mjs";

const WRITE_PROMPT =
  "Use the write tool to create out/note.txt containing exactly: ok. Then reply DONE and stop.";
const SLOW_PROMPT =
  "Run these as three separate bash calls, do not combine them: 'sleep 40; echo one', " +
  "'sleep 40; echo two', 'sleep 40; echo three'. Then write out/slow.txt containing done. Then reply DONE.";

/** Eviction happens at 70 s without an inbound event; a valid keepalive check must exceed it. */
const EVICTION_SECONDS = 70;

class Reporter {
  #passed = 0;
  #failed = 0;
  #skipped = 0;

  async run(name, body, { slow = false } = {}) {
    const started = Date.now();
    try {
      const note = await body();
      this.#passed += 1;
      console.log(`  ✓ ${name}${note ? ` — ${note}` : ""} (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (error) {
      this.#failed += 1;
      const kind = error instanceof ProtocolError ? "protocol" : "error";
      console.log(`  ✗ ${name} [${kind}] ${error.message}`);
      if (slow) console.log("    (a slow check; a timeout here may mean the model stalled, not a defect)");
    }
  }

  skip(name, why) {
    this.#skipped += 1;
    console.log(`  - ${name} — skipped: ${why}`);
  }

  summary() {
    console.log(`\n${this.#passed} passed, ${this.#failed} failed, ${this.#skipped} skipped`);
    return this.#failed === 0 ? 0 : 1;
  }
}

/** A fresh session, removed afterwards so repeated runs do not accumulate. */
async function withSession(client, body) {
  const { body: created, status } = await client.createSession("e2e");
  if (status !== 201) throw new Error(`createSession returned ${status}`);
  try {
    return await body(created.sessionId);
  } finally {
    await client.deleteSession(created.sessionId).catch(() => {});
  }
}

export async function runChecks(config) {
  const client = new Client({ ...config, userId: `e2e-${Date.now()}` });
  const reporter = new Reporter();
  const slow = process.env.WEBCLIP_SLOW === "1";

  console.log(`e2e against ${config.baseUrl}\n`);

  console.log("auth");
  await reporter.run("rejects a missing token", async () => {
    const response = await fetch(`${config.baseUrl}/v1/sessions`, {
      headers: { "x-webclip-user": "nobody" },
    });
    if (response.status !== 401) throw new ProtocolError(`expected 401, got ${response.status}`);
  });
  await reporter.run("rejects a wrong token", async () => {
    const response = await fetch(`${config.baseUrl}/v1/sessions`, {
      headers: { authorization: "Bearer wrong", "x-webclip-user": "nobody" },
    });
    if (response.status !== 401) throw new ProtocolError(`expected 401, got ${response.status}`);
  });

  console.log("\nsession lifecycle");
  await reporter.run("create, list and delete", async () => {
    const { body, status } = await client.createSession("temp");
    if (status !== 201) throw new ProtocolError(`create returned ${status}`);
    const listed = await client.listSessions();
    if (!listed.body.sessions.some(s => s.id === body.sessionId)) {
      throw new ProtocolError("created session missing from the listing");
    }
    const removed = await client.deleteSession(body.sessionId);
    if (removed.status !== 204) throw new ProtocolError(`delete returned ${removed.status}`);
    const after = await client.listSessions();
    if (after.body.sessions.some(s => s.id === body.sessionId)) {
      throw new ProtocolError("session still listed after delete");
    }
  });

  console.log("\nturn and stream");
  await reporter.run("a turn streams and yields artefacts", () =>
    withSession(client, async sessionId => {
      const { frames, status } = await client.prompt({ sessionId, text: WRITE_PROMPT });
      if (status !== 200) throw new ProtocolError(`prompt returned ${status}`);
      const end = frames.find(f => f.event === "turn_end");
      if (!end) throw new ProtocolError("no turn_end");
      if (end.data.reason !== "completed") throw new ProtocolError(`turn ${end.data.reason}`);
      if (!frames.some(f => f.event === "stream_end")) throw new ProtocolError("no stream_end");
      if (!(end.data.out ?? []).some(f => f.content !== undefined)) {
        throw new ProtocolError("turn_end carried no inlined artefact content");
      }
      assertMonotonic(cursors(frames), "live stream");
      return `${end.data.out.length} artefact(s)`;
    }),
  );

  await reporter.run("deltas do not advance the cursor", () =>
    withSession(client, async sessionId => {
      const { frames } = await client.prompt({ sessionId, text: WRITE_PROMPT });
      const withId = new Set(frames.filter(f => f.id !== undefined).map(f => f.event));
      for (const event of withId) {
        if (event === "stream" || event === "tool_start" || event === "tool_end") {
          throw new ProtocolError(`${event} carried an id and would move the resume point`);
        }
      }
      if (!withId.has("turn_end")) throw new ProtocolError("turn_end carried no id");
      return `${withId.size} cursor-bearing event type(s)`;
    }),
  );

  console.log("\ndisconnect and resume");
  await reporter.run("reconnecting loses nothing and repeats nothing", () =>
    withSession(client, async sessionId => {
      // Drop the stream a few frames in, the way a backgrounded app does.
      const first = await client.prompt({ sessionId, text: WRITE_PROMPT, stopAfter: 3 });
      const before = cursors(first.frames);
      const resumeFrom = before.length > 0 ? before[before.length - 1] : 0;

      const second = await client.events(sessionId, resumeFrom);
      const after = cursors(second.frames);
      if (!second.frames.some(f => f.event === "stream_end")) {
        throw new ProtocolError("resumed stream never terminated");
      }

      const whole = cursors((await client.events(sessionId, 0)).frames);
      assertMonotonic(after, "resumed stream");
      assertNoGapOrRepeat(before, after, whole, "resume");
      return `${before.length} before, ${after.length} after, ${whole.length} total`;
    }),
  );

  await reporter.run("replaying a finished turn starts nothing new", () =>
    withSession(client, async sessionId => {
      const first = await client.prompt({ sessionId, text: WRITE_PROMPT });
      const turnId = first.turnId;
      const totalBefore = cursors((await client.events(sessionId, 0)).frames).length;

      // The same turnId must be answered from the log, not run again.
      const replay = await client.prompt({ sessionId, text: WRITE_PROMPT, turnId });
      if (replay.status !== 200) throw new ProtocolError(`replay returned ${replay.status}`);
      if (!replay.frames.some(f => f.event === "stream_end")) {
        throw new ProtocolError("replay never terminated");
      }
      const totalAfter = cursors((await client.events(sessionId, 0)).frames).length;
      if (totalAfter !== totalBefore) {
        throw new ProtocolError(`replay appended ${totalAfter - totalBefore} record(s); it must append none`);
      }
      return "log unchanged";
    }),
  );

  await reporter.run("a second turnId is refused while one is running", () =>
    withSession(client, async sessionId => {
      const running = client.prompt({ sessionId, text: SLOW_PROMPT, stopAfter: 1 });
      await running;
      // The turn keeps going after the client stops reading.
      const conflict = await client.prompt({ sessionId, text: "something else" });
      await client.abort(sessionId).catch(() => {});
      if (conflict.status !== 409) throw new ProtocolError(`expected 409, got ${conflict.status}`);
      if (!conflict.body?.runningTurnId) throw new ProtocolError("409 did not name the running turn");
      return "409 with runningTurnId";
    }),
  );

  console.log("\nartefact delivery");
  await reporter.run("replay carries metadata, not content", () =>
    withSession(client, async sessionId => {
      await client.prompt({ sessionId, text: WRITE_PROMPT });
      const replayed = (await client.events(sessionId, 0)).frames.find(f => f.event === "turn_end");
      if (!replayed) throw new ProtocolError("no turn_end on replay");
      const out = replayed.data.out ?? [];
      if (out.length === 0) throw new ProtocolError("replayed turn_end listed no artefacts");
      if (out.some(f => f.content !== undefined)) {
        throw new ProtocolError("replayed turn_end inlined content; history would grow with every iteration");
      }
      if (out.some(f => !f.sha256)) throw new ProtocolError("replayed artefact lacked a hash");
      return `${out.length} artefact(s), metadata only`;
    }),
  );

  console.log("\nkeepalive");
  if (!slow) {
    reporter.skip(
      "a turn outlives a vanished client",
      `needs >${EVICTION_SECONDS}s of model time; set WEBCLIP_SLOW=1`,
    );
  } else {
    await reporter.run(
      "a turn outlives a vanished client",
      () =>
        withSession(client, async sessionId => {
          const startedAt = Date.now();
          // Read one frame, then vanish. Nothing inbound reaches the object
          // afterwards, so only the keepalive alarm can hold it in memory.
          await client.prompt({ sessionId, text: SLOW_PROMPT, stopAfter: 1 });

          let elapsed = 0;
          for (;;) {
            await new Promise(resolve => setTimeout(resolve, 10_000));
            elapsed = (Date.now() - startedAt) / 1000;
            const listed = await client.listSessions();
            const session = listed.body.sessions.find(s => s.id === sessionId);
            if (session && !session.busy) break;
            if (elapsed > 300) throw new ProtocolError("turn never finished within 300s");
          }

          // A turn shorter than the eviction window proves nothing: it would
          // have survived regardless.
          if (elapsed <= EVICTION_SECONDS) {
            throw new ProtocolError(
              `turn ran ${elapsed.toFixed(1)}s, inside the ${EVICTION_SECONDS}s window — this run cannot show keepalive works`,
            );
          }
          const end = (await client.events(sessionId, 0)).frames.find(f => f.event === "turn_end");
          if (end?.data.reason !== "completed") {
            throw new ProtocolError(`turn ended as ${end?.data.reason ?? "nothing"}`);
          }
          return `ran ${elapsed.toFixed(1)}s past a ${EVICTION_SECONDS}s window`;
        }),
      { slow: true },
    );
  }

  return reporter.summary();
}
