import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createBriefProvider, type BriefContext } from "./brief.ts";

/** Pi consumes the loaded resource prompt, not a createAgentSession option. */
export async function createWidgetResourceLoader(context: BriefContext) {
  const loader = new DefaultResourceLoader({
    cwd: context.workspaceRoot,
    agentDir: "/.agent",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: createBriefProvider().system(context),
  });
  await loader.reload();
  return loader;
}
