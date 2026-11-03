// read-page.ts's worker: for `workerData` { html, url }, the page's title, links and markdown, posted once as
// { title, links, text }, or as { error } when the conversion threw (a page nested past the stack, say).
import { parentPort, workerData } from "node:worker_threads";
import { TextNode } from "node-html-parser";
import { markdownOf } from "./page-markdown.js";
import { PageScan } from "./page-scan.js";

const { html, url } = workerData as { html: string; url: string };
try {
  const scan = new PageScan(html, url, (text) => new TextNode(text).text, false);
  scan.step(Number.POSITIVE_INFINITY);
  const { title, links } = scan.result();
  parentPort!.postMessage({ title, links, text: markdownOf(html) });
} catch (error) {
  parentPort!.postMessage({ error: String((error as Error)?.message ?? error) });
}
