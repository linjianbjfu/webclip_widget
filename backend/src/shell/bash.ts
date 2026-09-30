/**
 * just-bash bound to one session's workspace.
 *
 * The import is `just-bash/browser`, not the package root. `browser` here is
 * an npm export condition — a build-target label with no relation to any
 * browser, and none to the Browser Run used by preview_widget. It means "the
 * build for hosts without Node APIs". The default entry pulls in `node:fs`
 * and its lazily-loaded chunks depend on `node:worker_threads`, `new Worker`
 * and `readFileSync`; Workers has none of the three, and the failure appears
 * after deployment rather than at build time.
 *
 * That build drops `js-exec`, `python3`, `sqlite3` and `curl`. The agent
 * therefore cannot write a script to transform the captured HTML and must use
 * sed/awk/jq/grep — see `customCommands`, which says so rather than letting
 * the model discover it by trial.
 */

import { Bash } from "just-bash/browser";
import type { IFileSystem } from "just-bash/browser";

import type { WorkspaceFs } from "../fs/workspace-fs.ts";
import { customCommands } from "./commands.ts";

export const WORKSPACE_ROOT = "/";
export const OUT_DIR = "/out";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export function createShell(fs: WorkspaceFs): Bash {
  return new Bash({
    fs: fs satisfies IFileSystem,
    cwd: WORKSPACE_ROOT,
    customCommands: customCommands(),
  });
}

export async function runShell(
  shell: Bash,
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> {
  const result = await shell.exec(command, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}
