/**
 * pi's tool IO, pointed at the workspace.
 *
 * pi exposes an `*Operations` seam on each built-in tool so the IO layer can
 * be replaced without touching argument validation, truncation, diffing or
 * the tool's prompt text. Here the other end is the same process — the
 * Durable Object's SQLite — so there is no RPC at all.
 *
 * `GrepOperations` is deliberately absent. pi's grep spawns ripgrep in every
 * case and that seam only supplies context lines, so it cannot be redirected;
 * grep reaches the agent as a custom tool over the shell instead.
 */

import { Buffer } from "node:buffer";

import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

import type { WorkspaceFs } from "../fs/workspace-fs.ts";
import { runShell } from "../shell/bash.ts";
import type { Bash } from "just-bash/browser";

/**
 * Narrow pi's child-process environment to its own session variables.
 *
 * pi derives that environment from `process.env`, which `nodejs_compat`
 * populates from the Worker's bindings — including the gateway key.
 * Forwarding it wholesale would hand the key to every command the model runs.
 */
function sessionEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PI_") && value !== undefined) forwarded[key] = value;
  }
  return Object.keys(forwarded).length > 0 ? forwarded : undefined;
}

export interface WorkspaceOperations {
  bash: BashOperations;
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
  ls: LsOperations;
  find: FindOperations;
}

export function createWorkspaceOperations(fs: WorkspaceFs, shell: Bash): WorkspaceOperations {
  // Pi calls toString("utf-8") and toString("base64") on these bytes.
  const readFile = async (path: string) => Buffer.from(await fs.readFileBuffer(path));

  const bash: BashOperations = {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const result = await runShell(shell, command, {
        cwd,
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
        ...(sessionEnv(env) === undefined ? {} : { env: sessionEnv(env)! }),
      });
      if (result.stdout) onData(new TextEncoder().encode(result.stdout));
      if (result.stderr) onData(new TextEncoder().encode(result.stderr));
      return { exitCode: result.exitCode };
    },
  };

  const read: ReadOperations = {
    readFile,
    access: async path => {
      if (!(await fs.exists(path))) throw new Error(`ENOENT: no such file or directory, '${path}'`);
    },
    detectImageMimeType: async path => {
      const lower = path.toLowerCase();
      if (lower.endsWith(".png")) return "image/png";
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
      if (lower.endsWith(".webp")) return "image/webp";
      if (lower.endsWith(".gif")) return "image/gif";
      return null;
    },
  };

  const edit: EditOperations = {
    readFile,
    writeFile: async (path, content) => fs.writeFile(path, content),
    access: async path => {
      if (!(await fs.exists(path))) throw new Error(`ENOENT: no such file or directory, '${path}'`);
    },
  };

  const write: WriteOperations = {
    writeFile: async (path, content) => fs.writeFile(path, content),
    mkdir: async path => fs.mkdir(path, { recursive: true }),
  };

  const ls: LsOperations = {
    exists: async path => fs.exists(path),
    stat: async path => {
      const stat = await fs.stat(path);
      return { isDirectory: () => stat.isDirectory };
    },
    readdir: async path => fs.readdir(path),
  };

  const find: FindOperations = {
    exists: async path => fs.exists(path),
    glob: async (pattern, cwd, options) => {
      // Delegating to the shell keeps one glob implementation rather than a
      // second that could disagree with what the model sees from `find`.
      const ignore = options.ignore.map(entry => `-not -path '${entry}'`).join(" ");
      const result = await runShell(shell, `find ${cwd} -name '${pattern}' ${ignore}`.trim());
      return result.stdout
        .split("\n")
        .filter(line => line.length > 0)
        .slice(0, options.limit);
    },
  };

  return { bash, read, edit, write, ls, find };
}
