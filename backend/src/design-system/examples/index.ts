import type { Example } from "../types.ts";

export const EXAMPLES: Example[] = [
  { id: "quiet-cards", reference: "design/widget-style/widgets.webp", analysis: "Neutral cards use generous spacing, aligned short text and a few colored icons. Adapt the hierarchy to the small canvas; omit the illustrated interaction controls and surrounding presentation frame." },
  { id: "image-balance", reference: "design/widget-style/widgets2.webp", analysis: "A strong number or headline occupies one side while a recognizable image supports the other. Sparse labels and a single accent keep the composition calm. Images must come from available relevant content, not recreated example products or people." },
  { id: "progress-and-history", reference: "design/widget-style/StepCounter.webp", analysis: "The current value dominates, a compact ring explains progress, and a quieter chart explains history. A subtle divider separates the two groups. At middle size choose only the groups the requested content can fit; do not compress the whole reference dashboard." },
  { id: "quiet-trend", reference: "design/widget-style/instagramAndThread.webp", analysis: "Neutral light or dark surfaces support a clear headline or metric. The chart uses one accent and a quiet fill. Preserve its hierarchy without inventing a history series or copying the action buttons." },
];
