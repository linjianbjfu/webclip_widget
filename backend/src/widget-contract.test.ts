import { describe, expect, it } from "vitest";
import {
  parseWidgetMeta,
  validateWidgetPaths,
  widgetViewport,
  WIDGET_FILES,
  WIDGET_SIZES,
  type WidgetSize,
} from "./widget-contract.ts";

describe("widget bundle", () => {
  it.each(Object.keys(WIDGET_SIZES) as WidgetSize[])("accepts %s", size => {
    expect(parseWidgetMeta(JSON.stringify({ size }))).toEqual({ size });
    expect(widgetViewport(parseWidgetMeta(JSON.stringify({ size })))).toEqual(WIDGET_SIZES[size]);
  });
  it("uses paired custom dimensions as the viewport", () => {
    const meta = parseWidgetMeta('{"size":"large","width":360,"height":440}');
    expect(meta).toEqual({ size: "large", width: 360, height: 440 });
    expect(widgetViewport(meta)).toEqual({ width: 360, height: 440 });
  });
  it.each(['{}', 'null', '[]', '{', '{"size":"medium"}', '{"size":"constructor"}',
    '{"size":"small","width":160}', '{"size":"small","height":160}',
    '{"size":"small","width":0,"height":160}', '{"size":"small","width":160.5,"height":160}',
    '{"size":"small","width":10001,"height":160}', '{"size":"small","width":160,"height":160,"extra":1}',
    '{"size":1}'])("rejects invalid metadata %s", value => {
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
