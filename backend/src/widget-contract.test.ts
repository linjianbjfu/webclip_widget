import { describe, expect, it } from "vitest";
import { parseWidgetMeta, validateWidgetPaths, WIDGET_FILES, WIDGET_SIZES } from "./widget-contract.ts";

describe("widget bundle", () => {
  it.each(Object.keys(WIDGET_SIZES))("accepts %s", size => {
    expect(parseWidgetMeta(JSON.stringify({ size }))).toEqual({ size });
  });
  it.each(['{}', 'null', '[]', '{', '{"size":"medium"}', '{"size":"constructor"}',
    '{"size":"small","width":160}', '{"size":1}'])("rejects invalid metadata %s", value => {
    expect(() => parseWidgetMeta(value)).toThrow(/meta.json/);
  });
  it("requires all three direct files with no duplicates or extras", () => {
    expect(() => validateWidgetPaths(WIDGET_FILES)).not.toThrow();
    for (const paths of [WIDGET_FILES.slice(1), [...WIDGET_FILES, "out/data.json"],
      ["out/extra.js", "out/extra.js", "out/meta.json"], ["../extra.js", ...WIDGET_FILES.slice(1)]]) {
      expect(() => validateWidgetPaths(paths)).toThrow(/exactly/);
    }
  });
});
