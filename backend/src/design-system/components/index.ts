import type { Component } from "../types.ts";

export const COMPONENTS: Component[] = [
  { id: "hero", guidance: "One dominant value or short headline with a concise label. Keep units adjacent but quieter. Allow enough line height for font glyphs, including in text-only layouts; fix tight line boxes by adding vertical room rather than shrinking text. Preserve zero; distinguish unavailable from zero." },
  { id: "row", guidance: "Align repeated labels and values on shared columns. Keep the selected items in source order with recognizable names at body size; caption is only for short auxiliary labels. Use whitespace or a subtle divider; avoid boxing every row. Truncate only secondary text." },
  { id: "status", guidance: "Pair a short status label with a restrained semantic dot, icon or accent. Meaning must remain readable without color. No action-button appearance." },
  { id: "progress", guidance: "Prefer a static bar or ring as the focus when completion is the main information; keep the value and target readable. Require a positive observed target; show the actual value even when the drawn ratio is bounded. Missing targets need text, not a guessed percentage." },
  { id: "trend", guidance: "Draw an inline SVG line or bars from observed data only. Let the chart lead when change is the main information, keep the current value readable, preserve gaps and temporal order, and avoid invented interpolation or misleading scales. Label the period and units." },
  { id: "image", guidance: "Choose a leading or supporting role according to what the source image communicates. Allocate enough area for its useful detail to remain recognizable; keep identifying text and key values readable. Choose contain when cropping would lose information. A background needs a quiet text area and sufficient contrast. Validate raster data URIs, hide/remove failed optional images, and never load remote image URLs." },
  { id: "divider", guidance: "A single quiet line can separate distinct groups. Prefer spacing within a group; do not draw a grid around every field." },
];
