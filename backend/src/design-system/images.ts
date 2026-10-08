/** Limits apply per extraction result; lengths include the data URI prefix. */
export const IMAGE_LIMITS = { count: 3, longestSide: 512, perImageChars: 180_000, totalChars: 360_000, fetchBytes: 2_097_152, fetchTimeoutMs: 3_000 };

export const IMAGE_POLICY = `Extract selected source images as PNG/JPEG/WebP base64 data URIs or null
in data.json, paired with their records. Never use remote display URLs or freeze business images
into widget.html: widget requests may lose the source's hotlink/referrer authorization.
For HTTP(S) currentSrc/src, fetch original bytes with mode cors, credentials omit, cache force-cache;
encode the bytes, not the URL. Prefer unchanged raster bytes within the URI budgets. Use the helper
below inside an async IIFE, create one extractor, and await each selected image before returning data.
Process at most ${IMAGE_LIMITS.count} images; each request has a ${IMAGE_LIMITS.fetchTimeoutMs}ms deadline and ${IMAGE_LIMITS.fetchBytes}-byte body limit.
Use at most ${IMAGE_LIMITS.perImageChars} characters per URI and ${IMAGE_LIMITS.totalChars} total. Oversized readable images may be resized
with a detached canvas to at most ${IMAGE_LIMITS.longestSide}px on the longest side, never upscaled.
Reuse valid existing raster data URIs within budgets. If fetch fails, a loaded, readable img may be
converted with canvas; otherwise return null without a URL fallback. Fetch still obeys CORS and CSP;
a visible cross-origin img can taint canvas even when a separate CORS fetch is permitted.
Never read source canvas elements, use OCR, modify the page, change img.crossOrigin/src or fetch
unrelated URLs. Do not embed animated media. The inert source.html document must not fetch images:
null there does not prove the source has no image. Retain suitable image extraction and layout with
a readable fallback; verify on the live page. Distinguish candidates, successful extraction and
unverified/failed reads in the final reply. A text-only preview is not successful image validation.
In widget.html accept only raster base64 data URIs, attach an error handler before assigning src,
and remove/hide broken optional images. Wait for images before screenshots.
This helper is source to embed in extra.js, not a host API.`;

/** Self-contained browser code supplied to the generator and exercised in browser tests. */
export const IMAGE_EXTRACTOR = String.raw`function createImageExtractor() {
  let count = 0, total = 0;
  const raster = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  function valid(value) {
    if (!raster.test(value)) return false;
    const bytes = atob(value.slice(value.indexOf(',') + 1));
    return (value.startsWith('data:image/png;') && bytes.startsWith('\x89PNG\r\n\x1a\n')) ||
      (value.startsWith('data:image/jpeg;') && bytes.startsWith('\xff\xd8\xff')) ||
      (value.startsWith('data:image/webp;') && bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP');
  }
  function fits(value) {
    return value.length <= ${IMAGE_LIMITS.perImageChars} && total + value.length <= ${IMAGE_LIMITS.totalChars};
  }
  function resize(image, width, height) {
    const scale = Math.min(1, ${IMAGE_LIMITS.longestSide} / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    return fits(png) ? png : canvas.toDataURL('image/webp', 0.8);
  }
  async function fetchImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${IMAGE_LIMITS.fetchTimeoutMs});
    try {
      const response = await fetch(url, {mode:'cors', credentials:'omit', cache:'force-cache', signal:controller.signal});
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !['image/png','image/jpeg','image/webp'].includes(type) || !response.body ||
          Number(response.headers.get('content-length')) > ${IMAGE_LIMITS.fetchBytes}) return null;
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          length += value.length;
          if (length > ${IMAGE_LIMITS.fetchBytes}) return null;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const value = 'data:' + type + ';base64,' + btoa(binary);
      if (!valid(value)) return null;
      if (fits(value)) return value;
      const bitmap = await createImageBitmap(new Blob([bytes], {type}));
      try { return resize(bitmap, bitmap.width, bitmap.height); }
      finally { bitmap.close(); }
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return async function extractImage(img) {
    if (!img || img.localName !== 'img' || count >= ${IMAGE_LIMITS.count}) return null;
    count++;
    try {
      let value = img.currentSrc || img.getAttribute('src') || '';
      if (!value) return null;
      if (!raster.test(value)) {
        if (!document.defaultView) return null;
        const url = new URL(value, img.baseURI);
        value = null;
        if (['http:', 'https:'].includes(url.protocol)) {
          try { value = await fetchImage(url.href); } catch {}
        }
        if (!value && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
          value = resize(img, img.naturalWidth, img.naturalHeight);
        }
      }
      if (!value || !fits(value) || !valid(value)) return null;
      total += value.length;
      return value;
    } catch { return null; }
  };
}`;
