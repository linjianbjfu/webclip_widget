/** Wire types shared by the router, the Durable Object and the CLI client. */

export const TURN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ErrorCode = "llm_failed" | "turn_timeout" | "recovery_exhausted" | "internal";

export interface OutFile {
  path: string;
  bytes: number;
  sha256: string;
  /** Present on the live stream and when read back; absent in the stored record. */
  content?: string;
}

export interface TurnEndPayload {
  turnId: string;
  reason: "completed" | "aborted" | "failed";
  out: OutFile[];
}

export interface ErrorPayload {
  turnId: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface CreateSessionRequest {
  title?: string;
}

export interface PromptRequest {
  turnId: string;
  text?: string;
  since?: number;
}

export function isValidTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID_PATTERN.test(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
