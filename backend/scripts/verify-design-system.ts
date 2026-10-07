import { validateCatalog, CATALOG } from "../src/design-system/catalog.ts";

validateCatalog();
console.log(`verify-design-system: ${CATALOG.patterns.length} patterns, ${CATALOG.components.length} components and ${CATALOG.examples.length} examples checked.`);
