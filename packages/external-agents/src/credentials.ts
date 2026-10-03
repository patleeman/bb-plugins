import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read only the named dotenv assignment. Never execute shell syntax or expand values. */
export function resolveToken(name: string, envFile = "", env: NodeJS.ProcessEnv = process.env): string {
  if (env[name]) return env[name]!;
  if (!envFile) return "";
  const path = envFile.startsWith("~/") ? join(homedir(), envFile.slice(2)) : envFile;
  let contents: string;
  try { contents = readFileSync(path, "utf8"); } catch { return ""; }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== name) continue;
    const value = match[2]!;
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    return value.replace(/\s+#.*$/, "").trim();
  }
  return "";
}
