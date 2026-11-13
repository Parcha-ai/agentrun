import { ClientError, type FieldIssue } from "./client";
import type { ApiError } from "./v2";

/** A file this server keeps (`POST /v2/files`'s answer, `GET /v2/files/{id}`): a run that names its `file_id` finds it at
 *  `inputs/<path>`. */
export type UploadedFile = { file_id: string; path: string; size_bytes: number; content_type: string; sha256: string; status: string; created_at?: string; expires_at?: string | null };

/** The least XMLHttpRequest this needs, so a test can stand one in. */
export type UploadRequest = Pick<XMLHttpRequest, "open" | "send" | "abort" | "setRequestHeader" | "status" | "responseText"> & {
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

export type UploadOptions = { base?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal; request?: () => UploadRequest };

/** Sends `file` in one call, `POST /v2/files?path=<its name>` with its bytes as the body, on the page's own origin (the
 *  session cookie goes with it, and a raw body is a write the server takes from a cookie session). XMLHttpRequest, as
 *  fetch reports no upload progress: `onProgress` gets the fraction sent, 0 to 1. Resolves with the file the server made;
 *  a refusal rejects with the server's ClientError (its message is the server's words), a lost one with status 0. */
export function uploadFile(file: File, { base = "/v2", onProgress, signal, request = () => new XMLHttpRequest() as unknown as UploadRequest }: UploadOptions = {}): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClientError(0, "aborted", "The upload was stopped."));
    const xhr = request();
    xhr.open("POST", `${base}/files?path=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("accept", "application/json");
    // The file's own type, when the browser knows one; the server takes it from the name's extension otherwise.
    if (file.type) xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total)); };
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201 || xhr.status === 200) {
        const made = (body as { file?: UploadedFile } | null)?.file;
        if (made?.file_id) { onProgress?.(1); return resolve(made); }
        return reject(new ClientError(xhr.status, "bad_answer", "The server's answer named no file."));
      }
      const e = (body as { error?: ApiError & { fields?: FieldIssue[] } } | null)?.error;
      const err = new ClientError(xhr.status, e?.code ?? "http_error", e?.message ?? `The server answered ${xhr.status}.`, e?.retryable ?? false, e?.request_id);
      if (e?.fields) err.fields = e.fields;
      reject(err);
    };
    xhr.onerror = () => reject(new ClientError(0, "network", "The upload did not reach the server."));
    xhr.onabort = () => reject(new ClientError(0, "aborted", "The upload was stopped."));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Sends one file for a start screen; resolves with the file the server made, or rejects with its refusal. */
export type Upload = (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<UploadedFile>;
/** The start screens' upload: `uploadFile` on this page's origin. */
export const sendUpload: Upload = (file, onProgress, signal) => uploadFile(file, { onProgress, signal });

/** What a refused upload says: the server's message, and each field it names that says more. */
export function refusalOf(e: unknown): string {
  if (!(e instanceof ClientError)) return e instanceof Error ? e.message : String(e);
  const more = (e.fields ?? []).filter((f) => f.message !== e.message).map((f) => f.message);
  return [e.message, ...more].join(" ");
}
