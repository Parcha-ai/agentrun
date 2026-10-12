// The offline brain's model folder, as live hands it to the 03 server (--models-dir): an absolute path (the server runs from another working directory), a folder (not a file), holding the model's
// parts manifest (D0's `<name>.parts.json`). A mistake is an error before anything starts, not a 404 on stage.
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function resolveModelsDir(value: string, cwd: string = process.cwd()): string {
  const dir = resolve(cwd, value);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new Error(`--models-dir ${value}: no such folder (looked for ${dir})`);
  }
  if (!isDir) throw new Error(`--models-dir ${value}: ${dir} is a file, not a folder`);
  if (!readdirSync(dir).some((name) => name.endsWith(".parts.json"))) throw new Error(`--models-dir ${value}: ${dir} holds no model (no *.parts.json manifest)`);
  return dir;
}
