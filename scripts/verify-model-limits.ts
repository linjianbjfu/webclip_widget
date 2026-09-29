/**
 * Prove the model table matches what the gateway advertises.
 *
 * `contextWindow` decides when pi compacts the conversation, so a value below
 * the gateway's real one discards history the model could still hold — no
 * error, just a model that forgets. Nothing in the running system notices,
 * which is why this is a gate rather than a comment.
 *
 * Needs credentials: LLM_BASE_URL and LLM_API_KEY from the environment, or
 * from .dev.vars. Without them it reports that it could not check and exits 0,
 * because a contributor with no gateway access must still be able to push.
 */

import { readFileSync } from "node:fs";

interface GatewayModel {
  id: string;
  limits?: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
  };
}

function credentials(): { baseUrl: string; apiKey: string } | null {
  let baseUrl = process.env.LLM_BASE_URL;
  let apiKey = process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) {
    try {
      for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
        const [key, ...rest] = line.split("=");
        const value = rest.join("=").trim().replace(/^"|"$/g, "");
        if (key.trim() === "LLM_BASE_URL") baseUrl ||= value;
        if (key.trim() === "LLM_API_KEY") apiKey ||= value;
      }
    } catch {
      return null;
    }
  }
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

/** Read the declared table out of the source, so the gate has one source. */
function declared(): Map<string, { contextWindow: number; maxTokens: number }> {
  const source = readFileSync("src/agent/model.ts", "utf8");
  const table = new Map<string, { contextWindow: number; maxTokens: number }>();
  const entry =
    /id:\s*"([^"]+)"[\s\S]*?contextWindow:\s*([\d_]+)[\s\S]*?maxTokens:\s*([\d_]+)/g;
  for (const match of source.matchAll(entry)) {
    table.set(match[1], {
      contextWindow: Number(match[2].replaceAll("_", "")),
      maxTokens: Number(match[3].replaceAll("_", "")),
    });
  }
  return table;
}

const creds = credentials();
if (!creds) {
  console.log("verify-model-limits: no gateway credentials, not checked.");
  process.exit(0);
}

const response = await fetch(`${creds.baseUrl.replace(/\/$/, "")}/models`, {
  headers: { authorization: `Bearer ${creds.apiKey}` },
});
if (!response.ok) {
  console.error(`verify-model-limits: gateway returned ${response.status}.`);
  process.exit(1);
}

const payload = (await response.json()) as { data?: GatewayModel[]; models?: GatewayModel[] };
const advertised = new Map<string, GatewayModel>();
for (const model of payload.data ?? payload.models ?? []) advertised.set(model.id, model);

const failures: string[] = [];
const table = declared();
if (table.size === 0) failures.push("no model entries found in src/agent/model.ts");

for (const [id, local] of table) {
  const remote = advertised.get(id);
  if (!remote) {
    failures.push(`${id}: the gateway no longer advertises this model`);
    continue;
  }
  const want = {
    contextWindow: remote.limits?.max_context_window_tokens,
    maxTokens: remote.limits?.max_output_tokens,
  };
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const expected = want[field];
    if (expected === undefined) {
      failures.push(`${id}: the gateway declares no ${field}`);
    } else if (expected !== local[field]) {
      failures.push(`${id}: ${field} is ${local[field]}, the gateway says ${expected}`);
    }
  }
}

if (failures.length > 0) {
  console.error("verify-model-limits: src/agent/model.ts disagrees with the gateway.");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`verify-model-limits: ${table.size} model(s) match the gateway.`);
