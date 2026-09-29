/**
 * Protocol-level client for the webclip_widget server.
 *
 * Two jobs, and both matter. It is the fixture the end-to-end checks drive,
 * and it is how the service is exercised before the iOS app exists. The
 * second is why it is written as a tool rather than a throwaway script.
 *
 * Strict by default: any gap, duplicate or out-of-order sequence number is an
 * error. The interactive driver relaxes that, because a human watching output
 * wants to keep reading rather than have the process exit.
 */

import { randomUUID } from "node:crypto";

import { SseParser } from "./sse.mjs";

export class ProtocolError extends Error {}

export class Client {
  /**
   * @param {{ baseUrl: string, token: string, userId: string, strict?: boolean }} options
   */
  constructor({ baseUrl, token, userId, strict = true }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.userId = userId;
    this.strict = strict;
  }

  get #headers() {
    return { authorization: `Bearer ${this.token}`, "x-webclip-user": this.userId };
  }

  async #json(path, init = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.#headers, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  createSession(title) {
    return this.#json("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
  }

  listSessions() {
    return this.#json("/v1/sessions");
  }

  deleteSession(sessionId) {
    return this.#json(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  }

  abort(sessionId) {
    return this.#json(`/v1/sessions/${sessionId}/abort`, { method: "POST" });
  }

  newTurnId() {
    return randomUUID();
  }

  /**
   * Start a turn and consume its stream.
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.text
   * @param {string} [options.turnId] Reuse to exercise idempotency.
   * @param {number} [options.since] Client cursor.
   * @param {number} [options.stopAfter] Abandon the stream after this many
   *   frames, to reproduce a client that vanishes mid-turn.
   * @param {(frame: import("./sse.mjs").Frame) => void} [options.onFrame]
   */
  async prompt(options) {
    const turnId = options.turnId ?? this.newTurnId();
    const body = JSON.stringify({
      turnId,
      text: options.text,
      ...(options.since === undefined ? {} : { since: options.since }),
    });
    const response = await fetch(`${this.baseUrl}/v1/sessions/${options.sessionId}/prompt`, {
      method: "POST",
      headers: { ...this.#headers, "content-type": "application/json" },
      body,
    });
    if (response.status !== 200) {
      return { turnId, status: response.status, body: await response.json().catch(() => null), frames: [] };
    }
    const frames = await this.#consume(response, options.stopAfter, options.onFrame);
    return { turnId, status: 200, frames };
  }

  /** Reconnect from a cursor. Follows a live turn if one is running. */
  async events(sessionId, since = 0, { stopAfter, onFrame } = {}) {
    const response = await fetch(
      `${this.baseUrl}/v1/sessions/${sessionId}/events?since=${since}`,
      { headers: this.#headers },
    );
    if (response.status !== 200) {
      return { status: response.status, frames: [] };
    }
    return { status: 200, frames: await this.#consume(response, stopAfter, onFrame) };
  }

  async #consume(response, stopAfter, onFrame) {
    const parser = new SseParser();
    const frames = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          frames.push(frame);
          onFrame?.(frame);
          if (stopAfter !== undefined && frames.length >= stopAfter) {
            // Drop the connection the way a backgrounded app does: no close
            // handshake, just a reader that stops.
            await reader.cancel().catch(() => {});
            return frames;
          }
          if (frame.event === "stream_end") return frames;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return frames;
  }
}

/**
 * Sequence numbers a client would carry, in the order they arrived.
 *
 * Frames without `id:` are excluded deliberately: per the SSE specification
 * they do not advance `Last-Event-ID`, so they are not resume points.
 * @param {import("./sse.mjs").Frame[]} frames
 */
export function cursors(frames) {
  return frames.filter(f => f.id !== undefined).map(f => Number(f.id));
}

/**
 * Assert a sequence is strictly increasing with no repeats.
 * @param {number[]} seqs
 */
export function assertMonotonic(seqs, label) {
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] <= seqs[i - 1]) {
      throw new ProtocolError(`${label}: seq not increasing at index ${i}: ${seqs[i - 1]} then ${seqs[i]}`);
    }
  }
}

/**
 * Assert that reconnecting produced exactly the records an uninterrupted run
 * would have, with nothing missing and nothing sent twice.
 * @param {number[]} before @param {number[]} after @param {number[]} whole
 */
export function assertNoGapOrRepeat(before, after, whole, label) {
  const joined = [...before, ...after];
  const overlap = before.filter(seq => after.includes(seq));
  if (overlap.length > 0) {
    throw new ProtocolError(`${label}: ${overlap.length} record(s) delivered twice: ${overlap.join(", ")}`);
  }
  const missing = whole.filter(seq => !joined.includes(seq));
  if (missing.length > 0) {
    throw new ProtocolError(`${label}: ${missing.length} record(s) never delivered: ${missing.join(", ")}`);
  }
}
