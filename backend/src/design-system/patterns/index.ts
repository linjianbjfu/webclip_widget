import type { Pattern } from "../types.ts";

export const PATTERNS: Pattern[] = [
  {
    id: "hero-metric", summary: "One dominant value or concise status with supporting context.",
    requires: "An observed primary value or status; secondary fields are optional.",
    guidance: "Give the primary information most visual weight. Use a short label and at most a small supporting group, optionally on a muted inset surface; preserve space around the focal point.",
    components: ["group", "hero", "status", "image"], examples: ["app-usage", "meeting-details"],
    sizes: { small: "Value and label, with one short secondary line if it fits.", middle: "One focus with two or three supporting facts or a relevant leading image.", large: "One focus with a few quiet detail groups; avoid enlarging empty decorations." },
  },
  {
    id: "metric-chart", summary: "Current value with a real historical series or comparison.",
    requires: "Observed ordered samples and their units; a lone current value is insufficient for a trend.",
    guidance: "Prefer a readable chart as the focus when the series explains the main information, with current value, period and scale context. If the required series is absent, use a metric layout and state the missing history.",
    components: ["group", "hero", "trend", "row"], examples: ["quiet-trend", "progress-and-history"],
    sizes: { small: "Primary value and a compact series only if legible.", middle: "Metric beside chart, or metric header above a shallow chart.", large: "Metric header, readable chart, and a small aligned detail group." },
  },
  {
    id: "status-progress", summary: "A current state, target, or ongoing process.",
    requires: "Observed status; a graphical completion ratio additionally needs an observed positive target.",
    guidance: "Make status immediately readable. Prefer a progress graphic as the focus when a real value and target support it; keep both readable and ETA secondary. No fake controls or ticking countdowns.",
    components: ["group", "hero", "status", "progress", "row"], examples: ["progress-and-history", "image-balance"],
    sizes: { small: "Status with a short supporting line or ring.", middle: "One status/progress focus with two or three short supporting facts.", large: "Primary status followed by distinct, quiet detail groups." },
  },
  {
    id: "list", summary: "Several comparable items, headlines, or events to scan.",
    requires: "Observed ordered records with identity and requested fields.",
    guidance: "Use a compact heading and aligned record groups; give usable height to records before decorative header rows. Choose columns after reserving recognizable imagery and breathing room; short names alone do not justify a dense multi-column icon grid. For paired entities, prefer stacked name/value lines inside the record over names at opposite canvas edges with detached values in the center. Read peers left-to-right then top-to-bottom in source order. Re-evaluate column widths and wrapping on every render with current names and values; never fix name or value widths from captured short strings; allow changed digit counts and units. Prefer a single column when names or context need width; never force two columns at the expense of readable fields or explicit content requirements. Choose capacity from current text, recognizable image area and clear group spacing, not a preset record or icon count. For text and image lists, extra.js returns bounded relevant record candidates independently of the guessed display count. Image read budgets do not limit text records. In renderWidget, measure an ordered prefix of complete record groups including image height and group gaps on every render; fit against actual space, not just text height or captured labels. Give the available height to content without reserving space for selection or coverage notices. Compact headings, padding and row gaps when needed while preserving readable type and necessary breathing room. Never hide overflowing titles, shrink text or stretch gaps to mask omitted records. Compose image-bearing records around recognizable source artwork, with compact supporting names and metadata; do not preserve a text-only record count by making useful images tiny. Keep paired entities together when selecting image-bearing records. Explicit all-record requests allow omitting auxiliary icons, but explicit all-image requests do not. Collect image candidates in record order and use the bounded batch helper. Keep decoration out of the record budget.",
    components: ["group", "row", "status", "divider", "image"], examples: ["paired-routines", "quiet-cards"],
    sizes: { small: "A compact heading and the complete records that fit at body size; long titles or images need more room.", middle: "Use the shallow height efficiently with a compact heading and clear reading order; account for wrapped titles and images.", large: "Use the available height for relevant records with consistent readable spacing. Add records only when images remain recognizable and groups distinct; adapt to current text and imagery." },
  },
  {
    id: "image-text", summary: "Content with a relevant image that improves recognition or composition.",
    requires: "A relevant source image or provided static asset; image absence must leave a readable text layout.",
    guidance: "Choose the image's role from the source meaning and the user's purpose. Allocate the largest useful image area that preserves essential information, and build the text hierarchy around it. An image-led choice should visibly change the composition, not add a thumbnail to an otherwise dominant text panel. Use a leading image, supporting panel, image-text items or a whole/partial image background as the source meaning and space allow. A soft background crop can sit beside opaque text on the main surface; it need not become a separate photo card. Keep useful image detail recognizable and essential text readable; omit redundant metadata. Repeated images need clear separation; reduce optional complete groups before making images tiny or crowding them. Never substitute a captured screenshot containing stale values.",
    components: ["group", "hero", "image", "row"], examples: ["soft-image-background", "map-background"],
    sizes: { small: "One image-led focus with a short title/value and at most one or two short supporting facts.", middle: "Balanced text and image side by side, with a clear primary focus.", large: "One leading image with headline and a few supporting groups, or selected image-led rows." },
  },
  {
    id: "freeform", summary: "Content that needs a composition outside the listed patterns.",
    requires: "Observed content and a clear primary information need.",
    guidance: "Compose the applicable primitives around one visual focus. Use the same defaults and data constraints; the catalog is not a whitelist of supported subjects. A primary event can sit above a muted details group; peer events can sit side by side with the current event on a muted surface. Add graphs only when their data exists.",
    components: ["group", "hero", "row", "status", "divider", "progress", "trend", "image"], examples: ["current-next", "meeting-details"],
    sizes: { small: "One primary focus and at most one or two short supporting facts.", middle: "One primary focus with two or three supporting facts in a clear reading order.", large: "One primary focus with a few supporting groups, not a miniature desktop dashboard." },
  },
];
