import { expect, it } from "vitest";
import { CATALOG, CONTEXT_MAX_BYTES, designContext, designParameters, patternIndex, validateCatalog } from "./catalog.ts";
import { TOKENS } from "./tokens.ts";
import { Check } from "typebox/value";

it("validates the shipped catalog and returns bounded, size-specific dependencies", () => {
  validateCatalog();
  const args = { pattern: "metric-chart", size: "middle" };
  const context = designContext(args);
  expect(context.tokens.size).toEqual(TOKENS.sizes.middle);
  expect(context.components.map(item => item.id)).toEqual(["hero", "row", "trend"]);
  expect(context).not.toHaveProperty("examples");
  const expanded = designContext({ ...args, include_examples: true });
  expect(expanded.examples).toHaveLength(2);
  expect(new TextEncoder().encode(JSON.stringify(expanded)).length).toBeLessThan(CONTEXT_MAX_BYTES);
  expect(designContext(args)).toEqual(context);
  const reversed = structuredClone(CATALOG);
  reversed.patterns.reverse(); reversed.components.reverse();
  expect(patternIndex(reversed)).toBe(patternIndex());
  expect(designParameters(reversed)).toEqual(designParameters());
  expect(designContext(args, reversed)).toEqual(context);
});

it("discovers a new pattern through the same index, schema and context loader", () => {
  const catalog = structuredClone(CATALOG);
  catalog.patterns.push({ ...catalog.patterns[0]!, id: "calendar", summary: "Observed upcoming events." });
  validateCatalog(catalog);
  expect(patternIndex(catalog)).toContain("calendar: Observed upcoming events.");
  const args = { pattern: "calendar", size: "small" };
  expect(Check(designParameters(catalog), args)).toBe(true);
  expect(designContext(args, catalog).pattern.id).toBe("calendar");
  expect(Check(designParameters(), args)).toBe(false);
});

it("rejects invalid catalog definitions through the production gate", () => {
  const mutations = [
    (c: typeof CATALOG) => c.patterns.push(c.patterns[0]!),
    (c: typeof CATALOG) => c.components.push(c.components[0]!),
    (c: typeof CATALOG) => c.examples.push(c.examples[0]!),
    (c: typeof CATALOG) => { c.patterns[0]!.id = "../escape"; },
    (c: typeof CATALOG) => { c.patterns[0]!.components = ["missing"]; },
    (c: typeof CATALOG) => { c.patterns[0]!.examples = ["missing"]; },
    (c: typeof CATALOG) => { c.patterns[0]!.sizes = { small: "one" } as never; },
    (c: typeof CATALOG) => { c.patterns[0]!.sizes = { ...c.patterns[0]!.sizes, medium: "bad" } as never; },
    (c: typeof CATALOG) => { c.patterns[0]!.requires = ""; },
    (c: typeof CATALOG) => { c.components[0]!.guidance = " "; },
    (c: typeof CATALOG) => { c.examples[0]!.analysis = ""; },
    (c: typeof CATALOG) => { c.patterns[0]!.guidance = "x".repeat(CONTEXT_MAX_BYTES); },
    (c: typeof CATALOG) => { c.patterns[0]!.summary = "x".repeat(3_000); },
  ];
  for (const mutate of mutations) {
    const catalog = structuredClone(CATALOG); mutate(catalog);
    expect(() => validateCatalog(catalog)).toThrow();
  }
  for (const tokens of [
    { ...TOKENS, line: -1 }, { ...TOKENS, font: "" }, { ...TOKENS, spacing: [] },
    { ...TOKENS, sizes: { small: TOKENS.sizes.small } },
    { ...TOKENS, themes: { ...TOKENS.themes, light: { ...TOKENS.themes.light, primary: "not a color" } } },
  ]) expect(() => validateCatalog(CATALOG, tokens)).toThrow("Invalid design tokens");
});

it("rejects unknown patterns, paths, sizes and extra tool arguments", () => {
  for (const args of [null, {}, { pattern: "../core", size: "small" },
    { pattern: "list", size: "medium" }, { pattern: "list", size: "large", include_examples: "true" },
    { pattern: "list", size: "large", path: "/secret" },
  ]) expect(() => designContext(args)).toThrow("Invalid design context request");
});
