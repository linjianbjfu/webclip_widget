/**
 * The bash tool must carry the workspace's shell facts.
 *
 * The guidance is only useful where the model writes the command, so it hangs
 * off the tool description rather than the system prompt. Losing it is silent:
 * the model falls back to patterns that suit a system grep, and a turn that
 * took seconds starts taking minutes.
 *
 * pi's own tool definition is not imported here. Reaching the package root
 * from the Workers pool drags in its extension loader, which needs
 * `node:process`; a stand-in is enough, because the contract under test is
 * that the wrapper appends to whatever description it is given.
 */

import { describe, expect, it } from "vitest";

import { withWorkspaceShellBrief } from "./bash-brief.ts";

const stand_in = {
  name: "bash",
  description: "Execute a bash command. Output is truncated to 50KB.",
  parameters: { type: "object" },
  execute: () => undefined,
};

describe("the bash tool's description", () => {
  const described = withWorkspaceShellBrief(stand_in);

  it("keeps what the tool already said about itself", () => {
    expect(described.description.startsWith(stand_in.description)).toBe(true);
  });

  it("names the absent interpreters", () => {
    for (const absent of ["node", "npm", "python", "js-exec"]) {
      expect(described.description).toContain(absent);
    }
  });

  it("states what a leading bounded repetition costs", () => {
    expect(described.description).toContain("RE2");
    expect(described.description).toContain(".{0,N}");
    expect(described.description).toContain("awk");
  });

  it("changes nothing else about the tool", () => {
    expect(described.name).toBe(stand_in.name);
    expect(described.parameters).toBe(stand_in.parameters);
    expect(described.execute).toBe(stand_in.execute);
  });
});
