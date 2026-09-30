/**
 * Custom commands layered over just-bash.
 *
 * Two jobs. First, steer the model away from tools this environment does not
 * have: it will reach for `node --check` on generated JavaScript out of habit,
 * and a bare "command not found" costs several turns of retrying. Second,
 * `grep` cannot be delegated through pi's own seam — pi's implementation
 * spawns ripgrep unconditionally and `GrepOperations` only supplies context
 * lines — so the shell's grep is the one the agent gets.
 */

import { defineCommand, getCommandNames } from "just-bash/browser";

interface Guidance {
  readonly names: readonly string[];
  readonly message: string;
}

const GUIDANCE: readonly Guidance[] = [
  {
    names: ["node", "nodejs"],
    message: [
      "node is not available in this environment.",
      "extra.js runs in a browser, not Node. Use the preview_widget tool — it renders",
      "the widget, reports syntax and runtime errors, and returns a screenshot.",
    ].join("\n"),
  },
  {
    names: ["npm", "npx", "pnpm", "yarn"],
    message: [
      "Package managers are not available and the widget has no dependencies.",
      "Write plain browser JavaScript into out/extra.js.",
    ].join("\n"),
  },
  {
    names: ["js-exec", "python", "python3"],
    message: [
      "Script runtimes are not available in this environment.",
      "Transform text with sed, awk, jq, grep, cut and tr instead.",
    ].join("\n"),
  },
];

const GUIDED = new Set(GUIDANCE.flatMap(entry => entry.names));

/**
 * `which` against the command registry rather than the filesystem.
 *
 * just-bash's own `which` resolves a name by testing whether `$PATH/<name>`
 * exists as a file. That works against its default in-memory filesystem,
 * which ships stubs under `/usr/bin`, but a workspace-backed filesystem has
 * no such entries — so the built-in reports "not found" for `grep` while
 * `grep` runs perfectly. A model that probes with `which` would conclude the
 * tool is unavailable and stop using it.
 *
 * Seeding fake `/usr/bin` files would fix `which` at the cost of polluting
 * `getAllPaths()`, which backs glob expansion: `find / -name "*"` would then
 * list dozens of stubs. Consulting the registry keeps the workspace clean.
 */
function whichCommand(): ReturnType<typeof defineCommand> {
  return defineCommand("which", async args => {
    const names = args.filter(arg => !arg.startsWith("-"));
    const silent = args.includes("-s");
    if (names.length === 0) return { stdout: "", stderr: "", exitCode: 1 };
    const registered = new Set(getCommandNames());
    let stdout = "";
    let allFound = true;
    for (const name of names) {
      // A guided name is registered but deliberately unusable; reporting it
      // as present would contradict the message it prints when run.
      if (registered.has(name) && !GUIDED.has(name)) {
        if (!silent) stdout += `/usr/bin/${name}\n`;
      } else {
        allFound = false;
      }
    }
    return { stdout, stderr: "", exitCode: allFound ? 0 : 1 };
  });
}

/**
 * Commands that answer with a usable next step instead of failing silently.
 * Exit code 127 keeps the shell semantics of "not found" while the message
 * tells the model where to go.
 */
export function customCommands(): ReturnType<typeof defineCommand>[] {
  return [
    whichCommand(),
    ...GUIDANCE.flatMap(entry =>
      entry.names.map(name =>
        defineCommand(name, async () => ({ stdout: "", stderr: `${entry.message}\n`, exitCode: 127 })),
      ),
    ),
  ];
}
