import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

/** Load local CLI configuration without replacing values supplied by the parent process. */
export function loadCliEnv(path = DEFAULT_ENV_FILE) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
