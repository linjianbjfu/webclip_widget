import { describe, expect, it } from "vitest";

import { isValidTurnId, sha256Hex } from "./protocol.ts";

describe("turn id validation", () => {
  it("accepts a lowercase UUIDv4", () => {
    expect(isValidTurnId("9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01")).toBe(true);
  });

  it("rejects anything a counter would produce", () => {
    // A client that resets its counter after a reinstall could otherwise
    // collide with a finished turn and have its prompt silently swallowed.
    expect(isValidTurnId("1")).toBe(false);
    expect(isValidTurnId("turn-1")).toBe(false);
  });

  it("rejects uppercase, wrong version and malformed values", () => {
    expect(isValidTurnId("9F2C7B1E-4A83-4D15-9C60-7E3B2A5F8D01")).toBe(false);
    expect(isValidTurnId("9f2c7b1e-4a83-1d15-9c60-7e3b2a5f8d01")).toBe(false);
    expect(isValidTurnId("")).toBe(false);
    expect(isValidTurnId(undefined)).toBe(false);
  });
});

describe("artifact hashing", () => {
  it("is stable and distinguishes content", async () => {
    const a = await sha256Hex(new TextEncoder().encode("const a = 1;"));
    const again = await sha256Hex(new TextEncoder().encode("const a = 1;"));
    const b = await sha256Hex(new TextEncoder().encode("const a = 2;"));
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
