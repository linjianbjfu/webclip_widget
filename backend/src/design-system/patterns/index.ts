import type { Pattern } from "../types.ts";

export const PATTERNS: Pattern[] = [
  {
    id: "hero-metric", summary: "One dominant value or concise status with supporting context.",
    requires: "An observed primary value or status; secondary fields are optional.",
    guidance: "Give the primary information most visual weight. Use a short label and at most a small supporting group; preserve space around the focal point.",
    components: ["hero", "status", "image"], examples: ["image-balance", "quiet-cards"],
    sizes: { small: "Value and label, with one short secondary line if it fits.", middle: "Primary block beside supporting context or one relevant image.", large: "Primary block above requested detail; avoid enlarging empty decorations." },
  },
  {
    id: "metric-chart", summary: "Current value with a real historical series or comparison.",
    requires: "Observed ordered samples and their units; a lone current value is insufficient for a trend.",
    guidance: "Lead with the current metric. Let a quieter chart explain the series, with period and scale context. If the required series is absent, use a metric layout and state the missing history.",
    components: ["hero", "trend", "row"], examples: ["quiet-trend", "progress-and-history"],
    sizes: { small: "Primary value and a compact series only if legible.", middle: "Metric beside chart, or metric header above a shallow chart.", large: "Metric header, readable chart, and a small aligned detail group." },
  },
  {
    id: "status-progress", summary: "A current state, target, or ongoing process.",
    requires: "Observed status; a graphical completion ratio additionally needs an observed positive target.",
    guidance: "Make status immediately readable. Add one compact progress graphic only when supported by data; ETA and supporting values remain secondary. No fake controls or ticking countdowns.",
    components: ["hero", "status", "progress", "row"], examples: ["progress-and-history", "image-balance"],
    sizes: { small: "Status with a short supporting line or ring.", middle: "Status and a compact progress section with aligned details.", large: "Primary status followed by distinct, quiet detail groups." },
  },
  {
    id: "list", summary: "Several comparable items, headlines, or events to scan.",
    requires: "Observed ordered records with identity and requested fields.",
    guidance: "Use a compact heading and aligned rows. Keep requested records visible without tiny text. Images are optional small anchors, not repeated large cards. Respect explicit size and report content limits.",
    components: ["row", "status", "divider", "image"], examples: ["quiet-cards"],
    sizes: { small: "A very short list with minimal secondary fields.", middle: "A few short rows or two aligned columns when the reading order is clear.", large: "A longer list with steady row rhythm; reserve space for the full requested content." },
  },
  {
    id: "image-text", summary: "Content with a relevant image that improves recognition or composition.",
    requires: "A relevant source image or provided static asset; image absence must leave a readable text layout.",
    guidance: "Select imagery autonomously from the requested region. Give text and image distinct roles; avoid busy backgrounds, tiny thumbnails and meaningless decoration. Never substitute a captured screenshot containing stale values.",
    components: ["hero", "image", "row"], examples: ["image-balance", "quiet-cards"],
    sizes: { small: "Short title/value with one compact image; text wins when space is tight.", middle: "Balanced text and image side by side, with a clear primary focus.", large: "One leading image with headline and requested detail, or restrained image-led rows." },
  },
  {
    id: "freeform", summary: "Content that needs a composition outside the listed patterns.",
    requires: "Observed content and a clear primary information need.",
    guidance: "Compose the applicable primitives around one visual focus. Use the same defaults and data constraints; the catalog is not a whitelist of supported subjects. Add graphs only when their data exists.",
    components: ["hero", "row", "status", "divider", "progress", "trend", "image"], examples: ["quiet-cards", "image-balance"],
    sizes: { small: "One primary focus and essential context.", middle: "One or two related groups with a clear reading order.", large: "A primary group with secondary sections, not a miniature desktop dashboard." },
  },
];
