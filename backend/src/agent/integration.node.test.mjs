import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWidgetResourceLoader } from "./widget-resources.ts";
import { createBriefProvider } from "./brief.ts";
import { createPreviewTool } from "./preview.ts";
import { createWorkspaceOperations } from "./operations.ts";

test('the real SDK resource loader exposes the widget system prompt', async () => {
  const ctx = { workspaceRoot: '/', outDir: '/out', sessionId: 'test' };
  const resources = await createWidgetResourceLoader(ctx);
  assert.equal(resources.getSystemPrompt(), createBriefProvider().system(ctx));
  assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
});

test('real SDK read and edit tools preserve UTF-8 workspace text', async () => {
  let text = '<p>故障数：0</p>';
  const fs = {
    exists: async () => true,
    readFileBuffer: async () => new TextEncoder().encode(text),
    writeFile: async (_path, content) => { text = content; },
  };
  const ops = createWorkspaceOperations(fs, undefined);
  const read = createReadToolDefinition('/', { operations: ops.read });
  const result = await read.execute('read', { path: '/source.html' });
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes(text)));
  const edit = createEditToolDefinition('/', { operations: ops.edit });
  await edit.execute('edit', { path: '/source.html', edits: [{ oldText: '故障数：0', newText: '故障数：1' }] });
  assert.equal(text, '<p>故障数：1</p>');
});

test('preview rejects invalid bundles through the SDK error channel before launching a browser', async () => {
  const tool = createPreviewTool({}, { readdirWithFileTypes: async () => [] });
  await assert.rejects(tool.execute('preview', {}), /preview failed:.*exactly/);
});
