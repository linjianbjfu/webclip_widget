import type { Component } from "../types.ts";

export const COMPONENTS: Component[] = [
  { id: "hero", guidance: "One dominant value or short headline with a concise label. Keep units adjacent but quieter. Preserve zero; distinguish unavailable from zero." },
  { id: "row", guidance: "Align repeated labels and values on shared columns. Keep item order and identity. Use whitespace or a subtle divider; avoid boxing every row. Truncate only secondary text." },
  { id: "status", guidance: "Pair a short status label with a restrained semantic dot, icon or accent. Meaning must remain readable without color. No action-button appearance." },
  { id: "progress", guidance: "Use a static thin bar or compact ring with a visible value. Require a positive observed target; show the actual value even when the drawn ratio is bounded. Missing targets need text, not a guessed percentage." },
  { id: "trend", guidance: "Draw an inline SVG line or bars from observed data only. Keep it subordinate to the primary value, preserve gaps and temporal order, and avoid invented interpolation or misleading scales. Label the period and units." },
  { id: "image", guidance: "Use a relevant source image as a supporting thumbnail, portrait or balanced side panel. Choose contain when cropping would lose information. A background needs a quiet text area and sufficient contrast. Validate raster data URIs, hide/remove failed optional images, and never load remote image URLs." },
  { id: "divider", guidance: "A single quiet line can separate distinct groups. Prefer spacing within a group; do not draw a grid around every field." },
];
