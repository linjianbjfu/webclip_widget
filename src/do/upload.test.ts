import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { UserAgentDO } from "./user-agent-do.ts";
import { isMultipart, parseMultipartPrompt } from "./upload.ts";
import { WorkspaceFs } from "../fs/workspace-fs.ts";

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function multipartRequest(form: FormData): Request {
  return new Request("https://x/v1/sessions/s/prompt", { method: "POST", body: form });
}

async function withFs<T>(name: string, body: (fs: WorkspaceFs) => Promise<T>): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: UserAgentDO) =>
    body(new WorkspaceFs(instance.sqlForTest, "s1")),
  );
}

describe("multipart upload", () => {
  it("detects the content type", () => {
    const form = new FormData();
    form.set("turnId", "x");
    expect(isMultipart(multipartRequest(form))).toBe(true);
    expect(
      isMultipart(new Request("https://x/", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })),
    ).toBe(false);
  });

  it("writes plain parts into the workspace root", async () => {
    await withFs("plain", async fs => {
      const form = new FormData();
      form.set("turnId", "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01");
      form.set("text", "make a widget");
      form.append("file", new File(["<html>hi</html>"], "source.html", { type: "text/html" }));
      const parsed = await parseMultipartPrompt(multipartRequest(form), fs);

      expect(parsed.text).toBe("make a widget");
      expect(parsed.files).toEqual([{ name: "source.html", bytes: 15 }]);
      expect(await fs.readFile("/source.html")).toBe("<html>hi</html>");
    });
  });

  it("stores a gzipped part decoded, so later readers see real bytes", async () => {
    await withFs("gz", async fs => {
      const original = "<html>".repeat(2000);
      const form = new FormData();
      form.set("turnId", "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01");
      form.append(
        "file",
        new File([await gzip(original)], "source.html.gz", { type: "application/gzip" }),
      );
      const parsed = await parseMultipartPrompt(multipartRequest(form), fs);

      // The `.gz` suffix is dropped: the workspace holds the decoded file.
      expect(parsed.files[0]?.name).toBe("source.html");
      expect(await fs.readFile("/source.html")).toBe(original);
      // grep must see the real content, not a compressed blob.
      expect(fs.getAllPaths()).toContain("/source.html");
    });
  });

  it("accepts several parts in one body", async () => {
    await withFs("multi", async fs => {
      const form = new FormData();
      form.set("turnId", "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01");
      form.append("file", new File(["<html/>"], "source.html"));
      form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png"));
      const parsed = await parseMultipartPrompt(multipartRequest(form), fs);
      expect(parsed.files.map(f => f.name).sort()).toEqual(["screenshot.png", "source.html"]);
    });
  });

  it("strips directory components so an upload cannot escape the root", async () => {
    await withFs("escape", async fs => {
      const form = new FormData();
      form.set("turnId", "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01");
      form.append("file", new File(["x"], "../../etc/passwd"));
      form.append("file", new File(["y"], "sub/dir/evil.js"));
      await parseMultipartPrompt(multipartRequest(form), fs);

      const paths = fs.getAllPaths();
      expect(paths).toContain("/passwd");
      expect(paths).toContain("/evil.js");
      expect(paths.some(p => p.includes(".."))).toBe(false);
    });
  });
});
