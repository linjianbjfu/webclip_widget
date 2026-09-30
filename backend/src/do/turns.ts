/**
 * Turn lifetime: keepalive, persistence and recovery.
 *
 * A turn is necessarily detached — `runTurn` cannot be awaited, or the
 * response would only return once the whole turn finished and there would be
 * no streaming. Detached work does not keep a Durable Object alive: measured
 * on production, a `setTimeout` loop with no inbound request or alarm is
 * killed at 70 seconds, and a plain `fetch()` to the model does not help
 * because subrequests never hold the object in memory.
 *
 * Hence two layers. An alarm re-armed every 30 seconds keeps the object
 * resident — each firing is itself an inbound event, which resets the
 * inactivity timer. Recovery from the persisted log backs up the cases the
 * alarm cannot cover, chiefly a deploy restarting the object.
 */

export const KEEPALIVE_MS = 30_000;
/** Progress older than this means the turn lost its host. Three keepalive periods. */
export const STALE_MS = 95_000;
/** Beyond this a turn is abandoned rather than resumed again. */
export const MAX_RECOVERIES = 3;
/** A turn that never ends would otherwise be kept alive, and billed, forever. */
export const MAX_TURN_MS = 15 * 60_000;
/** How long a finished turn answers a late retry before cleanup removes it. */
export const TURN_RETENTION_MS = 24 * 60 * 60_000;

export interface AlarmDecision {
  /** Turns whose host disappeared and that should be resumed. */
  resume: Array<{ sessionId: string; turnId: string }>;
  /** Turns past the hard limit; mark failed and stop. */
  abandon: Array<{ sessionId: string; turnId: string; reason: "turn_timeout" | "recovery_exhausted" }>;
  /** Whether any turn remains, i.e. whether to re-arm. */
  rearm: boolean;
}

export interface TurnSnapshot {
  session_id: string;
  turn_id: string;
  started_at: number;
  recoveries: number;
}

/**
 * Decide what one alarm firing should do.
 *
 * Kept free of IO so the branches — re-arm, resume, abandon — can be tested
 * without waiting on a real alarm.
 */
export function decideAlarm(
  stale: readonly TurnSnapshot[],
  anyRunning: boolean,
  now: number,
): AlarmDecision {
  const resume: AlarmDecision["resume"] = [];
  const abandon: AlarmDecision["abandon"] = [];
  for (const turn of stale) {
    if (now - turn.started_at > MAX_TURN_MS) {
      abandon.push({ sessionId: turn.session_id, turnId: turn.turn_id, reason: "turn_timeout" });
    } else if (turn.recoveries >= MAX_RECOVERIES) {
      // Each recovery re-issues the model call: the previous one was paid for
      // and discarded, so an unbounded retry is an expensive loop.
      abandon.push({ sessionId: turn.session_id, turnId: turn.turn_id, reason: "recovery_exhausted" });
    } else {
      resume.push({ sessionId: turn.session_id, turnId: turn.turn_id });
    }
  }
  return { resume, abandon, rearm: anyRunning };
}
