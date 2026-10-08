/** Decode multipart input in memory; acceptance and workspace writes happen after validation. */
import { CAPTURE_LIMITS, CaptureError, parseCapture, type Capture } from '../capture.ts';
import { validateDomSnapshot } from '../dom-snapshot.ts';
import { validateCaptureImage } from './capture-image.ts';
import type { InputFile } from './store.ts';

export interface ParsedPrompt { turnId: string; text: string; since: number; files: InputFile[]; capture: Capture | null }
async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > CAPTURE_LIMITS.sourceBytes) throw new CaptureError('Decoded attachment exceeds 16 MiB', 413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; }
  return result;
}
function safeName(raw: string): string { return (raw.split('/').pop()?.split('\\').pop() ?? '').replace(/^\.+/, '').slice(0,120); }

export async function parseMultipartPrompt(request: Request | FormData): Promise<ParsedPrompt> {
  const form = request instanceof Request ? await request.formData() : request;
  const turnId = String(form.get('turnId') ?? ''), text = String(form.get('text') ?? ''), since = Number(form.get('since') ?? '0');
  let capture: Capture | null = null;
  if (form.has('capture')) {
    try { capture = parseCapture(JSON.parse(String(form.get('capture')))); }
    catch (error) { if (error instanceof CaptureError) throw error; throw new CaptureError('Invalid capture JSON'); }
  }
  const files: InputFile[] = []; let total = 0;
  for (const entry of form.getAll('file')) {
    if (typeof entry === 'string') continue;
    const name = safeName(entry.name); if (!name) continue;
    const gzipped = name.endsWith('.gz') || entry.type === 'application/gzip';
    const raw = await entry.arrayBuffer();
    if (raw.byteLength > CAPTURE_LIMITS.sourceBytes) throw new CaptureError('Attachment exceeds 16 MiB',413);
    const data = gzipped ? await gunzip(raw) : new Uint8Array(raw);
    const storedName = gzipped && name.endsWith('.gz') ? name.slice(0,-3) : name;
    if (storedName === 'capture-source.json') throw new CaptureError('Reserved capture source metadata filename');
    if (files.some(file => file.name === storedName)) throw new CaptureError('Duplicate uploaded filename');
    total += data.length;
    if (total > 24 * 1024 * 1024) throw new CaptureError('Attachments exceed 24 MiB',413);
    files.push({name: storedName,data});
  }
  if (files.some(file => file.name === 'source.dom.json') && capture?.version !== 2) throw new CaptureError('source.dom.json requires capture v2');
  if (capture) {
    if (!files.some(file => file.name === capture.source)) throw new CaptureError('Capture source.html is missing');
    if (capture.version === 2) {
      const dom = files.find(file => file.name === capture.dom);
      if (!dom) throw new CaptureError('Capture source.dom.json is missing');
      try { await validateDomSnapshot(new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(files.find(file => file.name === capture.source)!.data), new TextDecoder('utf-8', {fatal:true,ignoreBOM:false}).decode(dom.data)); }
      catch (error) { throw new CaptureError(`Invalid capture DOM: ${String(error)}`); }
    }
    for (const image of capture.images) {
      const file = files.find(file => file.name === image.file);
      if (!file) throw new CaptureError('Capture image is missing');
      validateCaptureImage(file.data,image);
    }
  }
  return {turnId,text,since:Number.isFinite(since)?since:0,files,capture};
}
export function isMultipart(request: Request): boolean { return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data'); }
