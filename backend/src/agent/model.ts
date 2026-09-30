/**
 * Model runtime.
 *
 * Only the selected provider is registered: a deployment that configured one
 * gateway must still start without keys for any other. `modelsPath: null`
 * keeps the catalogue in memory, which is required regardless because the
 * Workers `node:fs` is a per-request in-memory VFS with nothing durable
 * behind it.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { Env } from "../do/user-agent-do.ts";

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

/**
 * Models registered for the configured gateway.
 *
 * `contextWindow` determines when pi compacts the conversation; `maxTokens`
 * bounds the requested output. `npm run verify-model-limits` compares both
 * with the gateway's advertised limits.
 */
const MODELS = [
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
] as const;

export function resolveProvider(env: Env): ProviderConfig {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("LLM_BASE_URL and LLM_API_KEY must be configured");
  return {
    id: env.LLM_PROVIDER ?? "gateway",
    baseUrl,
    apiKey,
    defaultModel: env.DEFAULT_MODEL ?? MODELS[0].id,
  };
}

export async function createModelRuntime(config: ProviderConfig): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(config.id, {
    api: "openai-completions",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: MODELS.map(model => ({
      ...model,
      input: [...model.input],
      // The gateway takes `system`, not `developer`. Some upstreams drop a
      // developer role silently and others reject the request outright, so
      // this is pinned rather than probed.
      compat: { supportsDeveloperRole: false },
    })),
  });
  return runtime;
}
