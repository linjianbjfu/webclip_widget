/**
 * Fan-out of live frames to every open stream for a session.
 *
 * A stream is not owned by the turn that produced it. `POST /prompt` returns
 * one subscriber and `GET /events` returns another; both are ordinary HTTP
 * responses fed from the same broadcast. Requests for one session land on one
 * Durable Object, so the hub can live in its memory.
 *
 * Writes are never awaited. A subscriber that falls behind its backlog cap is
 * closed and dropped rather than throttled: reconnection is lossless — the
 * client returns with `since` and the log fills the gap — whereas making the
 * agent loop wait on a client that may have been backgrounded costs far more.
 * The common cause of a stalled subscriber is not a slow reader but a TCP
 * connection the server cannot yet tell is dead.
 */

import { encodeFrame, type Frame } from "./sse.ts";

const MAX_PENDING_WRITES = 64;

class Subscriber {
  #pending = 0;
  #dead = false;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.#writer = writer;
  }

  get dead(): boolean {
    return this.#dead;
  }

  /** Queue a frame. Returns false when the subscriber must be dropped. */
  offer(frame: Frame): boolean {
    if (this.#dead) return false;
    if (this.#pending >= MAX_PENDING_WRITES) {
      this.#dead = true;
      return false;
    }
    this.#pending += 1;
    this.#writer.write(encodeFrame(frame)).then(
      () => {
        this.#pending -= 1;
      },
      () => {
        this.#dead = true;
      },
    );
    return true;
  }

  /**
   * Close without awaiting.
   *
   * A `TransformStream` applies backpressure: `close()` resolves only once
   * the queue drains, which never happens if the peer stopped reading.
   * Awaiting it here would block the Durable Object on exactly the client
   * the backlog cap exists to survive — the same reason `offer` does not
   * await `write`.
   */
  close(): void {
    this.#dead = true;
    void this.#writer.close().catch(() => {
      // The peer is already gone; the writer needs no further release.
    });
  }
}

export class Hub {
  readonly #bySession = new Map<string, Set<Subscriber>>();

  /**
   * Register a stream and hand back its readable end.
   *
   * `backlog` is written before any live frame reaches the subscriber, which
   * is what closes the gap between reading the log and joining the broadcast.
   * Caller must compute the backlog and call this in one synchronous block:
   * `sql.exec()` returns synchronously, so no broadcast can interleave.
   */
  subscribe(sessionId: string, backlog: readonly Frame[]): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const subscriber = new Subscriber(writable.getWriter());
    for (const frame of backlog) subscriber.offer(frame);
    let set = this.#bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.#bySession.set(sessionId, set);
    }
    set.add(subscriber);
    return readable;
  }

  /**
   * A stream that carries only the backlog and the terminator.
   *
   * Used when no turn is running: the caller gets every record after its
   * cursor and the stream closes, so it never becomes a subscriber and never
   * holds the Durable Object in memory.
   */
  finite(backlog: readonly Frame[], tail: Frame): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const subscriber = new Subscriber(writable.getWriter());
    for (const frame of backlog) subscriber.offer(frame);
    subscriber.offer(tail);
    subscriber.close();
    return readable;
  }

  broadcast(sessionId: string, frame: Frame): void {
    const set = this.#bySession.get(sessionId);
    if (!set) return;
    for (const subscriber of [...set]) {
      if (!subscriber.offer(frame)) {
        subscriber.close();
        set.delete(subscriber);
      }
    }
    if (set.size === 0) this.#bySession.delete(sessionId);
  }

  /**
   * Send the terminator to every subscriber and close them.
   *
   * Synchronous by design: a turn must be able to finish without waiting on
   * any client to consume its last frames.
   */
  closeAll(sessionId: string, tail: Frame): void {
    const set = this.#bySession.get(sessionId);
    if (!set) return;
    this.#bySession.delete(sessionId);
    for (const subscriber of set) {
      subscriber.offer(tail);
      subscriber.close();
    }
  }

  count(sessionId: string): number {
    return this.#bySession.get(sessionId)?.size ?? 0;
  }
}
