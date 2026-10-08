// A driver over in-memory pages: the page operations the tools are built on, with no browser. It is bound to a
// backend's sessions by the connect URL's session id, so a session the provider ended is a session the driver cannot
// reach, and every call is listed in `backend.dispatched`. `fakeDriver` runs in the backend's process;
// `remoteDriver` is the child's face of `backend.serve()`, so the page and the dispatched rows live in the parent and
// outlive a SIGKILLed child.
import type { AttachTarget } from "../core/host.js";
import { type FakeBackend, FakeProviderError, type FakeScreenshotOptions, type FixturePage } from "./backend.js";

export type FakeDriver = {
  snapshot(): Promise<string>;
  /** A `goto` action moves the page; any other code returns what it was given. */
  run(input: { code?: string; actions?: Array<{ op: string; url?: string; [field: string]: unknown }> }): Promise<unknown>;
  /** The page's URL, without a `read` row (a screenshot receipt needs it; `page()` pulls the whole html). */
  url(): Promise<string>;
  /** An image whose header decodes to the viewport (or the full page) times the backend's device scale. */
  screenshot(options?: FakeScreenshotOptions): Promise<{ data: string; mimeType: string; width: number; height: number }>;
  page(): Promise<FixturePage>;
  close(): Promise<void>;
};

/** `(target) => driver`: the shape a host passes as the extension's driver factory in tests. */
export type FakeDriverFactory = (target: AttachTarget) => Promise<FakeDriver>;

type Face = Pick<FakeBackend["driverFace"], "connect" | "snapshot" | "run" | "url" | "screenshot" | "page" | "close">;

const bind = (face: Face, id: string): FakeDriver => ({
  snapshot: () => face.snapshot(id),
  run: (input) => face.run(id, input),
  url: () => face.url(id),
  screenshot: (options) => face.screenshot(id, options),
  page: () => face.page(id),
  close: () => face.close(id),
});

export function fakeDriver(b: FakeBackend): FakeDriverFactory {
  return async (target) => bind(b.driverFace, await b.driverFace.connect(target));
}

/** The driver factory a child process uses against `backend.serve()`. A held op never returns. */
export function remoteDriver(url: string): FakeDriverFactory {
  const rpc = async (method: string, args: unknown[]): Promise<any> => {
    const res = await fetch(`${url}/rpc/driver.${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string; status: number } };
    if (body.error) throw new FakeProviderError(body.error.message, body.error.status);
    return body.result;
  };
  const face: Face = {
    connect: (target) => rpc("connect", [target]),
    snapshot: (id) => rpc("snapshot", [id]),
    run: (id, input) => rpc("run", [id, input]),
    url: (id) => rpc("url", [id]),
    screenshot: (id, options) => rpc("screenshot", [id, options]),
    page: (id) => rpc("page", [id]),
    close: (id) => rpc("close", [id]),
  };
  return async (target) => bind(face, await face.connect(target));
}
