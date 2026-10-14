import type { AttachTarget } from "../core/host.js";
import { type FakeBackend, FakeProviderError, type FakeScreenshotOptions, type FixturePage } from "./backend.js";

export type FakeDriver = {
  snapshot(): Promise<string>;
  /** A `goto` action moves the page; any other code returns what it was given. */
  run(input: { code?: string; actions?: Array<{ op: string; url?: string; [field: string]: unknown }> }): Promise<unknown>;
  /** The page's URL without a `read` row. */
  url(): Promise<string>;
  screenshot(options?: FakeScreenshotOptions): Promise<{ data: string; mimeType: string; width: number; height: number }>;
  page(): Promise<FixturePage>;
  close(): Promise<void>;
};

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

/** A held op never returns. */
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
