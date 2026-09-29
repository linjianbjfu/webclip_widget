import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { UserAgentDO } from "../src/do/user-agent-do.ts";
import { CHUNK_BYTES } from "../src/fs/schema.ts";
import { WorkspaceFs } from "../src/fs/workspace-fs.ts";
import { createShell, runShell } from "../src/shell/bash.ts";

async function withShell<T>(
  name: string,
  body: (run: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>, fs: WorkspaceFs) => Promise<T>,
): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: UserAgentDO) => {
    const fs = new WorkspaceFs(instance.sqlForTest, "s1");
    const shell = createShell(fs);
    return body(cmd => runShell(shell, cmd), fs);
  });
}

describe("shell commands run against the workspace", () => {
  it("greps a pattern that spans a chunk boundary", async () => {
    await withShell("grep-span", async (run, fs) => {
      // Three hits: before the boundary, straddling it, and after.
      const head = "x".repeat(CHUNK_BYTES - 4);
      await fs.writeFile("/source.html", `MARK one\n${head}MARK two\nMARK three\n`);

      const result = await run('grep -n "MARK" /source.html');
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("1:MARK one");
      expect(lines[2]).toBe("3:MARK three");
      // The straddling hit is on line 2 and its content crosses CHUNK_BYTES.
      expect(lines[1]?.startsWith("2:")).toBe(true);
    });
  });

  it("supports rg, find, sed, awk and jq", async () => {
    await withShell("tools", async (run, fs) => {
      await fs.writeFile("/a.json", '{"n": 41}');
      await fs.writeFile("/b.txt", "alpha\nbeta\ngamma\n");
      await fs.writeFile("/c.js", "const x = 1;\n");

      expect((await run('rg -n "beta" /b.txt')).stdout.trim()).toBe("2:beta");
      expect((await run('find / -name "*.js"')).stdout.trim()).toBe("/c.js");
      expect((await run('sed -n "2p" /b.txt')).stdout.trim()).toBe("beta");
      // Single quotes: in double quotes the shell would expand $1 before awk sees it.
      expect((await run("seq 3 | awk '{s+=$1} END{print s}'")).stdout.trim()).toBe("6");
      expect((await run("jq -c .n /a.json")).stdout.trim()).toBe("41");
    });
  });

  it("writes through a shell redirect and the workspace sees it", async () => {
    await withShell("redirect", async (run, fs) => {
      await fs.writeFile("/src.txt", "hello\n");
      const result = await run("sed 's/hello/world/' /src.txt > /out/extra.js");
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile("/out/extra.js")).toBe("world\n");
      // The notification hangs off the filesystem, so a redirect is reported
      // even though no write tool was involved.
      expect(fs.drainOutWrites()).toEqual(["/out/extra.js"]);
    });
  });

  it("pipes between commands", async () => {
    await withShell("pipe", async (run, fs) => {
      await fs.writeFile("/log.txt", "a\nb\na\nc\n");
      expect((await run("sort /log.txt | uniq -c | sort -rn | head -1")).stdout.trim()).toMatch(/2\s+a/);
    });
  });
});

describe("guidance commands answer with a next step", () => {
  it("points node at preview_widget instead of failing silently", async () => {
    await withShell("node", async run => {
      const result = await run("node --check out/extra.js");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("preview_widget");
      expect(result.stderr).not.toContain("command not found");
    });
  });

  it("points package managers and script runtimes somewhere useful", async () => {
    await withShell("guidance", async run => {
      expect((await run("npm install lodash")).stderr).toContain("no dependencies");
      expect((await run("python3 -c 'print(1)'")).stderr).toContain("sed, awk, jq");
      expect((await run("js-exec /x.js")).stderr).toContain("sed, awk, jq");
    });
  });
});

describe("which reports what is actually runnable", () => {
  it("finds registered commands even though no /usr/bin exists", async () => {
    await withShell("which-ok", async run => {
      const result = await run("which grep rg find sed awk jq");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(6);
    });
  });

  it("reports a guided command as absent, matching what running it says", async () => {
    await withShell("which-guided", async run => {
      // `node` is registered so it can print guidance, but it is not a tool
      // the agent can use; `which` must not contradict that.
      expect((await run("which node")).exitCode).toBe(1);
      expect((await run("which python3")).exitCode).toBe(1);
    });
  });

  it("keeps the workspace free of PATH stubs", async () => {
    await withShell("which-clean", async (run, fs) => {
      await fs.writeFile("/only.js", "x");
      // Seeding /usr/bin to satisfy `which` would show up here.
      expect((await run('find / -name "*"')).stdout).not.toContain("/usr/bin");
      expect(fs.getAllPaths()).not.toContain("/usr/bin/grep");
    });
  });

  it("supports test as a builtin", async () => {
    await withShell("builtin", async run => {
      expect((await run("[ -d / ] && echo yes")).stdout.trim()).toBe("yes");
    });
  });
});
