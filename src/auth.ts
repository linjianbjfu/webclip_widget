/**
 * Shared-secret gate.
 *
 * This is not the authentication scheme the product needs — it proves the
 * caller knows one token, not who they are, and every caller shares it. Its
 * job is narrower: keep a deployment that is not yet meant for real users
 * from being driven by whoever finds the URL, since an open endpoint here
 * spends the account's model budget.
 *
 * It fails closed. A deployment with no token configured refuses everything
 * rather than serving everyone: forgetting to set a secret must not be the
 * same as deciding not to have one.
 */

const PREFIX = "Bearer ";

/**
 * Compare without leaking length or position through timing.
 *
 * A naive `===` returns as soon as two bytes differ, which lets a caller
 * recover the token one character at a time. The cost of doing it properly is
 * a loop over at most a few dozen bytes.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare lengths as data too, so a mismatch still walks the same path.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export type AuthOutcome = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function checkAuth(request: Request, expected: string | undefined): AuthOutcome {
  if (!expected || expected.length === 0) {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith(PREFIX)) return { ok: false, status: 401, error: "unauthorized" };
  const presented = header.slice(PREFIX.length).trim();
  if (!constantTimeEqual(presented, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}
