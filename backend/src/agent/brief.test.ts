import { expect, it } from "vitest";
import { createBriefProvider } from "./brief.ts";
import { WIDGET_SIZES } from "../widget-contract.ts";

it("keeps the brief stable and removable without consuming user text", () => {
  const brief = createBriefProvider();
  const context = { sessionId: "session", workspaceRoot: "/", outDir: "/out" };
  const text = brief.system(context);
  expect(brief.system(context)).toBe(text);
  expect(brief.strip(`${text}\nMake a small widget`)).toBe("Make a small widget");
  expect(brief.strip("ordinary text")).toBe("ordinary text");
  for (const [size, { width, height }] of Object.entries(WIDGET_SIZES)) {
    expect(text).toContain(`${size}: ${width} x ${height} CSS px`);
  }
  expect(text).toContain('/out/meta.json');
  expect(text).toContain('immediately invoked function expression (IIFE)');
  expect(text).not.toContain('window.extractWidget');
  expect(text).toContain('window.renderWidget(data)');
  expect(text).toContain("fetch('./data.json'");
  expect(text).toContain('window.widgetReady');
  expect(text).toContain('region.xpath');
  expect(text).toContain('optional region.sourceXPath locates the region in the live source DOM');
  expect(text).toContain('preserving the original forward absolute XPath');
  expect(text).toContain('Never infer global id uniqueness');
  expect(text).toContain('last(), last-child, nth-last-child');
  expect(text).not.toContain('embedded snapshot');
});
