/** Decode claimed screenshots before accepting their dimensions and MIME type. */
import { Buffer } from 'node:buffer';
import { decode } from 'fast-png';
import jpeg from 'jpeg-js';
import { CAPTURE_LIMITS, CaptureError, type CaptureImage } from '../capture.ts';

export function validateCaptureImage(data: Uint8Array, image: CaptureImage): void {
  if (data.length > CAPTURE_LIMITS.imageBytes || data.length !== image.bytes) throw new CaptureError('Screenshot byte limit or metadata mismatch', 413);
  const bytes = Buffer.from(data);
  let width = 0, height = 0, mimeType = '';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 33) {
    mimeType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) throw new CaptureError('Malformed JPEG');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new CaptureError('Malformed JPEG');
      if ([192,193,194].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset+3); width = bytes.readUInt16BE(offset+5); break; }
      offset += length;
    }
  }
  const max = image.role === 'full-page' ? 768 : 1200;
  if (!width || !height || width > max || height > max) throw new CaptureError('Screenshot dimensions exceed limit or invalid image', 413);
  if (mimeType !== image.mimeType || width !== image.width || height !== image.height) throw new CaptureError('Screenshot MIME/dimensions mismatch');
  try {
    const decoded = mimeType === 'image/png' ? decode(bytes, {checkCrc: true}) : jpeg.decode(bytes, {maxResolutionInMP: 2, maxMemoryUsageInMB: 32, tolerantDecoding: false});
    if (decoded.width !== width || decoded.height !== height) throw new Error('dimensions');
  } catch { throw new CaptureError('Screenshot cannot be decoded'); }
}
