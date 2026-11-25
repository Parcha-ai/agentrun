import type { NativeSelector, NativeTarget } from "./types.js";
import type { SourceRuntime } from "./runtimes.js";
export { isSourceRuntime, sourceRuntimeProtocol, type SourceRuntime } from "./runtimes.js";
import { createHash } from "node:crypto";

/** Setup export does not grant permission to launch a source runtime. Pi has a managed destination without a
 * native-session bridge; its source setup therefore participates only in this export contract. */
export type SourceTarget = Omit<NativeTarget, "runtime" | "state"> & { runtime: SourceRuntime; state: NativeTarget["state"] | "ready" };

export type SourceSnapshotBlocker = { code: string; path?: string; message: string };
export type SourceSnapshotEntry = {
  path: string; role: "project" | "instruction" | "skill"; type: "file" | "directory";
  mode: number; bytes: number; sha256?: string;
};
export type SourceMcpSelection = { dialect: "exact" | "claude"; allow: string[] | null; deny: string[] };
export type SourceMcpResource = "list" | "templates" | "read";
export type SourceNativeAccount = { source: "codex-auth-file"; mode: "none" | "apikey" | "chatgpt" | "unknown"; plan: "ordinary" | "managed" | "unknown" | null };
export type SourceSnapshotTool = {
  name: string; transport: "http" | "stdio"; url?: string;
  /** Names only. Source credential values are never part of a snapshot. */
  credentials: string[];
  /** Absent on older snapshots; Move requires a freshly resolved selection. Empty means no tools. */
  selection?: SourceMcpSelection;
  /** Resource access is independent of the MCP tool allow/deny list. */
  resources?: SourceMcpResource[];
};
export const SOURCE_NATIVE_CAPABILITIES = ["shell", "file_read", "file_write", "file_edit", "file_search", "web_search", "web_fetch", "subagents", "image_read", "image_generate", "planning", "user_input", "mcp_resources", "skills", "clock", "sleep", "task_tracking", "notebook_edit", "worktree", "notifications", "session_messaging", "context_management", "session_end", "feedback", "artifact_publish", "remote_tasks", "remote_files", "plugins", "apps"] as const;
export type SourceNativeCapability = typeof SOURCE_NATIVE_CAPABILITIES[number];
export type SourceNativeTools = { version: string | null; complete: boolean; source: "versioned-runtime" | "native-resolved";
  capabilities: SourceNativeCapability[]; disabled: SourceNativeCapability[] };
export type SourceSnapshotTransform = {
  kind: "agentrun-capture-hooks"; path: string; original_sha256: string; original_bytes: number;
  destination_sha256: string; destination_bytes: number; receipt: { path: string; sha256: string };
};
export type SourceSnapshot = {
  version: 1; digest: string; complete: boolean;
  source: { runtime: SourceRuntime; machine_id: string; project: string; selector: NativeSelector };
  entries: SourceSnapshotEntry[];
  /** sha256 -> exact bytes, base64 encoded. Shared content has one blob. */
  blobs: Record<string, string>;
  instructions: { text: string; layers: { path: string; precedence: number; source: string }[] };
  skills: { name: string; path: string; source: string }[];
  configuration: { model: string | null; thinking?: string; tools: SourceSnapshotTool[]; permissions: Record<string, unknown>; credentials: string[]; native_tools?: SourceNativeTools; native_account?: SourceNativeAccount };
  project: { git: null | { head: string | null; branch: string | null; dirty: boolean;
    deleted: string[]; bundle?: { sha256: string; bytes: number }; history: "complete" | "unavailable" } };
  blockers: SourceSnapshotBlocker[];
  /** Explicit operational hook removal. Original bytes/provenance remain independently verifiable. */
  transforms?: SourceSnapshotTransform[];
};
export type SourceSnapshotOptions = {
  target: SourceTarget;
  /** Explicit source-side content grant. Fixed native system-policy paths receive presence-only
   * metadata checks so unmanaged configuration cannot silently override a required policy. */
  authorizedRoots: string[];
  /** Private consent binding, never part of the manifest. Decimal identities preserve bigint precision. */
  expectedRoots?: readonly { readonly path: string; readonly device: string; readonly inode: string }[];
  home: string; codexHome?: string; claudeHome?: string; piHome?: string;
  /** Source process metadata only; values are never serialized wholesale. */
  environment?: Readonly<Record<string, string | undefined>>;
  limits?: { files?: number; bytes?: number; fileBytes?: number; gitBytes?: number; timeoutMs?: number };
  /** Held values supplied by the source's credential boundary, for refusal rather than redaction. */
  secretValues?: readonly string[];
  signal?: AbortSignal;
};

/** Shared wire digest only; no source filesystem, environment or native-runtime dependencies.
 * Consumers separately verify each blob's digest/size before accepting the complete manifest. */
export function sourceSnapshotDigest(snapshot: Omit<SourceSnapshot, "digest"> | SourceSnapshot): string {
  const { digest: _digest, ...body } = snapshot as SourceSnapshot;
  const canonical = JSON.stringify({ ...body, blobs: Object.keys(body.blobs).sort() }, function (_key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
