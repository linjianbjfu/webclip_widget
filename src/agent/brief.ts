/**
 * The operating brief: the system prompt that tells the model how to read the
 * captured page, locate regions and write the widget.
 *
 * Content is deliberately out of scope for this version — only the shape is
 * fixed. `system()` and `strip()` must stay a pair: the history projection
 * relies on `strip` to remove the brief from the first user message, and a
 * resumed client would otherwise be shown the server's system prompt.
 */

export interface BriefContext {
  sessionId: string;
  workspaceRoot: string;
  outDir: string;
}

export interface BriefProvider {
  /**
   * Session-level system prompt. Callers downgrade it into the first user
   * message when the provider has no system role.
   *
   * **Must be byte-stable for a given `sessionId`.** Upstream prompt caching
   * matches on a prefix, so a timestamp, a random identifier, or any assembly
   * that depends on iteration order (enumerating a Map or Set to list tools,
   * say) makes every turn a cache miss. The failure is silent: no error, no
   * wrong answer, only a larger bill and a slower first token.
   */
  system(ctx: BriefContext): string;
  /** Remove the brief from stored text, for the history projection. */
  strip(text: string): string;
}

const OPEN = "<agent_brief>";
const CLOSE = "</agent_brief>";

/**
 * A minimal brief. It states the environment's hard facts — where files live,
 * which commands exist, how the result is verified — and nothing about how to
 * do the extraction well. Replacing this is its own piece of work.
 */
export function createBriefProvider(): BriefProvider {
  return {
    system({ workspaceRoot, outDir }: BriefContext): string {
      // No interpolation beyond the two paths, both fixed per session.
      return [
        OPEN,
        "You turn a captured web page into a widget.",
        "",
        `The page source is at ${workspaceRoot}source.html and a screenshot is at ${workspaceRoot}screenshot.png.`,
        `Write exactly two files: ${outDir}/widget.html and ${outDir}/extra.js.`,
        `Only files under ${outDir} are delivered to the user.`,
        "",
        "The shell has grep, rg, find, sed, awk, jq, cut, tr and the usual text tools.",
        "It has no node, npm, python or js-exec: transform text with those tools instead.",
        "Its regular expressions are RE2 — backreferences and lookaround are unsupported.",
        "",
        "extra.js runs in a browser, not Node. Call preview_widget to render the widget,",
        "collect syntax and runtime errors, and get a screenshot back.",
        "Never invent data: if a value is not present in the source, show it as missing.",
        CLOSE,
      ].join("\n");
    },

    strip(text: string): string {
      const start = text.indexOf(OPEN);
      if (start === -1) return text;
      const end = text.indexOf(CLOSE, start);
      if (end === -1) return text;
      return (text.slice(0, start) + text.slice(end + CLOSE.length)).trimStart();
    },
  };
}
