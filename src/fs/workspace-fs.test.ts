import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { UserAgentDO } from "../do/user-agent-do.ts";
import { CHUNK_BYTES } from "./schema.ts";
import { WorkspaceFs } from "./workspace-fs.ts";

/** Run a body against a fresh WorkspaceFs inside a real Durable Object. */
async function withFs<T>(
  name: string,
  body: (fs: WorkspaceFs, make: (session: string) => WorkspaceFs) => Promise<T>,
): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: UserAgentDO) => {
    const make = (session: string): WorkspaceFs => new WorkspaceFs(instance.sqlForTest, session);
    return body(make("s1"), make);
  });
}

describe("chunking is invisible above IFileSystem", () => {
  it("round-trips 5 MB byte-for-byte", async () => {
    await withFs("big", async fs => {
      const size = 5 * 1024 * 1024;
      const source = new Uint8Array(size);
      for (let i = 0; i < size; i++) source[i] = i % 251;
      await fs.writeFile("/source.html", source);

      const back = await fs.readFileBuffer("/source.html");
      expect(back.byteLength).toBe(size);
      // Byte-for-byte, not just length: a chunk-order bug passes a length check.
      expect(back).toEqual(source);
    });
  });

  it("keeps multi-byte UTF-8 intact across a chunk boundary", async () => {
    await withFs("utf8", async fs => {
      // Place a 3-byte character so it straddles the 512 KB boundary.
      const filler = "a".repeat(CHUNK_BYTES - 1);
      const text = `${filler}★tail`;
      await fs.writeFile("/u.txt", text);
      expect(await fs.readFile("/u.txt")).toBe(text);
    });
  });

  it("finds a pattern that spans a chunk boundary", async () => {
    await withFs("span", async fs => {
      const head = "x".repeat(CHUNK_BYTES - 4);
      await fs.writeFile("/s.txt", `${head}AAA_BBB tail`);
      const content = await fs.readFile("/s.txt");
      // Straddles the boundary at CHUNK_BYTES.
      expect(content.indexOf("AAA_BBB")).toBe(CHUNK_BYTES - 4);
    });
  });

  it("caches the reassembly and invalidates on write", async () => {
    await withFs("cache", async fs => {
      await fs.writeFile("/c.txt", "one");
      const a = await fs.readFileBuffer("/c.txt");
      const b = await fs.readFileBuffer("/c.txt");
      expect(b).toBe(a); // same instance: served from cache
      await fs.writeFile("/c.txt", "two");
      expect(await fs.readFile("/c.txt")).toBe("two");
    });
  });
});

describe("session isolation", () => {
  it("keeps same-named files in different sessions apart", async () => {
    await withFs("iso", async (_fs, make) => {
      const a = make("session-a");
      const b = make("session-b");
      await a.writeFile("/source.html", "from A");
      await b.writeFile("/source.html", "from B");
      expect(await a.readFile("/source.html")).toBe("from A");
      expect(await b.readFile("/source.html")).toBe("from B");
      expect(a.getAllPaths()).toContain("/source.html");
      expect(b.getAllPaths()).toContain("/source.html");
    });
  });

  it("does not leak one session's tree into another's listing", async () => {
    await withFs("iso2", async (_fs, make) => {
      const a = make("only-a");
      const b = make("only-b");
      await a.writeFile("/a-only.txt", "x");
      expect(b.getAllPaths()).not.toContain("/a-only.txt");
    });
  });
});

describe("getAllPaths is synchronous", () => {
  it("returns an array, not a promise", async () => {
    await withFs("sync", async fs => {
      await fs.writeFile("/a.txt", "1");
      const paths = fs.getAllPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths).toContain("/a.txt");
    });
  });
});

describe("error behaviour", () => {
  it("throws ENOENT rather than succeeding silently", async () => {
    await withFs("errs", async fs => {
      await expect(fs.stat("/missing")).rejects.toThrow(/ENOENT/);
      await expect(fs.readFileBuffer("/missing")).rejects.toThrow(/ENOENT/);
      await expect(fs.readdir("/missing")).rejects.toThrow(/ENOENT/);
      await expect(fs.rm("/missing")).rejects.toThrow(/ENOENT/);
      await expect(fs.mv("/missing", "/x")).rejects.toThrow(/ENOENT/);
      await expect(fs.cp("/missing", "/x")).rejects.toThrow(/ENOENT/);
    });
  });

  it("rm --force on a missing path is a no-op", async () => {
    await withFs("force", async fs => {
      await expect(fs.rm("/missing", { force: true })).resolves.toBeUndefined();
    });
  });

  it("rejects hard links loudly", async () => {
    await withFs("link", async fs => {
      await fs.writeFile("/a.txt", "x");
      await expect(fs.link("/a.txt", "/b.txt")).rejects.toThrow(/ENOSYS/);
    });
  });
});

describe("out-directory notification", () => {
  it("reports every write path under /out and drains once", async () => {
    await withFs("out", async fs => {
      await fs.writeFile("/out/extra.js", "const a = 1;");
      await fs.writeFile("/out/widget.html", "<p>hi</p>");
      await fs.writeFile("/draft.js", "not an artifact");
      expect(fs.drainOutWrites()).toEqual(["/out/extra.js", "/out/widget.html"]);
      expect(fs.drainOutWrites()).toEqual([]);
    });
  });

  it("reports appends and moves into /out, not just writeFile", async () => {
    await withFs("out2", async fs => {
      await fs.writeFile("/tmp.js", "a");
      await fs.mv("/tmp.js", "/out/moved.js");
      await fs.appendFile("/out/moved.js", "b");
      expect(fs.drainOutWrites()).toContain("/out/moved.js");
    });
  });
});

describe("directories and symlinks", () => {
  it("lists only direct children", async () => {
    await withFs("dirs", async fs => {
      await fs.writeFile("/d/a.txt", "1");
      await fs.writeFile("/d/sub/b.txt", "2");
      const names = (await fs.readdir("/d")).sort();
      expect(names).toEqual(["a.txt", "sub"]);
    });
  });

  it("follows a symlink on read but not on lstat", async () => {
    await withFs("sym", async fs => {
      await fs.writeFile("/real.txt", "content");
      await fs.symlink("/real.txt", "/link.txt");
      expect(await fs.readFile("/link.txt")).toBe("content");
      expect((await fs.stat("/link.txt")).isFile).toBe(true);
      expect((await fs.lstat("/link.txt")).isSymbolicLink).toBe(true);
    });
  });

  it("moves a directory with its subtree", async () => {
    await withFs("mvdir", async fs => {
      await fs.writeFile("/src/x/y.txt", "deep");
      await fs.mv("/src", "/dst");
      expect(await fs.readFile("/dst/x/y.txt")).toBe("deep");
      expect(await fs.exists("/src/x/y.txt")).toBe(false);
    });
  });
});
