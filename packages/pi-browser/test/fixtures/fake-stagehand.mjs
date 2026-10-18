// A stand-in for a created Stagehand, for the driver's page tools: its page answers what a test gives it.

// A 1x1 PNG; what follows its end marker names which answer it was.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
export const png = (name) => new Uint8Array(Buffer.concat([PNG, Buffer.from(name)]));
export const nameOf = (bytes) => Buffer.from(bytes).subarray(PNG.length).toString();
export const TREE = { formattedTree: "[0-1] RootWebArea: T", xpathMap: { "0-1": "/html/body" } };

/** A call the browser has not answered: `answer` and `fail` settle it later, as a late reply would. */
export function unanswered() {
  let answer, fail;
  const reply = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
  return { reply, answer: (value) => answer(value), fail: (error) => fail(error) };
}

/** Each batch answers the next of `batches`, else the page's address; `onBatch` hears each one start. */
export function fakeStagehand({ url = "https://example.test/", snapshot = async () => TREE, screenshot = async () => png("fresh"), batches = [], onBatch = () => {} } = {}) {
  const page = { pageId: "page-1", url: async () => url, snapshot: (o) => snapshot(o), screenshot: (o) => screenshot(o) };
  return {
    browser: { context: { activePage: async () => page } },
    experimentalBatch: async () => { onBatch(); return batches.length ? batches.shift() : url; },
    close: async () => {},
  };
}
