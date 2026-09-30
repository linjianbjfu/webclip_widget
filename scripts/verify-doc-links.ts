/** Check local Markdown link targets in the product docs and their root instructions. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

const files = ["README.md", "AGENTS.md", ...markdownFiles("docs")];
let failures = 0;
let checked = 0;
for (const file of files) {
  let fence: string | undefined;
  for (const [index, original] of readFileSync(file, "utf8").split("\n").entries()) {
    const marker = original.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const line = original.replace(/(`+).*?\1/g, "");
    // Inline links/images and reference definitions; anchors are outside this check's scope.
    const destinations = [
      ...line.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g),
      ...line.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/g),
    ];
    for (const match of destinations) {
      const target = match[1] ?? match[2]!;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
      const path = target.split(/[?#]/, 1)[0]!;
      if (!path) continue;
      checked++;
      try {
        if (existsSync(resolve(dirname(file), decodeURIComponent(path)))) continue;
      } catch {
        // Invalid URI encoding is reported with the same source location as a missing target.
      }
      console.error(`${file}:${index + 1}: local link target does not exist: ${target}`);
      failures++;
    }
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`verify-doc-links: ${checked} local targets checked in ${files.length} files.`);
