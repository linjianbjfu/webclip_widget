// Must evaluate before any pi module: pi validates tool arguments with
// TypeBox's Compile(), which builds functions from strings. Workers reject
// that outright, and the symptom is every tool call failing.
import "./typebox-setup.ts";

import type { Env } from "./do/user-agent-do.ts";

export { UserAgentDO } from "./do/user-agent-do.ts";

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
