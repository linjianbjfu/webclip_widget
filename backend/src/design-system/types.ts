import type { WidgetSize } from "../widget-contract.ts";

export interface Component {
  id: string;
  guidance: string;
}

export interface Example {
  id: string;
  reference: string;
  analysis: string;
}

export interface Pattern {
  id: string;
  summary: string;
  requires: string;
  guidance: string;
  components: string[];
  examples: string[];
  sizes: Record<WidgetSize, string>;
}

export interface Catalog {
  components: Component[];
  examples: Example[];
  patterns: Pattern[];
}
