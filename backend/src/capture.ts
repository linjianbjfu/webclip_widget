/** Versioned capture metadata shared with CLI and future native clients. */
export const CAPTURE_LIMITS = { regions: 8, imageBytes: 2 * 1024 * 1024, sourceBytes: 16 * 1024 * 1024, metadataBytes: 64 * 1024, pageSide: 768, montageSide: 1200 } as const;
export interface Rect { x: number; y: number; width: number; height: number }
export interface CaptureRegion {
  id: string; xpath: string; rect: Rect; text: string;
  sourceXPath?: string; imageId?: string; imageRect?: Rect;
}
export interface CaptureImage {
  id: string; file: string; width: number; height: number; originalWidth: number; originalHeight: number;
  mimeType: 'image/png' | 'image/jpeg'; bytes: number; role: 'montage' | 'full-page';
}
export interface Capture {
  version: 1 | 2; dom?: 'source.dom.json'; mode: 'regions' | 'page'; source: 'source.html';
  requestUrl?: string; pageUrl?: string; baseUrl?: string;
  viewport: { width: number; height: number };
  regions: CaptureRegion[]; images: CaptureImage[];
}
export class CaptureError extends Error {
  readonly status: 400 | 413;
  constructor(message: string, status: 400 | 413 = 400) { super(message); this.status = status; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureError('Expected capture object');
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new CaptureError('Invalid capture text');
  return value;
}
function dimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000_000) throw new CaptureError('Invalid capture dimensions');
  return value;
}
function rectangle(value: unknown): Rect {
  const r = object(value);
  if (typeof r.x !== 'number' || typeof r.y !== 'number' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || r.x < 0 || r.y < 0) throw new CaptureError('Invalid capture coordinates');
  return { x: r.x, y: r.y, width: dimension(r.width), height: dimension(r.height) };
}
export function parseCapture(value: unknown): Capture {
  if (new TextEncoder().encode(JSON.stringify(value)).length > CAPTURE_LIMITS.metadataBytes) throw new CaptureError('Capture metadata too large', 413);
  const c = object(value), v = object(c.viewport);
  if ((c.version !== 1 && c.version !== 2) || !['regions', 'page'].includes(String(c.mode)) || c.source !== 'source.html') throw new CaptureError('Unsupported capture version, mode or source');
  if (c.version === 2 ? c.dom !== 'source.dom.json' : c.dom !== undefined) throw new CaptureError('Invalid capture DOM companion');
  if (!Array.isArray(c.regions) || !Array.isArray(c.images) || c.regions.length > 8 || c.images.length > 1) throw new CaptureError('Capture allows at most 8 regions and one image');
  const images: CaptureImage[] = c.images.map(raw => {
    const i = object(raw);
    if (!['montage','full-page'].includes(String(i.role)) || !['image/png','image/jpeg'].includes(String(i.mimeType))) throw new CaptureError('Invalid capture image format/role');
    const file = string(i.file, 120);
    if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g)$/.test(file)) throw new CaptureError('Invalid capture image filename');
    const width = dimension(i.width), height = dimension(i.height), bytes = dimension(i.bytes);
    const cap = c.mode === 'page' ? 768 : 1200;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width > cap || height > cap || bytes > CAPTURE_LIMITS.imageBytes) throw new CaptureError('Capture image exceeds pixel/byte budget', 413);
    return { id: string(i.id, 40), file, width, height, bytes, originalWidth: dimension(i.originalWidth), originalHeight: dimension(i.originalHeight), mimeType: i.mimeType as CaptureImage['mimeType'], role: i.role as CaptureImage['role'] };
  });
  const ids = new Set<string>();
  const regions: CaptureRegion[] = c.regions.map(raw => {
    const r = object(raw), id = string(r.id, 40);
    if (!/^r[1-9][0-9]*$/.test(id) || ids.has(id)) throw new CaptureError('Invalid/duplicate region id');
    ids.add(id);
    const region: CaptureRegion = { id, xpath: string(r.xpath, 4096), rect: rectangle(r.rect), text: typeof r.text === 'string' && r.text.length <= 4000 ? r.text : (() => { throw new CaptureError('Invalid region text'); })() };
    if (r.sourceXPath !== undefined) region.sourceXPath = string(r.sourceXPath, 4096);
    if (r.imageId !== undefined || r.imageRect !== undefined) {
      const image = images[0], rect = rectangle(r.imageRect);
      if (!image || r.imageId !== image.id || rect.x + rect.width > image.width || rect.y + rect.height > image.height) throw new CaptureError('Region image reference/bounds mismatch');
      region.imageId = image.id; region.imageRect = rect;
    }
    if (!region.imageId && !region.text.trim()) throw new CaptureError('Text-only region requires text');
    return region;
  });
  if (c.mode === 'page' ? regions.length !== 0 || images.length !== 1 || images[0]?.role !== 'full-page'
    : regions.length === 0 || (images.length === 1 && (images[0]?.role !== 'montage' || !regions.some(r => r.imageId)))) throw new CaptureError('Capture mode does not match regions/images');
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i]?.imageRect, b = regions[j]?.imageRect;
    if (a && b && a.x < b.x+b.width && b.x < a.x+a.width && a.y < b.y+b.height && b.y < a.y+a.height) throw new CaptureError('Montage content rectangles overlap');
  }
  const capture: Capture = { version: c.version as 1 | 2, ...(c.version === 2 ? {dom: 'source.dom.json' as const} : {}), mode: c.mode as Capture['mode'], source: 'source.html', viewport: { width: dimension(v.width), height: dimension(v.height) }, regions, images };
  for (const name of ['requestUrl','pageUrl','baseUrl'] as const) if (c[name] !== undefined) {
    const url = string(c[name], 8192);
    try { if (!['http:','https:'].includes(new URL(url).protocol)) throw new Error(); } catch { throw new CaptureError('Capture URLs must use HTTP/HTTPS'); }
    capture[name] = url;
  }
  return capture;
}
