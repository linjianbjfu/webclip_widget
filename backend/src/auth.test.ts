import { describe, expect, it } from "vitest";

import { checkAuth } from "./auth.ts";

function request(authorization?: string): Request {
  return new Request("https://x/v1/sessions", {
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}

describe("shared secret gate", () => {
  it("accepts the configured token", () => {
    expect(checkAuth(request("Bearer s3cret"), "s3cret")).toEqual({ ok: true });
  });

  it("fails closed when no token is configured", () => {
    // A deployment that forgot to set the secret must refuse everyone, not
    // serve everyone.
    expect(checkAuth(request("Bearer anything"), undefined)).toEqual({
      ok: false,
      status: 503,
      error: "auth_not_configured",
    });
    expect(checkAuth(request("Bearer anything"), "")).toMatchObject({ status: 503 });
  });

  it("rejects a missing, malformed or wrong token", () => {
    expect(checkAuth(request(), "s3cret")).toMatchObject({ status: 401 });
    expect(checkAuth(request("s3cret"), "s3cret")).toMatchObject({ status: 401 });
    expect(checkAuth(request("Basic s3cret"), "s3cret")).toMatchObject({ status: 401 });
    expect(checkAuth(request("Bearer wrong"), "s3cret")).toMatchObject({ status: 401 });
  });

  it("rejects a prefix of the token", () => {
    // A length-only comparison, or one that stops at the first difference,
    // would let a caller extend a guess one character at a time.
    expect(checkAuth(request("Bearer s3cre"), "s3cret")).toMatchObject({ status: 401 });
    expect(checkAuth(request("Bearer s3crets"), "s3cret")).toMatchObject({ status: 401 });
  });

  it("does not leak the token through the error body", () => {
    const outcome = checkAuth(request("Bearer wrong"), "s3cret");
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });
});
