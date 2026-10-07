/** Limits apply per extraction result; lengths include the data URI prefix. */
export const IMAGE_LIMITS = { count: 3, longestSide: 512, perImageChars: 180_000, totalChars: 360_000 };

export const IMAGE_POLICY = `Autonomously select relevant images from the requested region when they improve
the design. Return image content in data.json as PNG/JPEG/WebP base64 data URIs or null, never
remote display URLs. Do not freeze business images into widget.html. Keep image fields paired
with their records. Use at most ${IMAGE_LIMITS.count} images, ${IMAGE_LIMITS.perImageChars} characters per URI and ${IMAGE_LIMITS.totalChars} total URI characters.
For loaded img elements, use a detached canvas to resize the longest side to at most ${IMAGE_LIMITS.longestSide}px;
never upscale. Existing raster data URIs may be copied within the character budgets without
decoding in the inert preview. Never read source canvas elements, use OCR, modify the page,
change img.crossOrigin/src, fetch images or wait asynchronously. Canvas export can fail for
cross-origin images; handle each optional image as null, without a remote URL fallback.
The inert source.html preview cannot load remote images; verify loaded-image conversion on
the live page. In widget.html accept only raster base64 data URIs, attach an error handler
before assigning src, and remove/hide broken optional images. Wait for current images before
screenshotting. Do not embed animated media. The helper below is source to embed inside
extra.js's IIFE, not a host API; create it once per extraction and call it only for selected img elements.`;

/** Self-contained browser code supplied to the generator and exercised in browser tests. */
export const IMAGE_EXTRACTOR = `function createImageExtractor() {
  let count = 0, total = 0;
  return function extractImage(img) {
    if (!img || img.localName !== 'img' || count >= ${IMAGE_LIMITS.count}) return null;
    try {
      let value = img.currentSrc || img.getAttribute('src') || '';
      const raster = /^data:image\\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
      if (!raster.test(value)) {
        if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
        const scale = Math.min(1, ${IMAGE_LIMITS.longestSide} / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        value = canvas.toDataURL('image/png');
      }
      if (!raster.test(value) || value.length > ${IMAGE_LIMITS.perImageChars} || total + value.length > ${IMAGE_LIMITS.totalChars}) return null;
      const bytes = atob(value.slice(value.indexOf(',') + 1));
      const png = value.startsWith('data:image/png;') && bytes.startsWith('\\x89PNG\\r\\n\\x1a\\n');
      const jpeg = value.startsWith('data:image/jpeg;') && bytes.startsWith('\\xff\\xd8\\xff');
      const webp = value.startsWith('data:image/webp;') && bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
      if (!png && !jpeg && !webp) return null;
      count++; total += value.length;
      return value;
    } catch { return null; }
  };
}`;
