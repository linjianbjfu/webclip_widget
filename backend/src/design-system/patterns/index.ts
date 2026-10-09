import type { Pattern } from "../types.ts";

export const PATTERNS: Pattern[] = [
  {
    id: "hero-metric", summary: "One dominant value or concise status with supporting context.",
    requires: "An observed primary value or status; secondary fields are optional.",
    guidance: "Give the primary information most visual weight. Use a short label and at most a small supporting group; preserve space around the focal point.",
    components: ["hero", "status", "image"], examples: ["image-balance", "quiet-cards"],
    sizes: { small: "Value and label, with one short secondary line if it fits.", middle: "One focus with two or three supporting facts or a relevant leading image.", large: "One focus with a few quiet detail groups; avoid enlarging empty decorations." },
  },
  {
    id: "metric-chart", summary: "Current value with a real historical series or comparison.",
    requires: "Observed ordered samples and their units; a lone current value is insufficient for a trend.",
    guidance: "Prefer a readable chart as the focus when the series explains the main information, with current value, period and scale context. If the required series is absent, use a metric layout and state the missing history.",
    components: ["hero", "trend", "row"], examples: ["quiet-trend", "progress-and-history"],
    sizes: { small: "Primary value and a compact series only if legible.", middle: "Metric beside chart, or metric header above a shallow chart.", large: "Metric header, readable chart, and a small aligned detail group." },
  },
  {
    id: "status-progress", summary: "A current state, target, or ongoing process.",
    requires: "Observed status; a graphical completion ratio additionally needs an observed positive target.",
    guidance: "Make status immediately readable. Prefer a progress graphic as the focus when a real value and target support it; keep both readable and ETA secondary. No fake controls or ticking countdowns.",
    components: ["hero", "status", "progress", "row"], examples: ["progress-and-history", "image-balance"],
    sizes: { small: "Status with a short supporting line or ring.", middle: "One status/progress focus with two or three short supporting facts.", large: "Primary status followed by distinct, quiet detail groups." },
  },
  {
    id: "list", summary: "Several comparable items, headlines, or events to scan.",
    requires: "Observed ordered records with identity and requested fields.",
    guidance: "Use a compact heading and aligned rows; give usable height to records before decorative header rows. Choose capacity from body line height, wrapped titles and image needs, not a preset record count. For text lists, extra.js should return a bounded set of relevant candidates sufficient for layout, without pre-slicing to the display count. In renderWidget, fit an ordered prefix of complete rows to the available height at the chosen font size; synchronous bounded layout measurement can adapt to current title lengths. Give the available height to content without reserving space for selection or coverage notices. Compact headings, padding and row gaps when needed while preserving readable type and necessary breathing room. Never hide overflowing titles, shrink text or stretch gaps to mask omitted records. Honor explicit count/full-content requests. Useful source images retain their role and existing extraction budgets.",
    components: ["row", "status", "divider", "image"], examples: ["quiet-cards"],
    sizes: { small: "A compact heading and the complete records that fit at body size; long titles or images need more room.", middle: "Use the shallow height efficiently with a compact heading and clear reading order; account for wrapped titles and images.", large: "Use the available height for relevant records with consistent readable spacing. Add records when room remains; adapt the count when titles wrap or images need space." },
  },
  {
    id: "image-text", summary: "Content with a relevant image that improves recognition or composition.",
    requires: "A relevant source image or provided static asset; image absence must leave a readable text layout.",
    guidance: "Choose the image's role from the source meaning and the user's purpose. Use a leading image, supporting panel or a few image-text items as space allows. Keep useful image detail recognizable and essential text readable; omit redundant metadata. Never substitute a captured screenshot containing stale values.",
    components: ["hero", "image", "row"], examples: ["image-balance", "quiet-cards"],
    sizes: { small: "One image-led focus with a short title/value and at most one or two short supporting facts.", middle: "Balanced text and image side by side, with a clear primary focus.", large: "One leading image with headline and a few supporting groups, or selected image-led rows." },
  },
  {
    id: "freeform", summary: "Content that needs a composition outside the listed patterns.",
    requires: "Observed content and a clear primary information need.",
    guidance: "Compose the applicable primitives around one visual focus. Use the same defaults and data constraints; the catalog is not a whitelist of supported subjects. Add graphs only when their data exists.",
    components: ["hero", "row", "status", "divider", "progress", "trend", "image"], examples: ["quiet-cards", "image-balance"],
    sizes: { small: "One primary focus and at most one or two short supporting facts.", middle: "One primary focus with two or three supporting facts in a clear reading order.", large: "One primary focus with a few supporting groups, not a miniature desktop dashboard." },
  },
];
