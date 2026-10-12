// A workspace file's text, for the page's file preview and its write diffs, from wherever this page holds the workspace: the computer in the tab (Wasmer), the
// phone's files (FilesEnv: no computer, the workspace's own file system), or the copy the pipe sent with the file list (base64). Portable: no DOM.
import { fromBase64 } from "../wire.ts";
import { FilesEnv } from "./files-env.ts";
import type { WorkspaceFs } from "./workspace.ts";

/** The computer in the tab: its sandbox reads a file as text. */
interface SandboxEnv { sandbox: { fs: { readText(path: string): Promise<string> } } }

/** The page's runtime, as far as reading a file goes. */
export interface FileSource { env: unknown; workspace?: { fs: WorkspaceFs } }

/** `path` (relative to the workspace) as text, or undefined when this page cannot read it. */
export async function workspaceText(runtime: FileSource | undefined, row: { kind: string; data?: string } | undefined, path: string): Promise<string | undefined> {
  if (runtime && typeof runtime.env === "object" && runtime.env !== null && "sandbox" in runtime.env) return await (runtime.env as SandboxEnv).sandbox.fs.readText(`/workspace/${path}`).catch(() => undefined);
  if (runtime?.env instanceof FilesEnv && runtime.workspace) {
    const fs = runtime.workspace.fs;
    return await fs.readFile(`${fs.root}/${path}`).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
  }
  if (row?.kind === "file" && row.data !== undefined) return new TextDecoder().decode(fromBase64(row.data));
  return undefined;
}
