import { describe, expect, it } from "vitest";
import { ClientError } from "./client";
import { refusalOf, type UploadRequest, uploadFile } from "./uploads";

// The console's upload: one call, POST /v2/files?path=<name> with the file's bytes as the body, its progress from the
// request's upload events, and a refusal in the server's own words.
function fakeRequest(answer: { status: number; body?: unknown } | "network" | "never") {
  const seen: { method?: string; url?: string; opened: number; headers: Record<string, string>; body?: unknown; aborted: boolean } = { opened: 0, headers: {}, aborted: false };
  const xhr: UploadRequest = {
    status: 0, responseText: "",
    upload: { onprogress: null }, onload: null, onerror: null, onabort: null,
    open: ((method: string, url: string) => { seen.opened += 1; seen.method = method; seen.url = url; }) as UploadRequest["open"],
    setRequestHeader: (k: string, v: string) => { seen.headers[k.toLowerCase()] = v; },
    abort: () => { seen.aborted = true; xhr.onabort?.(); },
    send: ((body: unknown) => {
      seen.body = body;
      if (answer === "never") return;
      queueMicrotask(() => {
        if (answer === "network") return xhr.onerror?.();
        xhr.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
        (xhr as { status: number }).status = answer.status;
        (xhr as { responseText: string }).responseText = JSON.stringify(answer.body ?? null);
        xhr.onload?.();
      });
    }) as UploadRequest["send"],
  };
  return { xhr, seen };
}
const made = { file_id: "019a0000-0000-7000-8000-000000000001", path: "plan v2.md", size_bytes: 10, content_type: "text/markdown", sha256: "a".repeat(64), status: "ready" };

describe("uploadFile", () => {
  it("sends the file as the body to /v2/files?path=<its name>, reports progress, and resolves with the file made", async () => {
    // The server's whole answer: the file is ready, so its upload.url (from the server's root) is never followed.
    const upload = { method: "PUT", url: `/v2/files/${made.file_id}`, expires_at: "2026-11-04T01:00:00.000Z" };
    const { xhr, seen } = fakeRequest({ status: 201, body: { file: made, upload } });
    const file = new File(["0123456789"], "plan v2.md", { type: "text/markdown" });
    const progress: number[] = [];
    await expect(uploadFile(file, { request: () => xhr, onProgress: (f) => progress.push(f) })).resolves.toEqual(made);
    expect([seen.method, seen.url, seen.headers["content-type"], seen.body]).toEqual(["POST", "/v2/files?path=plan%20v2.md", "text/markdown", file]);
    expect(progress).toEqual([0.5, 1]);
    expect(seen.opened).toBe(1);
  });

  it("rejects with the server's refusal, in its words, and with the fields it names", async () => {
    const { xhr } = fakeRequest({ status: 413, body: { error: { code: "payload_too_large", message: "the body is over 52428800 bytes, this server's largest upload", retryable: false } } });
    const e = await uploadFile(new File(["x"], "big.bin"), { request: () => xhr }).catch((err) => err);
    expect(e).toBeInstanceOf(ClientError);
    expect([e.status, e.code, refusalOf(e)]).toEqual([413, "payload_too_large", "the body is over 52428800 bytes, this server's largest upload"]);
    const bad = fakeRequest({ status: 422, body: { error: { code: "invalid_request", message: "The request is invalid.", retryable: false, fields: [{ field: "path", reason: "invalid", message: "A path names a file, not a folder." }] } } });
    expect(refusalOf(await uploadFile(new File(["x"], "x"), { request: () => bad.xhr }).catch((err) => err))).toBe("The request is invalid. A path names a file, not a folder.");
  });

  it("says a send that never reached the server, and stops one whose signal aborts", async () => {
    const lost = fakeRequest("network");
    expect((await uploadFile(new File(["x"], "a.txt"), { request: () => lost.xhr }).catch((e) => e)).status).toBe(0);
    const slow = fakeRequest("never");
    const control = new AbortController();
    const sent = uploadFile(new File(["x"], "a.txt"), { request: () => slow.xhr, signal: control.signal }).catch((e) => e);
    control.abort();
    expect((await sent).code).toBe("aborted");
    expect(slow.seen.aborted).toBe(true);
  });
});
