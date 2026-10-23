/** Chrome's answer to an evaluate sent with a document's context id after a navigation replaced it. Stagehand's extension
 *  relays it as a JSON-RPC error with this text, and the facade's code runs rebuild it as a plain Error with the same
 *  text and no cause. Matched by identity. */
export const CONTEXT_GONE = "-32000 Cannot find context with specified id";

const contextGone = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause as { code?: unknown; message?: unknown } | undefined;
  if (cause && typeof cause === "object") return typeof cause.code === "number" && cause.message === CONTEXT_GONE;
  return error.message === CONTEXT_GONE;
};

/** A read that lands in a document a navigation has just replaced waits for the new one, then reads once more. The
 *  wait's own failure is not the read's: the second read's answer, or its error, is what comes back. */
export async function readOnNewDocument<T>(read: () => Promise<T>, waitForDocument: () => Promise<unknown>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!contextGone(error)) throw error;
    await waitForDocument().catch(() => undefined);
    return await read();
  }
}

// A page's address is its document's (location.href): page.url() names a goto's target once Chrome starts it, so a
// receipt could cite a page it does not hold. One evaluate reads all four, so they are one document's.
const PAGE_CODE = `return await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText : "",
  html: document.documentElement ? document.documentElement.outerHTML : "",
}));`;

type Facade = { snapshot(options?: { includeIframes?: boolean }): Promise<string>; run(code: string): Promise<unknown> };

/** The driver's snapshot and page reads, each read once more on the new document when a navigation replaced its own. */
export function documentReads(facade: Facade, waitForDocument: () => Promise<unknown>) {
  return {
    snapshot: (options?: { includeIframes?: boolean }) => readOnNewDocument(() => facade.snapshot(options), waitForDocument),
    page: async () => await readOnNewDocument(() => facade.run(PAGE_CODE), waitForDocument) as { url: string; title: string; text: string; html: string },
  };
}
