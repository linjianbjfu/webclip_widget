import { defineTool } from "@earendil-works/pi-coding-agent";
import { designContext, designParameters, CATALOG } from "../design-system/catalog.ts";
import type { Catalog } from "../design-system/types.ts";

export function createDesignContextTool(catalog: Catalog = CATALOG) {
  return defineTool({
    name: "get_design_context",
    label: "Widget design context",
    description: "Get composition guidance, size-specific design tokens, related component rules, image extraction guidance and visual review criteria for a widget. Optional examples are short reference analyses.",
    parameters: designParameters(catalog),
    async execute(_id, args) {
      return { content: [{ type: "text" as const, text: JSON.stringify(designContext(args, catalog)) }], details: {} };
    },
  });
}
