import { Check } from "typebox/value";
import { Type } from "typebox";
import { WIDGET_SIZES, type WidgetSize } from "../widget-contract.ts";
import { COMPONENTS } from "./components/index.ts";
import { EXAMPLES } from "./examples/index.ts";
import { PATTERNS } from "./patterns/index.ts";
import { TOKENS, TOKENS_SCHEMA } from "./tokens.ts";
import { IMAGE_EXTRACTOR, IMAGE_POLICY } from "./images.ts";
import { REVIEW } from "./review.ts";
import type { Catalog } from "./types.ts";

export const CATALOG: Catalog = { components: COMPONENTS, examples: EXAMPLES, patterns: PATTERNS };
export const CONTEXT_MAX_BYTES = 18_000;
export const INDEX_MAX_BYTES = 2_500;
const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function patternIds(catalog = CATALOG): string[] {
  return sorted(catalog.patterns).map(pattern => pattern.id);
}

export function patternIndex(catalog = CATALOG): string {
  return sorted(catalog.patterns).map(pattern => `${pattern.id}: ${pattern.summary}`).join("\n");
}

export function designParameters(catalog = CATALOG) {
  return Type.Object({
    pattern: Type.Union(patternIds(catalog).map(id => Type.Literal(id)), { description: "Composition matching the observed content; freeform for other compositions." }),
    size: Type.Union(Object.keys(WIDGET_SIZES).map(size => Type.Literal(size))),
    include_examples: Type.Optional(Type.Boolean({ description: "Include up to two short reference analyses when more design guidance is needed. Defaults to false." })),
  }, { additionalProperties: false });
}

export function designContext(args: unknown, catalog = CATALOG) {
  if (!Check(designParameters(catalog), args)) throw new Error("Invalid design context request: choose a listed pattern and small, middle or large size.");
  const { pattern: id, size, include_examples } = args as { pattern: string; size: WidgetSize; include_examples?: boolean };
  const pattern = catalog.patterns.find(item => item.id === id)!;
  const result = {
    pattern: { id, summary: pattern.summary, requires: pattern.requires, guidance: pattern.guidance, layout: pattern.sizes[size] },
    tokens: { font: TOKENS.font, spacing: TOKENS.spacing, line: TOKENS.line, radius: TOKENS.radius, themes: TOKENS.themes, size: TOKENS.sizes[size] },
    components: sorted(catalog.components.filter(item => pattern.components.includes(item.id))),
    images: { guidance: IMAGE_POLICY, extractor: IMAGE_EXTRACTOR },
    review: REVIEW,
    ...(include_examples ? { examples: pattern.examples.slice(0, 2).map(id => catalog.examples.find(item => item.id === id)!) } : {}),
  };
  if (bytes(JSON.stringify(result)) > CONTEXT_MAX_BYTES) throw new Error(`Design context exceeds ${CONTEXT_MAX_BYTES} UTF-8 bytes`);
  return result;
}

/** Corpus gate: every registered composition must be discoverable, bounded and self-contained. */
export function validateCatalog(catalog = CATALOG, tokens: unknown = TOKENS): void {
  if (!Check(TOKENS_SCHEMA, tokens)) throw new Error("Invalid design tokens");
  for (const [kind, items] of Object.entries(catalog)) {
    const ids = new Set<string>();
    for (const item of items) {
      if (!/^[a-z][a-z0-9-]*$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate ${kind} id: ${item.id}`);
      ids.add(item.id);
    }
    if (!items.length) throw new Error(`Empty design ${kind}`);
  }
  for (const component of catalog.components) if (!component.guidance.trim()) throw new Error(`Missing guidance: ${component.id}`);
  for (const example of catalog.examples) if (!example.reference.trim() || !example.analysis.trim()) throw new Error(`Incomplete example: ${example.id}`);
  for (const pattern of catalog.patterns) {
    if (![pattern.summary, pattern.requires, pattern.guidance].every(value => value.trim())) throw new Error(`Incomplete pattern: ${pattern.id}`);
    if (Object.keys(pattern.sizes).sort().join() !== Object.keys(WIDGET_SIZES).sort().join()
      || !Object.values(pattern.sizes).every(value => typeof value === "string" && value.trim())) throw new Error(`Invalid pattern sizes: ${pattern.id}`);
    for (const [kind, refs] of [["components", pattern.components], ["examples", pattern.examples]] as const) {
      if (!refs.length || new Set(refs).size !== refs.length || refs.some(id => !catalog[kind].some(item => item.id === id))) throw new Error(`Invalid ${kind} references: ${pattern.id}`);
    }
    for (const size of Object.keys(WIDGET_SIZES)) designContext({ pattern: pattern.id, size, include_examples: true }, catalog);
  }
  if (bytes(patternIndex(catalog)) > INDEX_MAX_BYTES) throw new Error(`Design index exceeds ${INDEX_MAX_BYTES} UTF-8 bytes`);
}
