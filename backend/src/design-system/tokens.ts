import { Type, type Static } from "typebox";

const positive = Type.Number({ exclusiveMinimum: 0 });
const colors = Type.Object({
  surface: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  surfaceMuted: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  primary: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  secondary: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  divider: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  accent: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
}, { additionalProperties: false });
const size = Type.Object({
  padding: positive, gap: positive, hero: positive, title: positive, body: positive, caption: positive,
}, { additionalProperties: false });
export const TOKENS_SCHEMA = Type.Object({
  font: Type.String({ minLength: 1 }),
  spacing: Type.Array(positive, { minItems: 1, maxItems: 8 }),
  line: positive,
  radius: Type.Object({ image: positive, badge: positive, group: positive }, { additionalProperties: false }),
  themes: Type.Object({ light: colors, dark: colors }, { additionalProperties: false }),
  sizes: Type.Object({ small: size, middle: size, large: size }, { additionalProperties: false }),
}, { additionalProperties: false });

/** Defaults calibrated for the project's preview canvases; user style may override them. */
export const TOKENS: Static<typeof TOKENS_SCHEMA> = {
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  spacing: [4, 8, 12, 16, 20, 24],
  line: 1,
  radius: { image: 12, badge: 8, group: 16 },
  themes: {
    light: { surface: "#FFFFFF", surfaceMuted: "#F5F5F5", primary: "#191B1D", secondary: "#666A70", divider: "#E3E5E7", accent: "#2563EB" },
    dark: { surface: "#242628", surfaceMuted: "#2F3134", primary: "#F7F8FA", secondary: "#B7BBC1", divider: "#494D52", accent: "#8AB4FF" },
  },
  sizes: {
    small: { padding: 12, gap: 8, hero: 40, title: 17, body: 14, caption: 12 },
    middle: { padding: 16, gap: 12, hero: 36, title: 18, body: 15, caption: 12 },
    large: { padding: 20, gap: 12, hero: 42, title: 20, body: 15, caption: 12 },
  },
};
