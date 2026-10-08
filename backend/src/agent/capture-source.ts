/** Associates the workspace source with the declaration from its accepted input turn. */
import { parseCapture, type Capture } from '../capture.ts';
import { validateDomSnapshot } from '../dom-snapshot.ts';
import type { WorkspaceFs } from '../fs/workspace-fs.ts';
import type { InputFile } from '../do/store.ts';

const DECLARATION = '/capture-source.json';

/** A text-only follow-up keeps its source; replacing source.html invalidates the previous pair. */
export async function applyCaptureInput(fs: WorkspaceFs, files: InputFile[], capture: Capture | null): Promise<void> {
  const replacesSource = files.some(file => file.name === 'source.html');
  if (replacesSource) {
    await fs.rm(DECLARATION, { force: true });
    await fs.rm('/source.dom.json', { force: true });
  }
  for (const file of files) await fs.writeFile(`/${file.name}`, file.data);
  if (replacesSource && capture) await fs.writeFile(DECLARATION, JSON.stringify(capture));
}

/** Only an accepted v2 declaration enables reconstruction; a broken pair never becomes legacy HTML. */
export async function readCaptureSource(fs: Pick<WorkspaceFs, 'readFile' | 'readFileBuffer' | 'exists'>): Promise<{source: string; dom?: string}> {
  let source = await fs.readFile('/source.html');
  if (!(await fs.exists(DECLARATION))) return {source};
  const capture = parseCapture(JSON.parse(await fs.readFile(DECLARATION)));
  if (capture.version === 1) return {source};
  source = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(await fs.readFileBuffer('/source.html'));
  const dom = await fs.readFile('/source.dom.json');
  await validateDomSnapshot(source, dom);
  return {source, dom};
}
