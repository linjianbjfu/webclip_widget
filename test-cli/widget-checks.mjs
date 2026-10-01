/** Opt-in real-model checks; requires a running Worker with Browser Run. */
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "./client.mjs";
import { saveArtifacts } from "./artifacts.mjs";
import { parseWidgetMeta } from "../backend/src/widget-contract.ts";

const { WEBCLIP_URL: baseUrl, WEBCLIP_TOKEN: token } = process.env;
if (!baseUrl || !token) throw new Error("WEBCLIP_URL and WEBCLIP_TOKEN must be set");
const client = new Client({ baseUrl, token, userId: process.env.WEBCLIP_USER ?? "widget-checks" });
const fixture = fileURLToPath(new URL('./fixtures/widget-source.html', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "webclip-widget-check-"));
const source = join(directory, "source.html");
await copyFile(fixture, source);
const cases = [
  ["small", "用小号 widget 显示本月故障数。"],
  ["middle", "用中号 widget 显示故障数和运行设备数。"],
  ["large", "用大号 widget 显示完整的12台设备的名称与运行时长列表，缺值如实标出。"],
  ["small", "做一个 widget，只显示本月故障数。"],
  ["large", "做一个 widget，显示完整的12台设备的名称与运行时长列表，缺值如实标出。"],
];
try {
  for (const [index, [size, text]] of cases.entries()) {
    const created = await client.createSession(`widget check ${index + 1}`);
    if (created.status !== 201) throw new Error(`createSession: ${created.status}`);
    const sessionId = created.body.sessionId;
    try {
      console.log(`Case ${index + 1}/${cases.length}: expected ${size}`);
      const result = await client.prompt({ sessionId, text, files: [source], onFrame: frame => {
        if (frame.event === 'tool_end') console.log(`  ${frame.data.name}: ${frame.data.isError ? 'error' : 'ok'}`);
      } });
      const end = result.frames.find(frame => frame.event === 'turn_end' && frame.data.turnId === result.turnId);
      if (end?.data.reason !== 'completed') throw new Error(`turn did not complete: ${end?.data.reason}`);
      const folder = await saveArtifacts({ sessionId, out: end.data.out });
      const meta = parseWidgetMeta(end.data.out.find(file => file.path === 'out/meta.json').content);
      if (meta.size !== size) throw new Error(`expected ${size}, received ${meta.size}: ${folder}`);
      const previews = result.frames.filter(frame => frame.event === 'entry' && frame.data?.type === 'message'
        && frame.data.message?.role === 'toolResult' && frame.data.message?.toolName === 'preview_widget');
      const lastPreview = previews.at(-1)?.data.message;
      if (!lastPreview || lastPreview.isError || lastPreview.details?.valid !== true) {
        const error = lastPreview?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
        throw new Error(`No successful final Browser Run preview: ${error ?? 'missing preview'}; ${folder}`);
      }
      console.log(`PASS ${size}: ${folder}`);
    } finally {
      await client.deleteSession(sessionId);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
