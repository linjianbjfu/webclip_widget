/** Shared text-artifact contract for the Worker and the Node CLI. */
export const WIDGET_SIZES = {
  small: { width: 160, height: 160 },
  middle: { width: 344, height: 160 },
  large: { width: 344, height: 360 },
} as const;

export type WidgetSize = keyof typeof WIDGET_SIZES;
export interface WidgetMeta {
  size: WidgetSize;
  width?: number;
  height?: number;
}
export const WIDGET_FILES = ["out/extra.js", "out/widget.html", "out/meta.json"] as const;
const MAX_WIDGET_DIMENSION = 10_000;

export function parseWidgetMeta(text: string): WidgetMeta {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('out/meta.json must contain JSON with size and optional width/height');
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("size" in value)
    || typeof value.size !== "string" || !Object.hasOwn(WIDGET_SIZES, value.size)
    || Object.keys(value).some(key => !["size", "width", "height"].includes(key))) {
    throw new Error("out/meta.json must have size set to small, middle or large and optional width/height");
  }
  const candidate = value as { size: WidgetSize; width?: unknown; height?: unknown };
  const hasWidth = candidate.width !== undefined;
  const hasHeight = candidate.height !== undefined;
  if (hasWidth !== hasHeight) {
    throw new Error("out/meta.json width and height must be provided together");
  }
  if (!hasWidth) return { size: candidate.size };
  if (![candidate.width, candidate.height].every(dimension =>
    Number.isSafeInteger(dimension) && Number(dimension) > 0
      && Number(dimension) <= MAX_WIDGET_DIMENSION)) {
    throw new Error(`out/meta.json width and height must be integers from 1 to ${MAX_WIDGET_DIMENSION}`);
  }
  return {
    size: candidate.size,
    width: candidate.width as number,
    height: candidate.height as number,
  };
}

export function widgetViewport(meta: WidgetMeta): { width: number; height: number } {
  return meta.width === undefined
    ? WIDGET_SIZES[meta.size]
    : { width: meta.width, height: meta.height! };
}

export function validateWidgetPaths(paths: readonly string[]): void {
  if (paths.length !== WIDGET_FILES.length || new Set(paths).size !== paths.length
    || WIDGET_FILES.some(path => !paths.includes(path))) {
    throw new Error(`Widget output must contain exactly ${WIDGET_FILES.join(", ")}`);
  }
}
