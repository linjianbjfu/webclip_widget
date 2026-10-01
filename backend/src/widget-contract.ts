/** Shared text-artifact contract for the Worker and the Node CLI. */
export const WIDGET_SIZES = {
  small: { width: 160, height: 160 },
  middle: { width: 344, height: 160 },
  large: { width: 344, height: 360 },
} as const;

export type WidgetSize = keyof typeof WIDGET_SIZES;
export const WIDGET_FILES = ["out/extra.js", "out/widget.html", "out/meta.json"] as const;

export function parseWidgetMeta(text: string): { size: WidgetSize } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('out/meta.json must contain JSON: {"size":"small|middle|large"}');
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !("size" in value)
    || typeof value.size !== "string" || !Object.hasOwn(WIDGET_SIZES, value.size)) {
    throw new Error("out/meta.json must have only size, set to small, middle or large");
  }
  return { size: value.size as WidgetSize };
}

export function validateWidgetPaths(paths: readonly string[]): void {
  if (paths.length !== WIDGET_FILES.length || new Set(paths).size !== paths.length
    || WIDGET_FILES.some(path => !paths.includes(path))) {
    throw new Error(`Widget output must contain exactly ${WIDGET_FILES.join(", ")}`);
  }
}
